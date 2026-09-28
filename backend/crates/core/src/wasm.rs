//! wasm-bindgen bindings for the client kernel (SPEC §2, §4.2).
//!
//! **This is the whole client-side ABI of the shared core.** It exists so the
//! browser runs *the same* parser, title resolver and filter evaluator the server
//! runs — parity by construction, not by test suite. Three exported functions,
//! JSON in and out:
//!
//! | Export | Purpose |
//! |---|---|
//! | [`parse_document`] | frontmatter + `%%%` sections + title (SPEC §3.1, §3.4) |
//! | [`evaluate_filter`] | the filter DSL over one projection row (SPEC §4.2) |
//! | [`core_semantics_version`] | staleness check against the server's `welcome` |
//! | [`resolve_wiring`], [`plan_wiring`], [`wiring_candidates`], [`shape_fits`] | the plugin wiring resolver, for the wiring editor's previews (PLUGIN-PROTOCOLS §6) |
//!
//! **Filter *compilation* is deliberately absent.** Compiling to Mongo is the
//! server's job (SPEC §4.2) and needs `bson`, which the Wasm build does not have.
//!
//! JSON strings, not `JsValue` trees, are the boundary on purpose: one
//! `serde_json` shape both sides already speak, no `serde-wasm-bindgen`
//! dependency, and a wire format that is trivially loggable when a parity bug
//! shows up. The TypeScript side of this contract is
//! `web/kernel/src/wasm/core-wasm.d.ts` — the two must change together.
//!
//! Every function here is **total**: malformed input yields a defined result
//! (an empty parse, or `false`), never a panic and never a trap. A panicking
//! Wasm module poisons its instance, and a poisoned kernel is a blank app.

use wasm_bindgen::prelude::wasm_bindgen;

use crate::date::Date;
use crate::document::parse_document as parse_document_native;
use crate::filter::Filter;
use crate::filter::evaluator::{Row, evaluate};
use crate::value::{Map, Value};

/// Parse a document's text. Returns a JSON object:
/// `{ "title": string, "fm": object, "plugins": object, "fm_parse_error": bool }`.
///
/// Mirrors what the server materializes into the `documents` row (SPEC §3.5), so
/// the client can re-derive the projection of a document it edits offline without
/// waiting for the server's materialization to come back over the feed.
#[wasm_bindgen]
pub fn parse_document(text: &str) -> String {
    let parsed = parse_document_native(text);
    let json = serde_json::json!({
        "title": parsed.title,
        "fm": map_to_json(&parsed.fm),
        "plugins": map_to_json(&parsed.plugins),
        "fm_parse_error": parsed.fm_parse_error,
    });
    json.to_string()
}

/// Evaluate a filter-DSL expression against one projection row.
///
/// `filter_json` is the DSL wire form (`crates/core/README.md`); `doc_json` is
/// `{ id, title, content, fm, plugins, created_at?, updated_at?, deleted_at?, deleted }` with
/// RFC 3339 timestamps.
///
/// Returns `false` for an unparseable filter, an unparseable row, **and** for an
/// evaluation error — the DSL compares same types only (SPEC §4.2), and a
/// type-mismatched row is a row that does not match. That is exactly what the
/// server's Mongo compilation does with such a row, which is the equality the
/// conformance corpus pins.
#[wasm_bindgen]
pub fn evaluate_filter(filter_json: &str, doc_json: &str) -> bool {
    let Ok(filter) = Filter::from_json_str(filter_json) else {
        return false;
    };
    let Ok(document) = serde_json::from_str::<serde_json::Value>(doc_json) else {
        return false;
    };

    let id = str_field(&document, "id").unwrap_or_default();
    let title = str_field(&document, "title").unwrap_or_default();
    let content = str_field(&document, "content").unwrap_or_default();
    let fm = map_field(&document, "fm");
    let plugins = map_field(&document, "plugins");
    let created_at = date_field(&document, "created_at");
    let updated_at = date_field(&document, "updated_at");
    let deleted_at = date_field(&document, "deleted_at");
    let deleted = document
        .get("deleted")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let row = Row {
        id: &id,
        title: &title,
        content: &content,
        fm: &fm,
        plugins: &plugins,
        created_at: created_at.as_ref(),
        updated_at: updated_at.as_ref(),
        deleted_at: deleted_at.as_ref(),
        deleted,
    };

    evaluate(&filter, &row).unwrap_or(false)
}

/// [`crate::CORE_SEMANTICS_VERSION`] — compared against the server's `welcome`
/// (PROTOCOL.md §1.4). A mismatch means the client's Wasm core and the server's
/// native core could materialize differently, so the client stops trusting its
/// own parse and asks the user to reload.
#[wasm_bindgen]
pub fn core_semantics_version() -> u32 {
    crate::CORE_SEMANTICS_VERSION
}

/// Normalize an ISO-8601 date the way materialization does (SPEC §3.4), so a
/// client sorting by `fm.date` orders rows exactly as the server would. Returns
/// the input unchanged when it is not a date.
#[wasm_bindgen]
pub fn normalize_date(input: &str) -> String {
    Date::normalize_str(input)
}

/// Resolve the title of a document text (`fm.title` → first ATX heading → first
/// non-empty line → `"Untitled"`). A convenience for list rendering that avoids
/// a full [`parse_document`] round trip through JSON.
#[wasm_bindgen]
pub fn resolve_title(text: &str) -> String {
    parse_document_native(text).title
}

// ---------------------------------------------------------------------------
// JSON bridges (private: the exported ABI is the four functions above)
// ---------------------------------------------------------------------------

fn map_to_json(map: &Map) -> serde_json::Value {
    let mut object = serde_json::Map::with_capacity(map.len());
    for (key, value) in map {
        object.insert(key.clone(), value.to_json());
    }
    serde_json::Value::Object(object)
}

fn str_field(document: &serde_json::Value, key: &str) -> Option<String> {
    document
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

fn map_field(document: &serde_json::Value, key: &str) -> Map {
    match document.get(key) {
        Some(value @ serde_json::Value::Object(_)) => match Value::from_json(value) {
            Value::Map(map) => map,
            _ => Map::new(),
        },
        _ => Map::new(),
    }
}

fn date_field(document: &serde_json::Value, key: &str) -> Option<Date> {
    Date::parse(document.get(key)?.as_str()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_document_returns_the_projection_fields() {
        let json = parse_document("---\ntitle: Groceries\n---\n\n# Groceries\n");
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["title"], "Groceries");
        assert_eq!(value["fm"]["title"], "Groceries");
        assert_eq!(value["fm_parse_error"], false);
        assert!(value["plugins"].is_object());
    }

    #[test]
    fn parse_document_is_total_on_garbage() {
        let json = parse_document("---\n: : :\n---\n\x00\u{feff}");
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(value["title"].is_string());
    }

    #[test]
    fn evaluate_filter_matches_a_frontmatter_value() {
        let filter = r#"{"cmp":{"field":"fm.status","op":"eq","value":{"str":"open"}}}"#;
        let document = r#"{"id":"01J8Z","title":"t","content":"","fm":{"status":"open"},
                           "plugins":{},"deleted":false}"#;
        assert!(evaluate_filter(filter, document));
    }

    #[test]
    fn evaluate_filter_is_false_on_bad_input() {
        assert!(!evaluate_filter("not json", "{}"));
        assert!(!evaluate_filter(r#""all""#, "not json"));
    }

    #[test]
    fn evaluate_filter_accepts_all() {
        let document = r#"{"id":"1","title":"","content":"","fm":{},"plugins":{},"deleted":false}"#;
        assert!(evaluate_filter(r#""all""#, document));
    }

    #[test]
    fn semantics_version_is_reported() {
        assert_eq!(core_semantics_version(), crate::CORE_SEMANTICS_VERSION);
    }
}

// ---------------------------------------------------------------------------
// Plugin wiring (PLUGIN-PROTOCOLS §6). The server resolves natively and ships the result,
// so boot never needs these; the wiring editor calls them to preview a draft.
// ---------------------------------------------------------------------------

fn error_json(message: impl std::fmt::Display) -> String {
    serde_json::json!({ "error": message.to_string() }).to_string()
}

/// `ResolveInput` JSON → `Resolution` JSON, or `{ "error": … }` for input that does not parse.
#[wasm_bindgen]
pub fn resolve_wiring(input_json: &str) -> String {
    match serde_json::from_str::<crate::wiring::ResolveInput>(input_json) {
        Ok(input) => {
            serde_json::to_string(&crate::wiring::resolve(&input)).unwrap_or_else(error_json)
        }
        Err(err) => error_json(err),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanRequest {
    before: crate::wiring::Resolution,
    after: crate::wiring::Resolution,
    #[serde(default)]
    before_wiring: crate::wiring::Wiring,
    #[serde(default)]
    after_wiring: crate::wiring::Wiring,
    #[serde(default)]
    hot: Vec<String>,
}

/// `{ before, after, beforeWiring, afterWiring, hot }` → `ApplyPlan` JSON.
#[wasm_bindgen]
pub fn plan_wiring(request_json: &str) -> String {
    match serde_json::from_str::<PlanRequest>(request_json) {
        Ok(request) => {
            let hot = request.hot.into_iter().collect();
            let plan = crate::wiring::plan(
                &request.before,
                &request.after,
                &request.before_wiring,
                &request.after_wiring,
                &hot,
            );
            serde_json::to_string(&plan).unwrap_or_else(error_json)
        }
        Err(err) => error_json(err),
    }
}

/// Every port on the other side of `port` that shares its protocol or fits its shape.
/// `dir` is `"in"` for a consumed port, `"out"` for a provided one. JSON array.
#[wasm_bindgen]
pub fn wiring_candidates(input_json: &str, port: &str, dir: &str) -> String {
    match serde_json::from_str::<crate::wiring::ResolveInput>(input_json) {
        Ok(input) => serde_json::to_string(&crate::wiring::candidates(&input, port, dir))
            .unwrap_or_else(error_json),
        Err(err) => error_json(err),
    }
}

/// Why offering shape `offer` where `need` is required fails: a JSON array of reasons,
/// empty when it fits (§6b).
#[wasm_bindgen]
pub fn shape_fits(offer_json: &str, need_json: &str) -> String {
    let parsed = serde_json::from_str::<crate::wiring::Shape>(offer_json).and_then(|offer| {
        serde_json::from_str::<crate::wiring::Shape>(need_json).map(|need| (offer, need))
    });
    match parsed {
        Ok((offer, need)) => {
            serde_json::to_string(&crate::wiring::fits(&offer, &need)).unwrap_or_else(error_json)
        }
        Err(err) => error_json(err),
    }
}

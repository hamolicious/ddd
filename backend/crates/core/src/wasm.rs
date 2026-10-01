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
//! | [`QueryEngine`] | the query engine (`crate::query`): rows in, plans answered |
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
use crate::filter::evaluator::evaluate;
use crate::query::{Doc, Engine, Plan};
use crate::value::Map;

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
    let Ok(mut document) = serde_json::from_str::<serde_json::Value>(doc_json) else {
        return false;
    };
    // An id-less row still evaluates, as the empty id.
    if let Some(object) = document.as_object_mut() {
        object
            .entry("id")
            .or_insert_with(|| serde_json::Value::String(String::new()));
    }
    let Some(doc) = Doc::from_json(&document) else {
        return false;
    };
    evaluate(&filter, &doc.row()).unwrap_or(false)
}

/// The query engine (`crate::query`), for the browser's search worker: the same
/// filter, text ranking, folder relations and sort the server answers with.
///
/// JSON in and out, like the rest of this ABI. Total: a malformed row is skipped, a
/// malformed or refused plan is an `{"error": …}` answer, never a trap.
#[wasm_bindgen]
pub struct QueryEngine {
    inner: Engine,
}

impl Default for QueryEngine {
    fn default() -> QueryEngine {
        QueryEngine::new()
    }
}

#[wasm_bindgen]
impl QueryEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> QueryEngine {
        QueryEngine {
            inner: Engine::new(),
        }
    }

    /// An engine saved with [`QueryEngine::to_json`]; `undefined` when it cannot be
    /// read (another index version): rebuild from the rows instead.
    pub fn load(json: &str) -> Option<QueryEngine> {
        Engine::from_json_str(json).map(|inner| QueryEngine { inner })
    }

    /// Add or replace projection rows (a JSON array); a row with `purged: true` is
    /// taken out. Returns how many rows were read.
    pub fn upsert(&mut self, rows_json: &str) -> u32 {
        let Ok(serde_json::Value::Array(rows)) =
            serde_json::from_str::<serde_json::Value>(rows_json)
        else {
            return 0;
        };
        let mut read = 0;
        for row in &rows {
            if row.get("purged").and_then(serde_json::Value::as_bool) == Some(true) {
                if let Some(id) = row.get("id").and_then(serde_json::Value::as_str) {
                    self.inner.remove(id);
                    read += 1;
                }
                continue;
            }
            if let Some(doc) = Doc::from_json(row) {
                self.inner.upsert(doc);
                read += 1;
            }
        }
        read
    }

    /// Take documents out (a JSON array of ids).
    pub fn remove(&mut self, ids_json: &str) {
        if let Ok(ids) = serde_json::from_str::<Vec<String>>(ids_json) {
            for id in ids {
                self.inner.remove(&id);
            }
        }
    }

    /// Answer a plan (`crates/core/README.md` §6): `{"page": {ids, total, next_cursor?,
    /// hits}}`, or `{"error": "…"}` for a plan that is malformed or refused.
    pub fn run(&self, plan_json: &str) -> String {
        let answer = Plan::from_json_str(plan_json)
            .map_err(|err| err.to_string())
            .and_then(|plan| {
                self.inner
                    .run(&plan)
                    .map(|answer| answer.page())
                    .map_err(|err| err.to_string())
            });
        match answer {
            Ok(page) => serde_json::json!({ "page": page }).to_string(),
            Err(error) => serde_json::json!({ "error": error }).to_string(),
        }
    }

    /// The engine, saved, for [`QueryEngine::load`].
    pub fn to_json(&self) -> String {
        self.inner.to_json_string()
    }

    /// Documents held.
    pub fn len(&self) -> u32 {
        self.inner.len() as u32
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }
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
// JSON bridges (private)
// ---------------------------------------------------------------------------

fn map_to_json(map: &Map) -> serde_json::Value {
    let mut object = serde_json::Map::with_capacity(map.len());
    for (key, value) in map {
        object.insert(key.clone(), value.to_json());
    }
    serde_json::Value::Object(object)
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

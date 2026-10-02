use wasm_bindgen::prelude::wasm_bindgen;

use crate::date::Date;
use crate::document::parse_document as parse_document_native;
use crate::filter::Filter;
use crate::filter::evaluator::evaluate;
use crate::query::{Doc, Engine, Plan};
use crate::value::Map;

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

#[wasm_bindgen]
pub fn evaluate_filter(filter_json: &str, doc_json: &str) -> bool {
    let Ok(filter) = Filter::from_json_str(filter_json) else {
        return false;
    };
    let Ok(mut document) = serde_json::from_str::<serde_json::Value>(doc_json) else {
        return false;
    };
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

    pub fn load(json: &str) -> Option<QueryEngine> {
        Engine::from_json_str(json).map(|inner| QueryEngine { inner })
    }

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

    pub fn remove(&mut self, ids_json: &str) {
        if let Ok(ids) = serde_json::from_str::<Vec<String>>(ids_json) {
            for id in ids {
                self.inner.remove(&id);
            }
        }
    }

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

    pub fn to_json(&self) -> String {
        self.inner.to_json_string()
    }

    pub fn len(&self) -> u32 {
        self.inner.len() as u32
    }

    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }
}

#[wasm_bindgen]
pub fn core_semantics_version() -> u32 {
    crate::CORE_SEMANTICS_VERSION
}

#[wasm_bindgen]
pub fn normalize_date(input: &str) -> String {
    Date::normalize_str(input)
}

#[wasm_bindgen]
pub fn resolve_title(text: &str) -> String {
    parse_document_native(text).title
}

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

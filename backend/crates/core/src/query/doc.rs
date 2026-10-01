//! The owned projection row the engine keeps: what [`Row`] borrows from.

use serde::{Deserialize, Serialize};

use crate::date::Date;
use crate::filter::Row;
use crate::value::{Map, Value};

/// One document's projection row (SPEC §4.1), owned.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Doc {
    pub id: String,
    pub title: String,
    /// Materialized full text, `%%%` sections included. Empty when the row came
    /// without it (a metadata-only read).
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub fm: Map,
    #[serde(default)]
    pub plugins: Map,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<Date>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<Date>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<Date>,
    #[serde(default)]
    pub deleted: bool,
}

impl Doc {
    /// The borrowed view the filter evaluator reads.
    pub fn row(&self) -> Row<'_> {
        Row {
            id: &self.id,
            title: &self.title,
            content: &self.content,
            fm: &self.fm,
            plugins: &self.plugins,
            created_at: self.created_at.as_ref(),
            updated_at: self.updated_at.as_ref(),
            deleted_at: self.deleted_at.as_ref(),
            deleted: self.deleted,
        }
    }

    /// A projection row as JSON (`{ id, title, content?, fm, plugins, created_at?, … }`,
    /// RFC 3339 timestamps), tolerantly: an unparseable date is absent, a field of the
    /// wrong shape is empty. `None` only without an `id`.
    pub fn from_json(document: &serde_json::Value) -> Option<Doc> {
        let id = str_field(document, "id")?;
        Some(Doc {
            id,
            title: str_field(document, "title").unwrap_or_default(),
            content: str_field(document, "content").unwrap_or_default(),
            fm: map_field(document, "fm"),
            plugins: map_field(document, "plugins"),
            created_at: date_field(document, "created_at"),
            updated_at: date_field(document, "updated_at"),
            deleted_at: date_field(document, "deleted_at"),
            deleted: document
                .get("deleted")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        })
    }
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

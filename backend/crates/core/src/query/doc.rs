use serde::{Deserialize, Serialize};

use crate::date::Date;
use crate::filter::Row;
use crate::value::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Doc {
    pub id: String,
    pub title: String,
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

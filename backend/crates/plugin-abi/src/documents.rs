use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::JsonMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentValue {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default)]
    pub fm: JsonMap,
    #[serde(default)]
    pub plugins: JsonMap,
    pub fm_parse_error: bool,
    pub materialized_version: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
    #[serde(default)]
    pub deleted: bool,
}

impl DocumentValue {
    pub fn is_owned_by(&self, plugin_id: &str) -> bool {
        self.created_by
            .as_deref()
            .is_some_and(|by| by.strip_prefix("plugin:") == Some(plugin_id))
    }

    pub fn section(&self, plugin_id: &str) -> Option<&serde_json::Map<String, Value>> {
        self.plugins.get(plugin_id).and_then(Value::as_object)
    }

    pub fn section_value(&self, plugin_id: &str, key: &str) -> Option<&Value> {
        self.section(plugin_id).and_then(|section| section.get(key))
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrashScope {
    #[default]
    Live,
    Trashed,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetDocumentInput {
    pub id: String,
    #[serde(default)]
    pub metadata_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetDocumentOutput {
    pub document: DocumentValue,
}

pub type FilterJson = Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QueryDocumentsInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<FilterJson>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sort: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default)]
    pub trash: TrashScope,
    #[serde(default)]
    pub metadata_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryDocumentsOutput {
    pub documents: Vec<DocumentValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryInput {
    pub plan: Value,
    #[serde(default)]
    pub metadata_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryOutput {
    pub documents: Vec<DocumentValue>,
    pub total: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub hits: std::collections::BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDocumentInput {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteDocumentOutput {
    pub id: String,
    pub title: String,
    pub materialized_version: String,
    #[serde(default = "crate::documents::default_true")]
    pub changed: bool,
}

pub(crate) fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionEdit {
    pub key: String,
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub value: Option<Value>,
    #[serde(default)]
    pub remove: bool,
}

fn deserialize_present<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpliceSectionInput {
    pub id: String,
    pub edits: Vec<SectionEdit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpliceSectionOutput {
    pub id: String,
    pub materialized_version: String,
    pub edits_applied: u32,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewriteDocumentInput {
    pub id: String,
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ownership_is_read_off_created_by() {
        let mut doc = DocumentValue {
            id: "01J".into(),
            title: "Standup".into(),
            content: None,
            fm: JsonMap::new(),
            plugins: JsonMap::new(),
            fm_parse_error: false,
            materialized_version: "v".into(),
            created_at: "2026-09-24T06:00:00Z".into(),
            created_by: Some("plugin:calendar".into()),
            updated_at: "2026-09-24T06:00:00Z".into(),
            updated_by: None,
            deleted: false,
        };
        assert!(doc.is_owned_by("calendar"));
        assert!(!doc.is_owned_by("agenda"));

        doc.created_by = Some("01HUSERID".into());
        assert!(!doc.is_owned_by("calendar"));
        doc.created_by = None;
        assert!(!doc.is_owned_by("calendar"));
    }

    #[test]
    fn a_section_edit_distinguishes_null_from_removal() {
        let set_null = SectionEdit {
            key: "source_uid".into(),
            value: Some(Value::Null),
            remove: false,
        };
        let removed = SectionEdit {
            key: "source_uid".into(),
            value: None,
            remove: true,
        };
        assert_eq!(
            serde_json::to_string(&set_null).unwrap(),
            r#"{"key":"source_uid","value":null,"remove":false}"#
        );
        assert_eq!(
            serde_json::to_string(&removed).unwrap(),
            r#"{"key":"source_uid","remove":true}"#
        );
    }

    #[test]
    fn a_section_edit_reads_back_the_null_it_wrote() {
        let wire = r#"{"key":"source_uid","value":null,"remove":false}"#;
        let parsed: SectionEdit = serde_json::from_str(wire).unwrap();
        assert_eq!(
            parsed.value,
            Some(Value::Null),
            "a present `null` is the YAML null scalar, not an omission"
        );
        assert!(!parsed.remove);
        assert_eq!(serde_json::to_string(&parsed).unwrap(), wire);

        let removal: SectionEdit = serde_json::from_str(r#"{"key":"k","remove":true}"#).unwrap();
        assert_eq!(removal.value, None);
        assert!(removal.remove);

        let neither: SectionEdit = serde_json::from_str(r#"{"key":"k"}"#).unwrap();
        assert_eq!(neither.value, None);
        assert!(!neither.remove);

        let scalar: SectionEdit = serde_json::from_str(r#"{"key":"k","value":"v"}"#).unwrap();
        assert_eq!(scalar.value, Some(Value::String("v".into())));
    }

    #[test]
    fn a_query_defaults_to_live_documents() {
        let input: QueryDocumentsInput = serde_json::from_str("{}").unwrap();
        assert_eq!(input.trash, TrashScope::Live);
        assert!(input.filter.is_none());
    }
}

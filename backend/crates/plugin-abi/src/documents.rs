//! The document host functions: `get_document`, `query_documents`, `create_document`,
//! `splice_section`, `rewrite_document`.
//!
//! **A document is text** (SPEC §2). `content` is the whole string — frontmatter, body
//! and `%%%` sections — and `fm`/`plugins` are the materialized views of it the server
//! already keeps. A plugin never gets a pre-stripped body, and never sends one.
//!
//! **Three write primitives, three different rights** (SPEC §3.3):
//!
//! | Primitive | Writes | Right |
//! |---|---|---|
//! | [`SpliceSectionInput`] | line splices inside the **caller's own** `%%%` section | `documents:write` |
//! | [`CreateDocumentInput`] | a whole new document, owned by the caller | `documents:write` |
//! | [`RewriteDocumentInput`] | the whole text of a document **the caller created** | `documents:write` + ownership |
//!
//! There is deliberately no way for a plugin to rewrite a human's document, and no way
//! to touch another plugin's section. Both are text-level primitives on one CRDT string,
//! so "whole-document rewrite" is safe only where the document has no human author.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::JsonMap;

/// One document, as the host hands it over.
///
/// Field names are the *stored* projection names (`fm_parse_error`, `created_at`), not a
/// camelCase re-spelling: a plugin filtering on `fm.date` and a plugin reading
/// `row.fm_parse_error` should be using one vocabulary, and that vocabulary is the one in
/// SPEC §3.5 and in the REST responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentValue {
    pub id: String,
    pub title: String,
    /// The whole materialized text. Absent when the request set `metadata_only`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Materialized frontmatter (the shared-core value model as plain JSON).
    #[serde(default)]
    pub fm: JsonMap,
    /// Materialized `%%%` sections, keyed by plugin id.
    #[serde(default)]
    pub plugins: JsonMap,
    pub fm_parse_error: bool,
    pub materialized_version: String,
    /// RFC 3339 UTC.
    pub created_at: String,
    /// `Actor::as_stored()`: a user id, `plugin:<id>`, or `system`. **This is the
    /// machine-ownership record** — `rewrite_document` succeeds only when it equals
    /// `plugin:<caller>` (SPEC §3.3, machine-owned documents).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    pub updated_at: String,
    /// The last applier the server saw, not the author (SPEC §3.5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
    /// `true` ⇒ tombstoned (in Trash), still readable.
    #[serde(default)]
    pub deleted: bool,
}

impl DocumentValue {
    /// `true` when this document was created by `plugin_id` and is therefore that
    /// plugin's to rewrite wholesale.
    pub fn is_owned_by(&self, plugin_id: &str) -> bool {
        self.created_by
            .as_deref()
            .is_some_and(|by| by.strip_prefix("plugin:") == Some(plugin_id))
    }

    /// One plugin's `%%%` section, materialized. `None` when the document has no such
    /// section (or it parsed to something other than a mapping).
    pub fn section(&self, plugin_id: &str) -> Option<&serde_json::Map<String, Value>> {
        self.plugins.get(plugin_id).and_then(Value::as_object)
    }

    /// One key of one section, materialized.
    pub fn section_value(&self, plugin_id: &str, key: &str) -> Option<&Value> {
        self.section(plugin_id).and_then(|section| section.get(key))
    }
}

/// Which slice of the workspace a query sees (mirrors `docstore::TrashFilter`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrashScope {
    /// Live documents only. The default: a plugin that forgets this does not resurrect
    /// deleted events.
    #[default]
    Live,
    Trashed,
    All,
}

// ---------------------------------------------------------------------------
// get_document
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetDocumentInput {
    pub id: String,
    /// Omit `content` from the answer — the cheap read for a cron job that only needs
    /// `fm` or its own section over thousands of documents.
    #[serde(default)]
    pub metadata_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetDocumentOutput {
    pub document: DocumentValue,
}

// ---------------------------------------------------------------------------
// query_documents
// ---------------------------------------------------------------------------

/// The filter DSL (SPEC §4.2) — **ours, not Mongo's** — passed through as JSON and
/// parsed by the shared core on the host. Invalid filters are
/// [`crate::ErrorCode::InvalidArgument`], never a silent full scan.
pub type FilterJson = Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QueryDocumentsInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<FilterJson>,
    /// Sort keys in the REST spelling: `"fm.date"`, `"-fm.date"`, `"title:desc"`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sort: Vec<String>,
    /// Full-text search, same engine as `GET /api/documents?search=`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    /// Clamped to [`crate::limits::MAX_QUERY_LIMIT`]; absent ⇒
    /// [`crate::limits::DEFAULT_QUERY_LIMIT`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Opaque, from a previous [`QueryDocumentsOutput::next_cursor`].
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
    /// `Some` ⇒ there is another page. Paging is mandatory for a plugin that intends to
    /// see a whole workspace; there is no unbounded read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

// ---------------------------------------------------------------------------
// create_document
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDocumentInput {
    /// The whole document text, frontmatter included. A machine-owned document is
    /// authored wholesale by its owner (SPEC §3.3).
    pub text: String,
    /// Optional ULID, so a retry after a timeout is idempotent: the second attempt gets
    /// [`crate::ErrorCode::AlreadyExists`] instead of creating a duplicate event. A
    /// graveyarded id is [`crate::ErrorCode::Gone`] and must never be retried.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteDocumentOutput {
    pub id: String,
    pub title: String,
    pub materialized_version: String,
    /// `false` when the write was a no-op (a splice whose keys already had those
    /// values). A plugin can use it to avoid emitting a pointless event.
    #[serde(default = "crate::documents::default_true")]
    pub changed: bool,
}

pub(crate) fn default_true() -> bool {
    true
}

// ---------------------------------------------------------------------------
// splice_section
// ---------------------------------------------------------------------------

/// One line edit in the caller's `%%%` section.
///
/// `remove` and `value` are separate on purpose: `{"key":"k","value":null}` writes the
/// YAML line `k: null`, while `{"key":"k","remove":true}` deletes the line. Collapsing
/// them onto one nullable field is how a plugin ends up unable to store a null.
///
/// **`value` therefore needs [`deserialize_present`], not plain `Option`.** serde maps a
/// JSON `null` onto `Option<T>` as `None`, which is the same thing an *absent* field
/// produces — so the wire form this doc comment specifies for "write a literal null"
/// deserialized to "no value at all" and the host refused it as
/// [`crate::ErrorCode::InvalidArgument`]. A backend plugin could not write a null into its
/// own section at all, while serialization (and the test beside it) looked right, because
/// only one direction was ever exercised. The three states on the wire are *absent*
/// (`None`), *present and null* (`Some(Value::Null)`) and *present with a value*
/// (`Some(_)`), and the host's `section_edits` distinguishes all three.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionEdit {
    /// `^[A-Za-z0-9_-]{1,64}$` (`core::limits::is_valid_key`).
    pub key: String,
    /// A scalar or a flow sequence — the strict YAML subset of SPEC §3.4, serialized by
    /// the shared core's `to_yaml_inline`. Nested maps are not representable in a
    /// one-key-per-line section and are [`crate::ErrorCode::InvalidArgument`].
    ///
    /// `null` here is a *value* (the YAML `null` scalar), not an omission; see the type's
    /// doc comment.
    #[serde(
        default,
        deserialize_with = "deserialize_present",
        skip_serializing_if = "Option::is_none"
    )]
    pub value: Option<Value>,
    /// Delete the key's line.
    #[serde(default)]
    pub remove: bool,
}

/// `Some(value)` for any field that is **present**, `null` included.
///
/// The counterpart to `#[serde(default)]`: absence is answered by the default (`None`) and
/// never reaches this function, so everything that does get here was written by the caller
/// and is `Some`. Without it `Option<Value>` folds "not sent" and "sent as null" together,
/// and a distinction the wire format has is one the type cannot read back.
fn deserialize_present<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpliceSectionInput {
    pub id: String,
    /// Applied as one CRDT transaction, in order. An empty list is a no-op, not an error.
    pub edits: Vec<SectionEdit>,
}

/// **The section is always the caller's own.** SPEC §6.3 spells the host function
/// `splice_section(id, plugin_id, yaml_line_edits)`; the host supplies `plugin_id` from
/// the calling instance, so it is not on the wire — a plugin that could name the section
/// could write into another plugin's machine data, which is exactly the boundary the
/// per-plugin section exists to draw. Documented as a deliberate deviation in
/// `backend/HOST-ABI.md`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpliceSectionOutput {
    pub id: String,
    pub materialized_version: String,
    /// Lines actually written (an edit that matched the existing line writes nothing).
    pub edits_applied: u32,
    pub changed: bool,
}

// ---------------------------------------------------------------------------
// rewrite_document
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RewriteDocumentInput {
    pub id: String,
    /// The whole new text. Applied as one CRDT transaction against the live document, so
    /// a concurrent human edit merges rather than being lost — but a human editing a
    /// machine-owned document is outside the design, and the diff is what it is.
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

        // A human's document is nobody's to rewrite.
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

    /// The direction the test above did not cover, and the one the host actually runs.
    ///
    /// Serialization was asserted and deserialization was assumed, so `{"value":null}`
    /// came back as `None` — indistinguishable from an absent `value` — and
    /// `pluginhost::host_fns::section_edits` refused it with "has no `value` and is not a
    /// `remove`". Every byte on the wire was right; only the type reading it back was
    /// lossy, which is exactly the shape a one-directional test cannot see.
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

        // Absent stays absent: `#[serde(default)]` answers it before the deserializer runs.
        let removal: SectionEdit = serde_json::from_str(r#"{"key":"k","remove":true}"#).unwrap();
        assert_eq!(removal.value, None);
        assert!(removal.remove);

        // And neither: still `None`, so the host can go on refusing an edit that says
        // nothing rather than guessing which of the two it meant.
        let neither: SectionEdit = serde_json::from_str(r#"{"key":"k"}"#).unwrap();
        assert_eq!(neither.value, None);
        assert!(!neither.remove);

        // A real value round-trips unchanged, which is what stops the fix above from
        // being "everything is now Some".
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

//! A query as data: what [`super::Query`] builds and [`super::Engine::run`] answers.
//!
//! One JSON shape for every caller — the browser's worker, `POST /api/query`, a
//! backend plugin's host call, a saved-search note — so a query built in one place
//! runs unchanged in any other.
//!
//! ```json
//! { "text": "milk",
//!   "filter": {"and": [{"cmp": {"field": "fm.status", "op": "eq", "value": {"str": "open"}}},
//!                      {"child_of": {"of": "01J…", "deep": true}}]},
//!   "sort": ["relevance", "-updated_at"],
//!   "trash": "live", "limit": 50, "cursor": "…", "snippets": true }
//! ```
//!
//! Every field is optional; `{}` is "every live document, last updated first".

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::filter::{FieldPath, Filter, FilterParseError, SortKey, SortOrder};

/// Rows per page when a plan names no `limit`.
pub const DEFAULT_LIMIT: u32 = 50;
/// The largest page a plan may ask for.
pub const MAX_LIMIT: u32 = 1000;
/// Longest accepted search text, in bytes.
pub const MAX_TEXT_BYTES: usize = 1024;
/// Most sort keys in one plan.
pub const MAX_SORT_KEYS: usize = 8;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    /// Ranked full-text search. Empty: no text, every document is a candidate.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    /// The filter DSL (`crates/core/README.md` §4), relation nodes included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Filter>,
    /// Applied in order, then `id` ascending. Empty: best match while there is text,
    /// else last updated first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sort: Vec<Sort>,
    #[serde(default, skip_serializing_if = "Trash::is_default")]
    pub trash: Trash,
    /// Rows per page; [`DEFAULT_LIMIT`] when absent, at most [`MAX_LIMIT`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Opaque, from a previous answer's `next_cursor`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Each text hit carries the content line it matched on.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub snippets: bool,
}

/// Which documents a plan sees.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Trash {
    #[default]
    Live,
    Trashed,
    All,
}

impl Trash {
    fn is_default(&self) -> bool {
        *self == Trash::Live
    }

    pub(crate) fn admits(self, deleted: bool) -> bool {
        match self {
            Trash::Live => !deleted,
            Trash::Trashed => deleted,
            Trash::All => true,
        }
    }
}

/// One sort key. On the wire, the REST spelling: `"fm.date"`, `"-updated_at"`,
/// `"title:desc"`, or `"relevance"` (the text's ranking; ignored without text).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub enum Sort {
    Relevance,
    Field(SortKey),
}

impl Sort {
    pub fn parse(input: &str) -> Result<Sort, FilterParseError> {
        if input.trim() == "relevance" {
            return Ok(Sort::Relevance);
        }
        SortKey::parse(input).map(Sort::Field)
    }

    pub fn field(path: &str, order: SortOrder) -> Result<Sort, FilterParseError> {
        Ok(Sort::Field(SortKey {
            field: FieldPath::parse(path)?,
            order,
        }))
    }
}

impl TryFrom<String> for Sort {
    type Error = FilterParseError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Sort::parse(&value)
    }
}

impl From<Sort> for String {
    fn from(value: Sort) -> Self {
        match value {
            Sort::Relevance => "relevance".to_string(),
            Sort::Field(key) => match key.order {
                SortOrder::Asc => key.field.as_dotted(),
                SortOrder::Desc => format!("-{}", key.field.as_dotted()),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PlanError {
    #[error("malformed query plan: {0}")]
    Json(String),
    #[error(transparent)]
    Filter(#[from] FilterParseError),
    #[error("search text is longer than {MAX_TEXT_BYTES} bytes")]
    TextTooLong,
    #[error("more than {MAX_SORT_KEYS} sort keys")]
    TooManySortKeys,
    #[error("limit must be between 1 and {MAX_LIMIT}")]
    BadLimit,
    #[error("the cursor is not from this query")]
    BadCursor,
}

impl Plan {
    /// Parse and validate the JSON wire form.
    pub fn from_json_str(input: &str) -> Result<Plan, PlanError> {
        let plan: Plan = serde_json::from_str(input).map_err(|e| PlanError::Json(e.to_string()))?;
        plan.validate()?;
        Ok(plan)
    }

    /// Parse and validate an already-decoded JSON value.
    pub fn from_json(value: &serde_json::Value) -> Result<Plan, PlanError> {
        let plan: Plan =
            serde_json::from_value(value.clone()).map_err(|e| PlanError::Json(e.to_string()))?;
        plan.validate()?;
        Ok(plan)
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }

    pub fn validate(&self) -> Result<(), PlanError> {
        if self.text.len() > MAX_TEXT_BYTES {
            return Err(PlanError::TextTooLong);
        }
        if self.sort.len() > MAX_SORT_KEYS {
            return Err(PlanError::TooManySortKeys);
        }
        if let Some(limit) = self.limit
            && !(1..=MAX_LIMIT).contains(&limit)
        {
            return Err(PlanError::BadLimit);
        }
        if let Some(filter) = &self.filter {
            filter.validate()?;
        }
        Ok(())
    }

    /// The page size this plan asks for.
    pub fn page_size(&self) -> usize {
        self.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize
    }

    /// What a cursor is bound to: the plan without its paging. A cursor from one query
    /// handed to another is refused rather than silently paging the wrong list.
    pub(crate) fn fingerprint(&self) -> u64 {
        let unpaged = Plan {
            cursor: None,
            limit: None,
            snippets: false,
            ..self.clone()
        };
        fnv1a(unpaged.to_json().to_string().as_bytes())
    }
}

/// FNV-1a: tiny, deterministic on both targets, and only ever a fingerprint.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// `<offset>.<fingerprint>`, both hex.
pub(crate) fn encode_cursor(offset: usize, fingerprint: u64) -> String {
    format!("{offset:x}.{fingerprint:x}")
}

pub(crate) fn decode_cursor(cursor: &str, fingerprint: u64) -> Result<usize, PlanError> {
    let (offset, print) = cursor.split_once('.').ok_or(PlanError::BadCursor)?;
    let offset = usize::from_str_radix(offset, 16).map_err(|_| PlanError::BadCursor)?;
    let print = u64::from_str_radix(print, 16).map_err(|_| PlanError::BadCursor)?;
    if print != fingerprint {
        return Err(PlanError::BadCursor);
    }
    Ok(offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_object_is_the_default_plan() {
        let plan = Plan::from_json_str("{}").unwrap();
        assert_eq!(plan, Plan::default());
        assert_eq!(plan.to_json(), serde_json::json!({}));
    }

    #[test]
    fn sorts_use_the_rest_spelling() {
        let plan =
            Plan::from_json_str(r#"{"sort":["relevance","-updated_at","fm.key","title:desc"]}"#)
                .unwrap();
        assert_eq!(plan.sort[0], Sort::Relevance);
        assert_eq!(
            plan.to_json()["sort"],
            serde_json::json!(["relevance", "-updated_at", "fm.key", "-title"])
        );
    }

    #[test]
    fn bad_plans_are_refused() {
        assert!(matches!(
            Plan::from_json_str(r#"{"limit":0}"#),
            Err(PlanError::BadLimit)
        ));
        assert!(matches!(
            Plan::from_json_str(r#"{"sort":["nope"]}"#),
            Err(PlanError::Json(_))
        ));
        assert!(matches!(
            Plan::from_json_str(r#"{"bogus":1}"#),
            Err(PlanError::Json(_))
        ));
        let long = format!(r#"{{"text":"{}"}}"#, "a".repeat(MAX_TEXT_BYTES + 1));
        assert!(matches!(
            Plan::from_json_str(&long),
            Err(PlanError::TextTooLong)
        ));
    }

    #[test]
    fn a_cursor_is_bound_to_its_query() {
        let plan = Plan {
            text: "milk".into(),
            ..Plan::default()
        };
        let cursor = encode_cursor(50, plan.fingerprint());
        assert_eq!(decode_cursor(&cursor, plan.fingerprint()), Ok(50));
        let other = Plan {
            text: "bread".into(),
            ..Plan::default()
        };
        assert_eq!(
            decode_cursor(&cursor, other.fingerprint()),
            Err(PlanError::BadCursor)
        );
        let paged = Plan {
            limit: Some(10),
            cursor: Some(cursor.clone()),
            ..plan.clone()
        };
        assert_eq!(paged.fingerprint(), plan.fingerprint());
    }
}

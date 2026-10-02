use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::date::Date;
use crate::limits::{MAX_NESTING_DEPTH, is_valid_key};
use crate::value::ValueType;

pub(crate) const FIXED_ROOTS: [&str; 7] = [
    "id",
    "title",
    "content",
    "created_at",
    "updated_at",
    "deleted_at",
    "deleted",
];
pub(crate) const DYNAMIC_ROOTS: [&str; 2] = ["fm", "plugins"];
const MAX_PATH_SEGMENTS: usize = MAX_NESTING_DEPTH + 2;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct FieldPath(Vec<String>);

impl FieldPath {
    pub fn parse(input: &str) -> Result<FieldPath, FilterParseError> {
        let segments: Vec<&str> = input.split('.').collect();
        let root = segments[0];
        if segments.iter().any(|segment| segment.is_empty()) {
            return Err(FilterParseError::InvalidFieldPath(input.to_string()));
        }
        if FIXED_ROOTS.contains(&root) {
            if segments.len() != 1 {
                return Err(FilterParseError::InvalidFieldPath(input.to_string()));
            }
        } else if DYNAMIC_ROOTS.contains(&root) {
            if segments.len() < 2 {
                return Err(FilterParseError::InvalidFieldPath(input.to_string()));
            }
            if segments.len() > MAX_PATH_SEGMENTS {
                return Err(FilterParseError::InvalidFieldPath(input.to_string()));
            }
            if !segments[1..].iter().all(|segment| is_valid_key(segment)) {
                return Err(FilterParseError::InvalidFieldPath(input.to_string()));
            }
        } else {
            return Err(FilterParseError::UnknownField(input.to_string()));
        }
        Ok(FieldPath(
            segments.into_iter().map(str::to_string).collect(),
        ))
    }

    pub fn segments(&self) -> &[String] {
        &self.0
    }

    pub fn as_dotted(&self) -> String {
        self.0.join(".")
    }

    pub(crate) fn root(&self) -> &str {
        &self.0[0]
    }
}

impl TryFrom<String> for FieldPath {
    type Error = FilterParseError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        FieldPath::parse(&value)
    }
}

impl From<FieldPath> for String {
    fn from(value: FieldPath) -> Self {
        value.as_dotted()
    }
}

impl std::fmt::Display for FieldPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.as_dotted())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompareOp {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
}

impl CompareOp {
    pub(crate) fn is_ordering(self) -> bool {
        matches!(
            self,
            CompareOp::Lt | CompareOp::Lte | CompareOp::Gt | CompareOp::Gte
        )
    }

    #[cfg(feature = "mongo")]
    pub(crate) fn mongo(self) -> &'static str {
        match self {
            CompareOp::Eq => "$eq",
            CompareOp::Ne => "$ne",
            CompareOp::Lt => "$lt",
            CompareOp::Lte => "$lte",
            CompareOp::Gt => "$gt",
            CompareOp::Gte => "$gte",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextMatch {
    Contains,
    StartsWith,
    EndsWith,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Literal {
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Date(Date),
    Null,
}

impl Literal {
    pub(crate) fn value_type(&self) -> ValueType {
        match self {
            Literal::Bool(_) => ValueType::Bool,
            Literal::Int(_) => ValueType::Int,
            Literal::Float(_) => ValueType::Float,
            Literal::Str(_) => ValueType::Str,
            Literal::Date(_) => ValueType::Date,
            Literal::Null => ValueType::Null,
        }
    }

    pub(crate) fn family(&self) -> LiteralFamily {
        match self {
            Literal::Bool(_) => LiteralFamily::Bool,
            Literal::Int(_) | Literal::Float(_) => LiteralFamily::Number,
            Literal::Str(_) => LiteralFamily::Str,
            Literal::Date(_) => LiteralFamily::Date,
            Literal::Null => LiteralFamily::Null,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LiteralFamily {
    Bool,
    Number,
    Str,
    Date,
    Null,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Filter {
    All,
    None,
    And(Vec<Filter>),
    Or(Vec<Filter>),
    Not(Box<Filter>),
    Cmp {
        field: FieldPath,
        op: CompareOp,
        value: Literal,
    },
    In {
        field: FieldPath,
        values: Vec<Literal>,
    },
    Contains {
        field: FieldPath,
        value: Literal,
    },
    Any {
        field: FieldPath,
        op: CompareOp,
        value: Literal,
    },
    Every {
        field: FieldPath,
        op: CompareOp,
        value: Literal,
    },
    Missing {
        field: FieldPath,
    },
    IsNull {
        field: FieldPath,
    },
    Exists {
        field: FieldPath,
    },
    Text {
        field: FieldPath,
        mode: TextMatch,
        value: String,
    },
    ChildOf {
        of: String,
        #[serde(default)]
        deep: bool,
    },
    ParentOf {
        of: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FilterParseError {
    #[error("malformed filter JSON: {0}")]
    Json(String),
    #[error("unknown field path: {0}")]
    UnknownField(String),
    #[error("invalid field path: {0}")]
    InvalidFieldPath(String),
    #[error("invalid date literal: {0}")]
    InvalidDate(String),
    #[error("mixed literal types in `in` clause")]
    MixedInTypes,
    #[error("filter nesting too deep (limit {limit})")]
    TooDeep { limit: usize },
    #[error("filter has too many clauses (limit {limit})")]
    TooManyClauses { limit: usize },
}

impl Filter {
    pub const MAX_DEPTH: usize = 16;
    pub const MAX_NODES: usize = 256;

    pub fn from_json_str(input: &str) -> Result<Filter, FilterParseError> {
        let value: serde_json::Value =
            serde_json::from_str(input).map_err(|e| FilterParseError::Json(e.to_string()))?;
        Filter::from_json(&value)
    }

    pub fn from_json(value: &serde_json::Value) -> Result<Filter, FilterParseError> {
        let filter: Filter =
            serde_json::from_value(value.clone()).map_err(|e| classify(&e.to_string()))?;
        filter.validate()?;
        Ok(filter)
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }

    pub fn validate(&self) -> Result<(), FilterParseError> {
        let mut nodes = 0usize;
        walk(self, 1, &mut nodes)
    }
}

fn classify(message: &str) -> FilterParseError {
    if message.contains("ISO-8601") || message.contains("date out of supported range") {
        FilterParseError::InvalidDate(message.to_string())
    } else if message.contains("unknown field path") {
        FilterParseError::UnknownField(message.to_string())
    } else if message.contains("invalid field path") {
        FilterParseError::InvalidFieldPath(message.to_string())
    } else {
        FilterParseError::Json(message.to_string())
    }
}

fn walk(filter: &Filter, depth: usize, nodes: &mut usize) -> Result<(), FilterParseError> {
    *nodes += 1;
    if *nodes > Filter::MAX_NODES {
        return Err(FilterParseError::TooManyClauses {
            limit: Filter::MAX_NODES,
        });
    }
    if depth > Filter::MAX_DEPTH {
        return Err(FilterParseError::TooDeep {
            limit: Filter::MAX_DEPTH,
        });
    }
    match filter {
        Filter::And(children) | Filter::Or(children) => {
            for child in children {
                walk(child, depth + 1, nodes)?;
            }
        }
        Filter::Not(child) => walk(child, depth + 1, nodes)?,
        Filter::In { values, .. } => {
            let mut families = values.iter().map(Literal::family);
            if let Some(first) = families.next()
                && !families.all(|family| family == first)
            {
                return Err(FilterParseError::MixedInTypes);
            }
        }
        _ => {}
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortOrder {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SortKey {
    pub field: FieldPath,
    pub order: SortOrder,
}

impl SortKey {
    pub fn parse(input: &str) -> Result<SortKey, FilterParseError> {
        let trimmed = input.trim();
        if let Some(rest) = trimmed.strip_prefix('-') {
            return Ok(SortKey {
                field: FieldPath::parse(rest)?,
                order: SortOrder::Desc,
            });
        }
        if let Some((field, order)) = trimmed.rsplit_once(':') {
            let order = match order {
                "desc" => SortOrder::Desc,
                "asc" => SortOrder::Asc,
                _ => return Err(FilterParseError::InvalidFieldPath(input.to_string())),
            };
            return Ok(SortKey {
                field: FieldPath::parse(field)?,
                order,
            });
        }
        Ok(SortKey {
            field: FieldPath::parse(trimmed)?,
            order: SortOrder::Asc,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_paths() {
        assert_eq!(FieldPath::parse("title").unwrap().as_dotted(), "title");
        assert_eq!(FieldPath::parse("fm.due").unwrap().segments().len(), 2);
        assert_eq!(
            FieldPath::parse("plugins.calendar.uid")
                .unwrap()
                .as_dotted(),
            "plugins.calendar.uid"
        );
        assert!(matches!(
            FieldPath::parse("nope"),
            Err(FilterParseError::UnknownField(_))
        ));
        assert!(matches!(
            FieldPath::parse("fm"),
            Err(FilterParseError::InvalidFieldPath(_))
        ));
        assert!(matches!(
            FieldPath::parse("title.x"),
            Err(FilterParseError::InvalidFieldPath(_))
        ));
        assert!(matches!(
            FieldPath::parse("fm."),
            Err(FilterParseError::InvalidFieldPath(_))
        ));
        assert!(matches!(
            FieldPath::parse("fm.bad key"),
            Err(FilterParseError::InvalidFieldPath(_))
        ));
        assert!(matches!(
            FieldPath::parse("fm.a.b.c.d.e.f.g"),
            Err(FilterParseError::InvalidFieldPath(_))
        ));
    }

    #[test]
    fn wire_form_round_trips() {
        let json = r#"{"and":[
            {"cmp":{"field":"fm.status","op":"eq","value":{"str":"open"}}},
            {"contains":{"field":"fm.tags","value":{"str":"work"}}},
            {"missing":{"field":"fm.due"}},
            {"cmp":{"field":"updated_at","op":"gte","value":{"date":"2026-01-01"}}},
            {"not":{"is_null":{"field":"fm.owner"}}},
            "all"
        ]}"#;
        let filter = Filter::from_json_str(json).unwrap();
        let back = Filter::from_json(&filter.to_json()).unwrap();
        assert_eq!(filter, back);
    }

    #[test]
    fn date_literals_must_parse() {
        let err = Filter::from_json_str(
            r#"{"cmp":{"field":"fm.due","op":"eq","value":{"date":"2026-13-01"}}}"#,
        )
        .unwrap_err();
        assert!(matches!(err, FilterParseError::InvalidDate(_)));
    }

    #[test]
    fn unknown_field_is_reported() {
        let err = Filter::from_json_str(r#"{"cmp":{"field":"nope","op":"eq","value":{"int":1}}}"#)
            .unwrap_err();
        assert!(matches!(err, FilterParseError::UnknownField(_)));
    }

    #[test]
    fn mixed_in_types_are_rejected() {
        let err =
            Filter::from_json_str(r#"{"in":{"field":"fm.n","values":[{"int":1},{"str":"a"}]}}"#)
                .unwrap_err();
        assert_eq!(err, FilterParseError::MixedInTypes);
        assert!(
            Filter::from_json_str(r#"{"in":{"field":"fm.n","values":[{"int":1},{"float":1.5}]}}"#)
                .is_ok()
        );
    }

    #[test]
    fn depth_and_node_caps() {
        let mut filter = Filter::All;
        for _ in 0..Filter::MAX_DEPTH {
            filter = Filter::Not(Box::new(filter));
        }
        assert!(matches!(
            filter.validate(),
            Err(FilterParseError::TooDeep { .. })
        ));
        let wide = Filter::And((0..Filter::MAX_NODES).map(|_| Filter::All).collect());
        assert!(matches!(
            wide.validate(),
            Err(FilterParseError::TooManyClauses { .. })
        ));
    }

    #[test]
    fn sort_keys() {
        assert_eq!(
            SortKey::parse("title").unwrap(),
            SortKey {
                field: FieldPath::parse("title").unwrap(),
                order: SortOrder::Asc
            }
        );
        assert_eq!(
            SortKey::parse("-updated_at").unwrap().order,
            SortOrder::Desc
        );
        assert_eq!(
            SortKey::parse("fm.due:desc").unwrap().order,
            SortOrder::Desc
        );
        assert_eq!(SortKey::parse("fm.due:asc").unwrap().order, SortOrder::Asc);
        assert!(SortKey::parse("fm.due:sideways").is_err());
    }
}

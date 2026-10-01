//! The chainable way to write a [`Plan`]:
//!
//! ```
//! use ddd_core::query::{Op, Query};
//!
//! let plan = Query::new()
//!     .filter("title", Op::TextContains, "a")
//!     .sort("fm.key")
//!     .limit(20)
//!     .build()
//!     .unwrap();
//! assert_eq!(plan.sort.len(), 1);
//! ```
//!
//! Top-level conditions combine with *and*; [`Query::any_of`] groups some with *or*,
//! [`Query::none_of`] negates a group. The operators are the search's filter rows
//! (`plugins/base/_shared/conditions.ts`), and each lowers to one filter-DSL node.

use std::str::FromStr;

use serde::{Deserialize, Serialize};

use super::QueryError;
use super::plan::{Plan, Sort, Trash};
use crate::date::Date;
use crate::filter::{CompareOp, FieldPath, Filter, Literal, SortOrder, TextMatch};

/// A filter row's operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
    /// A list field holds the value.
    Contains,
    /// A list field holds at least one of the values.
    ContainsAny,
    /// Some element of a list field equals the value.
    Any,
    /// Every element of a list field equals the value.
    Every,
    TextContains,
    TextStartsWith,
    TextEndsWith,
    /// No value.
    Missing,
    /// No value.
    Exists,
    /// No value.
    IsNull,
    /// The value is a note id; the field is ignored.
    ChildOf,
    /// The value is a note id; the field is ignored.
    ParentOf,
}

impl Op {
    pub const ALL: [Op; 18] = [
        Op::Eq,
        Op::Ne,
        Op::Lt,
        Op::Lte,
        Op::Gt,
        Op::Gte,
        Op::Contains,
        Op::ContainsAny,
        Op::Any,
        Op::Every,
        Op::TextContains,
        Op::TextStartsWith,
        Op::TextEndsWith,
        Op::Missing,
        Op::Exists,
        Op::IsNull,
        Op::ChildOf,
        Op::ParentOf,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Op::Eq => "eq",
            Op::Ne => "ne",
            Op::Lt => "lt",
            Op::Lte => "lte",
            Op::Gt => "gt",
            Op::Gte => "gte",
            Op::Contains => "contains",
            Op::ContainsAny => "contains_any",
            Op::Any => "any",
            Op::Every => "every",
            Op::TextContains => "text_contains",
            Op::TextStartsWith => "text_starts_with",
            Op::TextEndsWith => "text_ends_with",
            Op::Missing => "missing",
            Op::Exists => "exists",
            Op::IsNull => "is_null",
            Op::ChildOf => "child_of",
            Op::ParentOf => "parent_of",
        }
    }

    /// Takes no value.
    pub fn is_valueless(self) -> bool {
        matches!(self, Op::Missing | Op::Exists | Op::IsNull)
    }
}

impl FromStr for Op {
    type Err = QueryError;

    fn from_str(input: &str) -> Result<Op, QueryError> {
        Op::ALL
            .into_iter()
            .find(|op| op.name() == input)
            .ok_or_else(|| QueryError::Clause(format!("unknown operator `{input}`")))
    }
}

impl std::fmt::Display for Op {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

impl From<&str> for Literal {
    fn from(value: &str) -> Literal {
        Literal::Str(value.to_string())
    }
}

impl From<String> for Literal {
    fn from(value: String) -> Literal {
        Literal::Str(value)
    }
}

impl From<i64> for Literal {
    fn from(value: i64) -> Literal {
        Literal::Int(value)
    }
}

impl From<f64> for Literal {
    fn from(value: f64) -> Literal {
        Literal::Float(value)
    }
}

impl From<bool> for Literal {
    fn from(value: bool) -> Literal {
        Literal::Bool(value)
    }
}

impl From<Date> for Literal {
    fn from(value: Date) -> Literal {
        Literal::Date(value)
    }
}

/// One filter row → one DSL node. `values` is one literal for most operators, any
/// number for `contains_any`, and is ignored by the value-less ones.
pub fn lower(field: &str, op: Op, values: &[Literal], deep: bool) -> Result<Filter, QueryError> {
    let one = || -> Result<&Literal, QueryError> {
        match values {
            [value] => Ok(value),
            _ => Err(QueryError::Clause(format!("`{op}` takes one value"))),
        }
    };
    let note = || -> Result<String, QueryError> {
        match one()? {
            Literal::Str(id) if !id.trim().is_empty() => Ok(id.trim().to_string()),
            _ => Err(QueryError::Clause(format!("`{op}` takes a note id"))),
        }
    };
    match op {
        Op::ChildOf => return Ok(Filter::ChildOf { of: note()?, deep }),
        Op::ParentOf => return Ok(Filter::ParentOf { of: note()? }),
        _ => {}
    }

    let field = FieldPath::parse(field.trim())?;
    Ok(match op {
        Op::Missing => Filter::Missing { field },
        Op::Exists => Filter::Exists { field },
        Op::IsNull => Filter::IsNull { field },
        Op::TextContains | Op::TextStartsWith | Op::TextEndsWith => {
            let Literal::Str(value) = one()? else {
                return Err(QueryError::Clause(format!("`{op}` takes text")));
            };
            let mode = match op {
                Op::TextContains => TextMatch::Contains,
                Op::TextStartsWith => TextMatch::StartsWith,
                _ => TextMatch::EndsWith,
            };
            Filter::Text {
                field,
                mode,
                value: value.clone(),
            }
        }
        Op::ContainsAny => {
            if values.is_empty() {
                return Err(QueryError::Clause(
                    "`contains_any` takes at least one value".into(),
                ));
            }
            let mut nodes: Vec<Filter> = values
                .iter()
                .map(|value| Filter::Contains {
                    field: field.clone(),
                    value: value.clone(),
                })
                .collect();
            if nodes.len() == 1 {
                nodes.remove(0)
            } else {
                Filter::Or(nodes)
            }
        }
        Op::Contains => Filter::Contains {
            field,
            value: one()?.clone(),
        },
        Op::Any => Filter::Any {
            field,
            op: CompareOp::Eq,
            value: one()?.clone(),
        },
        Op::Every => Filter::Every {
            field,
            op: CompareOp::Eq,
            value: one()?.clone(),
        },
        Op::Eq | Op::Ne | Op::Lt | Op::Lte | Op::Gt | Op::Gte => {
            let value = one()?.clone();
            let compare = match op {
                Op::Eq => CompareOp::Eq,
                Op::Ne => CompareOp::Ne,
                Op::Lt => CompareOp::Lt,
                Op::Lte => CompareOp::Lte,
                Op::Gt => CompareOp::Gt,
                _ => CompareOp::Gte,
            };
            if compare != CompareOp::Eq
                && compare != CompareOp::Ne
                && matches!(value, Literal::Bool(_) | Literal::Null)
            {
                return Err(QueryError::Clause(format!(
                    "`{op}` cannot order a true/false or null value"
                )));
            }
            Filter::Cmp {
                field,
                op: compare,
                value,
            }
        }
        Op::ChildOf | Op::ParentOf => unreachable!("handled above"),
    })
}

/// Builds a [`Plan`]. A mistake (a malformed field, a value the operator cannot take)
/// is kept and returned by [`Query::build`], so a chain never needs a `?` per step.
#[derive(Debug, Clone, Default)]
pub struct Query {
    plan: Plan,
    conditions: Vec<Filter>,
    error: Option<QueryError>,
}

impl Query {
    pub fn new() -> Query {
        Query::default()
    }

    /// Ranked full-text search.
    pub fn text(mut self, text: impl Into<String>) -> Query {
        self.plan.text = text.into().trim().to_string();
        self
    }

    /// A condition: `field op value`.
    pub fn filter(self, field: &str, op: Op, value: impl Into<Literal>) -> Query {
        let values = if op.is_valueless() {
            Vec::new()
        } else {
            vec![value.into()]
        };
        self.condition(lower(field, op, &values, false))
    }

    /// A condition taking several values: `contains_any`.
    pub fn filter_values<V: Into<Literal>>(
        self,
        field: &str,
        op: Op,
        values: impl IntoIterator<Item = V>,
    ) -> Query {
        let values: Vec<Literal> = values.into_iter().map(Into::into).collect();
        self.condition(lower(field, op, &values, false))
    }

    pub fn missing(self, field: &str) -> Query {
        self.condition(lower(field, Op::Missing, &[], false))
    }

    pub fn exists(self, field: &str) -> Query {
        self.condition(lower(field, Op::Exists, &[], false))
    }

    pub fn is_null(self, field: &str) -> Query {
        self.condition(lower(field, Op::IsNull, &[], false))
    }

    /// In note `id`; with `deep`, anywhere below it.
    pub fn child_of(self, id: &str, deep: bool) -> Query {
        self.condition(lower("", Op::ChildOf, &[id.into()], deep))
    }

    /// Holds note `id` among its children.
    pub fn parent_of(self, id: &str) -> Query {
        self.condition(lower("", Op::ParentOf, &[id.into()], false))
    }

    /// A filter-DSL node as it is.
    pub fn where_filter(self, filter: Filter) -> Query {
        self.condition(Ok(filter))
    }

    /// The conditions `group` adds, combined with *or*.
    pub fn any_of(self, group: impl FnOnce(Query) -> Query) -> Query {
        let inner = group(Query::new());
        self.group(inner, Filter::Or)
    }

    /// None of the conditions `group` adds: `not (a or b …)`.
    pub fn none_of(self, group: impl FnOnce(Query) -> Query) -> Query {
        let inner = group(Query::new());
        self.group(inner, |nodes| Filter::Not(Box::new(Filter::Or(nodes))))
    }

    /// Sort ascending by a field path, after any earlier sort.
    pub fn sort(self, field: &str) -> Query {
        self.sort_key(Sort::field(field, SortOrder::Asc))
    }

    /// Sort descending by a field path, after any earlier sort.
    pub fn sort_desc(self, field: &str) -> Query {
        self.sort_key(Sort::field(field, SortOrder::Desc))
    }

    /// Best match first (while there is text), after any earlier sort.
    pub fn sort_relevance(self) -> Query {
        self.sort_key(Ok(Sort::Relevance))
    }

    pub fn trash(mut self, trash: Trash) -> Query {
        self.plan.trash = trash;
        self
    }

    pub fn limit(mut self, limit: u32) -> Query {
        self.plan.limit = Some(limit);
        self
    }

    pub fn cursor(mut self, cursor: impl Into<String>) -> Query {
        self.plan.cursor = Some(cursor.into());
        self
    }

    /// Each text hit carries the line it matched on.
    pub fn snippets(mut self) -> Query {
        self.plan.snippets = true;
        self
    }

    pub fn build(self) -> Result<Plan, QueryError> {
        if let Some(error) = self.error {
            return Err(error);
        }
        let mut plan = self.plan;
        let mut conditions = self.conditions;
        plan.filter = match conditions.len() {
            0 => None,
            1 => conditions.pop(),
            _ => Some(Filter::And(conditions)),
        };
        plan.validate()?;
        Ok(plan)
    }

    fn condition(mut self, node: Result<Filter, QueryError>) -> Query {
        match node {
            Ok(node) => self.conditions.push(node),
            Err(error) => {
                self.error.get_or_insert(error);
            }
        }
        self
    }

    fn group(mut self, inner: Query, combine: impl FnOnce(Vec<Filter>) -> Filter) -> Query {
        if let Some(error) = inner.error {
            self.error.get_or_insert(error);
            return self;
        }
        if !inner.conditions.is_empty() {
            self.conditions.push(combine(inner.conditions));
        }
        self
    }

    fn sort_key(mut self, key: Result<Sort, crate::filter::FilterParseError>) -> Query {
        match key {
            Ok(key) => self.plan.sort.push(key),
            Err(error) => {
                self.error.get_or_insert(error.into());
            }
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_chain_builds_the_plan() {
        let plan = Query::new()
            .text(" milk ")
            .filter("title", Op::TextContains, "a")
            .any_of(|q| q.filter("fm.status", Op::Eq, "open").missing("fm.status"))
            .child_of("parent", true)
            .sort("fm.key")
            .sort_desc("updated_at")
            .limit(20)
            .build()
            .unwrap();
        assert_eq!(
            plan.to_json(),
            json!({
                "text": "milk",
                "filter": {"and": [
                    {"text": {"field": "title", "mode": "contains", "value": "a"}},
                    {"or": [
                        {"cmp": {"field": "fm.status", "op": "eq", "value": {"str": "open"}}},
                        {"missing": {"field": "fm.status"}},
                    ]},
                    {"child_of": {"of": "parent", "deep": true}},
                ]},
                "sort": ["fm.key", "-updated_at"],
                "limit": 20,
            })
        );
    }

    #[test]
    fn mistakes_surface_at_build() {
        assert!(Query::new().filter("nope", Op::Eq, "x").build().is_err());
        assert!(Query::new().filter("fm.n", Op::Lt, true).build().is_err());
        assert!(
            Query::new()
                .filter("title", Op::TextContains, 3i64)
                .build()
                .is_err()
        );
        assert!(Query::new().sort("fm.").build().is_err());
        assert!(Query::new().child_of(" ", false).build().is_err());
        assert!(Query::new().limit(0).build().is_err());
    }

    #[test]
    fn contains_any_is_an_or_of_contains() {
        let plan = Query::new()
            .filter_values("fm.tags", Op::ContainsAny, ["a", "b"])
            .build()
            .unwrap();
        assert_eq!(
            plan.to_json()["filter"],
            json!({"or": [
                {"contains": {"field": "fm.tags", "value": {"str": "a"}}},
                {"contains": {"field": "fm.tags", "value": {"str": "b"}}},
            ]})
        );
    }

    #[test]
    fn operators_round_trip_through_their_names() {
        for op in Op::ALL {
            assert_eq!(op.name().parse::<Op>().unwrap(), op);
            assert_eq!(serde_json::to_value(op).unwrap(), json!(op.name()));
        }
    }
}

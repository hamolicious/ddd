//! Filter evaluation over a projection row. The same code runs on the server
//! (over rows read from Mongo) and in the client kernel over IndexedDB rows
//! (SPEC §4.2) — so the local query engine and the server agree by construction.
//!
//! Two rules make evaluator/Mongo-compiler equality provable:
//!
//! 1. **Dynamic fields never error.** A value under `fm`/`plugins` whose type
//!    differs from the literal's simply does not match, exactly as Mongo's
//!    comparison bracketing behaves. Heterogeneous workspaces are normal.
//! 2. **Fixed columns error.** `id`/`title`/`content` are strings, `deleted` is
//!    a bool, `created_at`/`updated_at`/`deleted_at` are dates — their types are
//!    schema-fixed,
//!    so a mismatch is a query bug: [`EvalError::TypeMismatch`] here, and
//!    `CompileError::Unsupported` on the server (→ 400). Neither side silently
//!    answers.

use std::cmp::Ordering;

use thiserror::Error;

use crate::date::{self, Date};
use crate::filter::ast::{
    CompareOp, FieldPath, Filter, Literal, LiteralFamily, SortKey, SortOrder, TextMatch,
};
use crate::value::{Map, Value, ValueType};

/// The projection row (SPEC §4.1): what replicates to clients and what filters
/// address. Borrowed so evaluation never allocates a row.
#[derive(Debug, Clone, Copy)]
pub struct Row<'a> {
    pub id: &'a str,
    pub title: &'a str,
    /// Materialized full text (plain), including `%%%` sections.
    pub content: &'a str,
    pub fm: &'a Map,
    pub plugins: &'a Map,
    pub created_at: Option<&'a Date>,
    pub updated_at: Option<&'a Date>,
    /// When this document was tombstoned. `None` on a live document — the same
    /// absence Mongo stores (the field is unset, never written as null), so
    /// `missing` and `exists` agree on both sides.
    pub deleted_at: Option<&'a Date>,
    pub deleted: bool,
}

/// Result of resolving a field path against a row: present-with-value, or
/// genuinely absent (the `missing` vs `null` distinction, SPEC §4.2).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FieldRef<'a> {
    Missing,
    Present(&'a Value),
    /// Projection scalars that are not stored in `fm`/`plugins`.
    Str(&'a str),
    Bool(bool),
    Date(&'a Date),
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EvalError {
    #[error("type mismatch comparing {field}: field is {found:?}, literal is {expected:?}")]
    TypeMismatch {
        field: String,
        found: ValueType,
        expected: ValueType,
    },
    #[error("operator not applicable to {field}")]
    NotApplicable { field: String },
    #[error("unknown field path: {0}")]
    UnknownField(String),
}

/// Evaluate a filter against one row.
///
/// Errors (rather than returning false) only on row-independent query bugs: a
/// type mismatch against a fixed projection column, or an operator that cannot
/// apply to the addressed kind of field. The server rejects those with 400; row
/// data never produces an error.
pub fn evaluate(filter: &Filter, row: &Row<'_>) -> Result<bool, EvalError> {
    match filter {
        Filter::All => Ok(true),
        Filter::None => Ok(false),
        Filter::And(children) => {
            for child in children {
                if !evaluate(child, row)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Filter::Or(children) => {
            for child in children {
                if evaluate(child, row)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Filter::Not(child) => Ok(!evaluate(child, row)?),
        Filter::Cmp { field, op, value } => {
            compare(&field.as_dotted(), resolve_field(row, field), *op, value)
        }
        Filter::In { field, values } => {
            let found = resolve_field(row, field);
            let name = field.as_dotted();
            for value in values {
                if compare(&name, found, CompareOp::Eq, value)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Filter::Contains { field, value } => {
            list_match(field, row, CompareOp::Eq, value, ListMode::Any)
        }
        Filter::Any { field, op, value } => list_match(field, row, *op, value, ListMode::Any),
        Filter::Every { field, op, value } => list_match(field, row, *op, value, ListMode::Every),
        Filter::Missing { field } => Ok(resolve_field(row, field) == FieldRef::Missing),
        Filter::IsNull { field } => Ok(matches!(
            resolve_field(row, field),
            FieldRef::Present(Value::Null)
        )),
        Filter::Exists { field } => Ok(resolve_field(row, field) != FieldRef::Missing),
        Filter::Text { field, mode, value } => {
            text_match(&field.as_dotted(), resolve_field(row, field), *mode, value)
        }
    }
}

/// Resolve a field path against a row.
pub fn resolve_field<'a>(row: &Row<'a>, field: &FieldPath) -> FieldRef<'a> {
    let segments = field.segments();
    match field.root() {
        "id" => FieldRef::Str(row.id),
        "title" => FieldRef::Str(row.title),
        "content" => FieldRef::Str(row.content),
        "deleted" => FieldRef::Bool(row.deleted),
        "created_at" => row.created_at.map_or(FieldRef::Missing, FieldRef::Date),
        "updated_at" => row.updated_at.map_or(FieldRef::Missing, FieldRef::Date),
        "deleted_at" => row.deleted_at.map_or(FieldRef::Missing, FieldRef::Date),
        "fm" => walk(row.fm, &segments[1..]),
        "plugins" => walk(row.plugins, &segments[1..]),
        _ => FieldRef::Missing,
    }
}

fn walk<'a>(map: &'a Map, segments: &[String]) -> FieldRef<'a> {
    let Some((first, rest)) = segments.split_first() else {
        return FieldRef::Missing;
    };
    let Some(mut current) = map.get(first.as_str()) else {
        return FieldRef::Missing;
    };
    for segment in rest {
        match current {
            Value::Map(inner) => match inner.get(segment.as_str()) {
                Some(next) => current = next,
                None => return FieldRef::Missing,
            },
            _ => return FieldRef::Missing,
        }
    }
    FieldRef::Present(current)
}

/// Compare a resolved field against a literal with one operator, applying the
/// same-type rule. `Missing` fields never match (except via `missing`).
pub fn compare(
    field_name: &str,
    found: FieldRef<'_>,
    op: CompareOp,
    literal: &Literal,
) -> Result<bool, EvalError> {
    // Checked before the row is consulted, so the verdict is row-independent.
    if op.is_ordering() && matches!(literal.family(), LiteralFamily::Null | LiteralFamily::Bool) {
        return Err(EvalError::NotApplicable {
            field: field_name.to_string(),
        });
    }
    if found == FieldRef::Missing {
        return Ok(false);
    }
    if op == CompareOp::Ne {
        // `ne` is exactly "present and not `eq`" — see README. This keeps it the
        // complement of `eq` on both sides without a second set of type rules.
        return Ok(!compare(field_name, found, CompareOp::Eq, literal)?);
    }

    match found {
        FieldRef::Missing => Ok(false),
        FieldRef::Str(text) => match literal {
            Literal::Str(wanted) => Ok(satisfies(op, text.cmp(wanted.as_str()))),
            other => Err(EvalError::TypeMismatch {
                field: field_name.to_string(),
                found: ValueType::Str,
                expected: other.value_type(),
            }),
        },
        FieldRef::Bool(value) => match literal {
            Literal::Bool(wanted) => Ok(satisfies(op, value.cmp(wanted))),
            other => Err(EvalError::TypeMismatch {
                field: field_name.to_string(),
                found: ValueType::Bool,
                expected: other.value_type(),
            }),
        },
        FieldRef::Date(date) => match literal {
            // Stored as a BSON date: the instant is what Mongo compares, so
            // precision is not part of the comparison here.
            Literal::Date(wanted) => Ok(satisfies(
                op,
                date.epoch_millis().cmp(&wanted.epoch_millis()),
            )),
            other => Err(EvalError::TypeMismatch {
                field: field_name.to_string(),
                found: ValueType::Date,
                expected: other.value_type(),
            }),
        },
        FieldRef::Present(value) => Ok(compare_dynamic(op, value, literal)),
    }
}

/// Dynamic (`fm`/`plugins`) comparison: type families must match, and a
/// mismatch is simply "no match".
fn compare_dynamic(op: CompareOp, value: &Value, literal: &Literal) -> bool {
    match literal {
        Literal::Null => matches!((op, value), (CompareOp::Eq, Value::Null)),
        Literal::Bool(wanted) => match value {
            Value::Bool(actual) => satisfies(op, actual.cmp(wanted)),
            _ => false,
        },
        Literal::Str(wanted) => match value {
            Value::Str(actual) => satisfies(op, actual.as_str().cmp(wanted.as_str())),
            _ => false,
        },
        Literal::Int(_) | Literal::Float(_) => {
            let wanted = match literal {
                Literal::Int(i) => *i as f64,
                Literal::Float(f) => *f,
                _ => unreachable!("guarded by the match arm"),
            };
            match value {
                Value::Int(actual) => satisfies(op, (*actual as f64).total_cmp(&wanted)),
                Value::Float(actual) => satisfies(op, actual.total_cmp(&wanted)),
                _ => false,
            }
        }
        // A date literal against stored text: only a *canonical* date string
        // participates, and the comparison is byte-wise over canonical forms —
        // which is exactly what the Mongo compiler emits (a shape regex plus a
        // string comparison). See `crates/core/README.md`.
        Literal::Date(wanted) => match value {
            Value::Str(actual) if date::is_canonical_shape(actual) => {
                satisfies(op, actual.as_str().cmp(wanted.canonical()))
            }
            _ => false,
        },
    }
}

fn satisfies(op: CompareOp, ordering: Ordering) -> bool {
    match op {
        CompareOp::Eq => ordering == Ordering::Equal,
        CompareOp::Ne => ordering != Ordering::Equal,
        CompareOp::Lt => ordering == Ordering::Less,
        CompareOp::Lte => ordering != Ordering::Greater,
        CompareOp::Gt => ordering == Ordering::Greater,
        CompareOp::Gte => ordering != Ordering::Less,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListMode {
    Any,
    Every,
}

fn list_match(
    field: &FieldPath,
    row: &Row<'_>,
    op: CompareOp,
    literal: &Literal,
    mode: ListMode,
) -> Result<bool, EvalError> {
    let name = field.as_dotted();
    if op.is_ordering() && matches!(literal.family(), LiteralFamily::Null | LiteralFamily::Bool) {
        return Err(EvalError::NotApplicable { field: name });
    }
    match resolve_field(row, field) {
        FieldRef::Missing => Ok(false),
        // Fixed columns are never lists; asking is a query bug.
        FieldRef::Str(_) | FieldRef::Bool(_) | FieldRef::Date(_) => {
            Err(EvalError::NotApplicable { field: name })
        }
        FieldRef::Present(Value::List(items)) => {
            let element = |item: &Value| match op {
                CompareOp::Ne => !compare_dynamic(CompareOp::Eq, item, literal),
                _ => compare_dynamic(op, item, literal),
            };
            Ok(match mode {
                ListMode::Any => items.iter().any(element),
                ListMode::Every => items.iter().all(element),
            })
        }
        // Not a list: no implicit array matching, in either direction.
        FieldRef::Present(_) => Ok(false),
    }
}

fn text_match(
    field_name: &str,
    found: FieldRef<'_>,
    mode: TextMatch,
    needle: &str,
) -> Result<bool, EvalError> {
    let haystack = match found {
        FieldRef::Missing => return Ok(false),
        FieldRef::Str(text) => text,
        FieldRef::Present(Value::Str(text)) => text.as_str(),
        FieldRef::Present(_) => return Ok(false),
        FieldRef::Bool(_) | FieldRef::Date(_) => {
            return Err(EvalError::NotApplicable {
                field: field_name.to_string(),
            });
        }
    };
    let haystack = haystack.to_lowercase();
    let needle = needle.to_lowercase();
    Ok(match mode {
        TextMatch::Contains => haystack.contains(&needle),
        TextMatch::StartsWith => haystack.starts_with(&needle),
        TextMatch::EndsWith => haystack.ends_with(&needle),
    })
}

/// Total ordering of two rows by sort keys, used by the client-side query engine
/// (the server sorts in Mongo). Missing values sort last in both directions.
///
/// `id` ascending is always the final tiebreaker — the same one the query layer
/// appends to the Mongo sort — so client and server orderings are identical **over
/// rows that all carry the sort key**.
///
/// **They are not identical over rows that do not, and that is a parked decision rather
/// than an oversight.** Mongo sorts an absent field as Null, the lowest BSON type, so it
/// comes *first* ascending; this comparator puts it last in both directions. Closing the
/// gap means either making `Missing` rank below `Null` here (and in
/// `web/kernel/src/query/filter.ts`, which mirrors this function line by line, in the same
/// commit) or emitting an `$ifNull` sort projection from `filter::mongo::compile_sort`.
/// `crates/server/tests/documents_query.rs` asserts the current behaviour of *both* sides
/// so that it stays a decision.
///
/// The one place it reaches a user-facing sort is `deleted_at`: it is the only fixed root
/// that can be absent and it is an advertised sort key (`SORTABLE_FIELDS`, the Trash
/// order). Ascending over `?trash=all` splits live from tombstoned documents to opposite
/// ends depending on who ordered them; descending — what the Trash view sends — agrees,
/// because the present values lead either way.
pub fn compare_rows(a: &Row<'_>, b: &Row<'_>, sort: &[SortKey]) -> Ordering {
    for key in sort {
        let left = resolve_field(a, &key.field);
        let right = resolve_field(b, &key.field);
        let ordering = match (left == FieldRef::Missing, right == FieldRef::Missing) {
            (true, true) => Ordering::Equal,
            // Missing last, regardless of direction.
            (true, false) => return Ordering::Greater,
            (false, true) => return Ordering::Less,
            (false, false) => {
                let raw = order_fields(left, right);
                match key.order {
                    SortOrder::Asc => raw,
                    SortOrder::Desc => raw.reverse(),
                }
            }
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    a.id.cmp(b.id)
}

fn order_fields(left: FieldRef<'_>, right: FieldRef<'_>) -> Ordering {
    match (left, right) {
        (FieldRef::Str(a), FieldRef::Str(b)) => a.cmp(b),
        (FieldRef::Bool(a), FieldRef::Bool(b)) => a.cmp(&b),
        (FieldRef::Date(a), FieldRef::Date(b)) => a.cmp(b),
        (FieldRef::Present(a), FieldRef::Present(b)) => order_values(a, b),
        // Mixed kinds only happen across different roots, which cannot occur for
        // one sort key; keep it total anyway.
        _ => Ordering::Equal,
    }
}

fn order_values(a: &Value, b: &Value) -> Ordering {
    fn rank(value: &Value) -> u8 {
        match value {
            Value::Null => 0,
            Value::Bool(_) => 1,
            Value::Int(_) | Value::Float(_) => 2,
            Value::Str(_) => 3,
            Value::List(_) => 4,
            Value::Map(_) => 5,
        }
    }
    let ordering = rank(a).cmp(&rank(b));
    if ordering != Ordering::Equal {
        return ordering;
    }
    match (a, b) {
        (Value::Null, Value::Null) => Ordering::Equal,
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        (Value::Str(x), Value::Str(y)) => x.cmp(y),
        (Value::List(x), Value::List(y)) => {
            for (left, right) in x.iter().zip(y.iter()) {
                let ordering = order_values(left, right);
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            x.len().cmp(&y.len())
        }
        (Value::Map(x), Value::Map(y)) => {
            for ((kx, vx), (ky, vy)) in x.iter().zip(y.iter()) {
                let ordering = kx.cmp(ky).then_with(|| order_values(vx, vy));
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            x.len().cmp(&y.len())
        }
        _ => {
            let x = a.as_float().unwrap_or(f64::NAN);
            let y = b.as_float().unwrap_or(f64::NAN);
            x.total_cmp(&y)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filter::ast::FieldPath;

    fn map(pairs: &[(&str, Value)]) -> Map {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    fn row<'a>(fm: &'a Map, plugins: &'a Map) -> Row<'a> {
        Row {
            id: "01",
            title: "Groceries",
            content: "milk and bread",
            fm,
            plugins,
            created_at: None,
            updated_at: None,
            deleted_at: None,
            deleted: false,
        }
    }

    fn filter(json: &str) -> Filter {
        Filter::from_json_str(json).unwrap_or_else(|e| panic!("{json}: {e}"))
    }

    #[test]
    fn missing_is_not_null() {
        let fm = map(&[("a", Value::Null)]);
        let plugins = Map::new();
        let r = row(&fm, &plugins);
        assert!(evaluate(&filter(r#"{"is_null":{"field":"fm.a"}}"#), &r).unwrap());
        assert!(!evaluate(&filter(r#"{"missing":{"field":"fm.a"}}"#), &r).unwrap());
        assert!(evaluate(&filter(r#"{"missing":{"field":"fm.b"}}"#), &r).unwrap());
        assert!(!evaluate(&filter(r#"{"is_null":{"field":"fm.b"}}"#), &r).unwrap());
        assert!(evaluate(&filter(r#"{"exists":{"field":"fm.a"}}"#), &r).unwrap());
        assert!(!evaluate(&filter(r#"{"exists":{"field":"fm.b"}}"#), &r).unwrap());
    }

    #[test]
    fn dynamic_type_mismatch_is_no_match_not_error() {
        let fm = map(&[("n", Value::Int(5))]);
        let plugins = Map::new();
        let r = row(&fm, &plugins);
        assert!(
            !evaluate(
                &filter(r#"{"cmp":{"field":"fm.n","op":"eq","value":{"str":"5"}}}"#),
                &r
            )
            .unwrap()
        );
        // int/float are one numeric family.
        assert!(
            evaluate(
                &filter(r#"{"cmp":{"field":"fm.n","op":"lt","value":{"float":5.5}}}"#),
                &r
            )
            .unwrap()
        );
    }

    #[test]
    fn fixed_column_mismatch_errors() {
        let fm = Map::new();
        let plugins = Map::new();
        let r = row(&fm, &plugins);
        let err = evaluate(
            &filter(r#"{"cmp":{"field":"title","op":"eq","value":{"int":1}}}"#),
            &r,
        )
        .unwrap_err();
        assert!(matches!(err, EvalError::TypeMismatch { .. }));
        assert!(
            evaluate(
                &filter(r#"{"cmp":{"field":"deleted","op":"eq","value":{"bool":false}}}"#),
                &r
            )
            .unwrap()
        );
    }

    #[test]
    fn ne_is_present_and_not_eq() {
        let fm = map(&[("s", Value::Str("a".into())), ("n", Value::Int(1))]);
        let plugins = Map::new();
        let r = row(&fm, &plugins);
        assert!(
            evaluate(
                &filter(r#"{"cmp":{"field":"fm.s","op":"ne","value":{"str":"b"}}}"#),
                &r
            )
            .unwrap()
        );
        assert!(
            !evaluate(
                &filter(r#"{"cmp":{"field":"fm.s","op":"ne","value":{"str":"a"}}}"#),
                &r
            )
            .unwrap()
        );
        // Different type: not equal, and the field is present, so `ne` matches.
        assert!(
            evaluate(
                &filter(r#"{"cmp":{"field":"fm.n","op":"ne","value":{"str":"1"}}}"#),
                &r
            )
            .unwrap()
        );
        // Missing never matches, not even `ne`.
        assert!(
            !evaluate(
                &filter(r#"{"cmp":{"field":"fm.zz","op":"ne","value":{"str":"x"}}}"#),
                &r
            )
            .unwrap()
        );
    }

    #[test]
    fn arrays_need_explicit_operators() {
        let fm = map(&[(
            "tags",
            Value::List(vec![Value::Str("work".into()), Value::Str("home".into())]),
        )]);
        let plugins = Map::new();
        let r = row(&fm, &plugins);
        // No implicit array matching.
        assert!(
            !evaluate(
                &filter(r#"{"cmp":{"field":"fm.tags","op":"eq","value":{"str":"work"}}}"#),
                &r
            )
            .unwrap()
        );
        assert!(
            evaluate(
                &filter(r#"{"contains":{"field":"fm.tags","value":{"str":"work"}}}"#),
                &r
            )
            .unwrap()
        );
        assert!(
            !evaluate(
                &filter(r#"{"contains":{"field":"fm.tags","value":{"str":"nope"}}}"#),
                &r
            )
            .unwrap()
        );
        assert!(
            evaluate(
                &filter(r#"{"any":{"field":"fm.tags","op":"gt","value":{"str":"m"}}}"#),
                &r
            )
            .unwrap()
        );
        assert!(
            !evaluate(
                &filter(r#"{"every":{"field":"fm.tags","op":"gt","value":{"str":"m"}}}"#),
                &r
            )
            .unwrap()
        );
    }

    #[test]
    fn dates_compare_on_canonical_text() {
        let fm = map(&[
            ("due", Value::Str("2026-09-23".into())),
            ("other", Value::Str("someday".into())),
        ]);
        let plugins = Map::new();
        let r = row(&fm, &plugins);
        assert!(
            evaluate(
                &filter(r#"{"cmp":{"field":"fm.due","op":"gte","value":{"date":"2026-01-01"}}}"#),
                &r
            )
            .unwrap()
        );
        assert!(
            !evaluate(
                &filter(r#"{"cmp":{"field":"fm.due","op":"lt","value":{"date":"2026-01-01"}}}"#),
                &r
            )
            .unwrap()
        );
        // A non-date string never participates in a date comparison.
        assert!(
            !evaluate(
                &filter(r#"{"cmp":{"field":"fm.other","op":"gte","value":{"date":"2026-01-01"}}}"#),
                &r
            )
            .unwrap()
        );
        // Precision is part of equality.
        assert!(!evaluate(&filter(r#"{"cmp":{"field":"fm.due","op":"eq","value":{"date":"2026-09-23T00:00:00Z"}}}"#), &r).unwrap());
    }

    #[test]
    fn text_is_case_insensitive() {
        let fm = Map::new();
        let plugins = Map::new();
        let r = row(&fm, &plugins);
        assert!(
            evaluate(
                &filter(r#"{"text":{"field":"title","mode":"contains","value":"GROCER"}}"#),
                &r
            )
            .unwrap()
        );
        assert!(
            evaluate(
                &filter(r#"{"text":{"field":"content","mode":"starts_with","value":"MILK"}}"#),
                &r
            )
            .unwrap()
        );
        assert!(
            evaluate(
                &filter(r#"{"text":{"field":"content","mode":"ends_with","value":"BREAD"}}"#),
                &r
            )
            .unwrap()
        );
        assert!(
            !evaluate(
                &filter(r#"{"text":{"field":"fm.nope","mode":"contains","value":"x"}}"#),
                &r
            )
            .unwrap()
        );
    }

    #[test]
    fn ordering_with_null_or_bool_is_not_applicable() {
        let fm = map(&[("a", Value::Null)]);
        let plugins = Map::new();
        let r = row(&fm, &plugins);
        assert!(matches!(
            evaluate(
                &filter(r#"{"cmp":{"field":"fm.a","op":"lt","value":"null"}}"#),
                &r
            ),
            Err(EvalError::NotApplicable { .. })
        ));
        assert!(matches!(
            evaluate(
                &filter(r#"{"cmp":{"field":"fm.a","op":"gt","value":{"bool":true}}}"#),
                &r
            ),
            Err(EvalError::NotApplicable { .. })
        ));
    }

    #[test]
    fn plugin_sections_are_addressable() {
        let fm = Map::new();
        let plugins = map(&[(
            "calendar",
            Value::Map(map(&[("uid", Value::Str("abc".into()))])),
        )]);
        let r = row(&fm, &plugins);
        assert!(
            evaluate(
                &filter(
                    r#"{"cmp":{"field":"plugins.calendar.uid","op":"eq","value":{"str":"abc"}}}"#
                ),
                &r
            )
            .unwrap()
        );
        assert!(evaluate(&filter(r#"{"missing":{"field":"plugins.other.uid"}}"#), &r).unwrap());
    }

    #[test]
    fn rows_sort_with_missing_last_and_id_tiebreak() {
        let with = map(&[("n", Value::Int(2))]);
        let without = Map::new();
        let plugins = Map::new();
        let mut a = row(&with, &plugins);
        a.id = "a";
        let mut b = row(&without, &plugins);
        b.id = "b";
        let mut c = row(&with, &plugins);
        c.id = "c";
        let key = vec![SortKey {
            field: FieldPath::parse("fm.n").unwrap(),
            order: SortOrder::Asc,
        }];
        assert_eq!(compare_rows(&a, &b, &key), Ordering::Less);
        assert_eq!(compare_rows(&b, &a, &key), Ordering::Greater);
        assert_eq!(compare_rows(&a, &c, &key), Ordering::Less);
        let desc = vec![SortKey {
            field: FieldPath::parse("fm.n").unwrap(),
            order: SortOrder::Desc,
        }];
        // Missing stays last in descending order too.
        assert_eq!(compare_rows(&a, &b, &desc), Ordering::Less);
    }
}

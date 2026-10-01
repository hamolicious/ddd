//! Compile the DSL to a Mongo query (server only, `mongo` feature).
//!
//! Mongo's implicit-array matching and type bracketing are explicitly *not* the
//! contract (SPEC §4.2) — the compiler must emit queries whose results match
//! [`crate::filter::evaluator`] exactly, using `$type` guards and `$elemMatch`
//! where the DSL's semantics differ from Mongo's defaults.
//!
//! The three places Mongo has to be argued with:
//!
//! 1. **Implicit array traversal.** `{f: {$gt: 5}}` matches `f: [1, 9]`. Every
//!    scalar comparison therefore carries `{f: {$not: {$type: "array"}}}`.
//! 2. **`$ne` / `null` matching absent fields.** `ne` compiles to
//!    "present and not `eq`", and `eq null` to `$type: "null"`, so `missing` and
//!    `null` stay distinct.
//! 3. **Dates are stored as canonical strings** in `fm`/`plugins` (SPEC §3.4),
//!    so a date comparison is a string comparison gated on the canonical shape
//!    regex — the same participation test the evaluator applies.

use bson::{Bson, Document as BsonDocument, doc};
use thiserror::Error;

use crate::date::CANONICAL_SHAPE_REGEX;
use crate::filter::ast::{
    CompareOp, FieldPath, Filter, Literal, LiteralFamily, SortKey, SortOrder, TextMatch,
};

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CompileError {
    #[error("unknown field path: {0}")]
    UnknownField(String),
    #[error("filter clause cannot be compiled to a Mongo query: {0}")]
    Unsupported(String),
    #[error("field {0} is not indexable for sorting")]
    NotSortable(String),
}

/// A predicate that matches nothing. `_id` always exists, so this is both always
/// false and index-friendly.
fn never() -> BsonDocument {
    doc! { "_id": { "$exists": false } }
}

/// A predicate that matches everything.
fn always() -> BsonDocument {
    BsonDocument::new()
}

/// Compile a filter to the `find` query document.
///
/// The caller is responsible for adding the tombstone predicate
/// (`deleted_at: null` or the Trash variant) — the DSL never implies it.
pub fn compile(filter: &Filter) -> Result<BsonDocument, CompileError> {
    match filter {
        Filter::All => Ok(always()),
        Filter::None => Ok(never()),
        Filter::And(children) => {
            if children.is_empty() {
                return Ok(always());
            }
            let parts = children
                .iter()
                .map(compile)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(doc! { "$and": parts })
        }
        Filter::Or(children) => {
            if children.is_empty() {
                return Ok(never());
            }
            let parts = children
                .iter()
                .map(compile)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(doc! { "$or": parts })
        }
        Filter::Not(child) => Ok(doc! { "$nor": [compile(child)?] }),
        Filter::Cmp { field, op, value } => compile_cmp(field, *op, value),
        Filter::In { field, values } => {
            if values.is_empty() {
                return Ok(never());
            }
            let parts = values
                .iter()
                .map(|value| compile_cmp(field, CompareOp::Eq, value))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(doc! { "$or": parts })
        }
        Filter::Contains { field, value } => compile_any(field, CompareOp::Eq, value),
        Filter::Any { field, op, value } => compile_any(field, *op, value),
        Filter::Every { field, op, value } => compile_every(field, *op, value),
        Filter::Missing { field } => match column(field) {
            Column::Dynamic | Column::Date => {
                Ok(doc! { stored_path(field)?: { "$exists": false } })
            }
            // Always-present projection columns.
            Column::Str => Ok(doc! { stored_path(field)?: { "$exists": false } }),
            Column::Deleted => Ok(never()),
        },
        Filter::IsNull { field } => match column(field) {
            Column::Deleted => Ok(never()),
            // `$type` traverses arrays element-wise, so `[null]` would match on
            // the server while the evaluator — which sees a `List`, not a `Null` —
            // says no. Same guard every other dynamic-field branch carries.
            Column::Dynamic => {
                let path = stored_path(field)?;
                Ok(doc! { "$and": [
                    { path.clone(): { "$not": { "$type": "array" } } },
                    { path: { "$type": "null" } },
                ] })
            }
            _ => Ok(doc! { stored_path(field)?: { "$type": "null" } }),
        },
        Filter::Exists { field } => match column(field) {
            Column::Deleted => Ok(always()),
            _ => Ok(doc! { stored_path(field)?: { "$exists": true } }),
        },
        Filter::Text { field, mode, value } => compile_text(field, *mode, value),
        // A join over the folder tree: the query engine's, never a Mongo query.
        Filter::ChildOf { .. } => Err(CompileError::Unsupported("child_of".to_string())),
        Filter::ParentOf { .. } => Err(CompileError::Unsupported("parent_of".to_string())),
    }
}

/// Which kind of projection column a path addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Column {
    /// `id`, `title`, `content` — always a string.
    Str,
    /// `created_at`, `updated_at`, `deleted_at` — always a BSON date.
    Date,
    /// `deleted` — derived from `deleted_at`.
    Deleted,
    /// `fm.*`, `plugins.*` — materialized from document text, any type.
    Dynamic,
}

fn column(field: &FieldPath) -> Column {
    match field.root() {
        "id" | "title" | "content" => Column::Str,
        "created_at" | "updated_at" | "deleted_at" => Column::Date,
        "deleted" => Column::Deleted,
        _ => Column::Dynamic,
    }
}

fn compile_cmp(
    field: &FieldPath,
    op: CompareOp,
    literal: &Literal,
) -> Result<BsonDocument, CompileError> {
    let name = field.as_dotted();
    if op.is_ordering() && matches!(literal.family(), LiteralFamily::Null | LiteralFamily::Bool) {
        return Err(CompileError::Unsupported(format!(
            "{name}: ordering comparison against a {:?} literal",
            literal.family()
        )));
    }
    if op == CompareOp::Ne {
        // "present and not eq" — see the evaluator; `$ne` alone would match
        // documents where the field is absent.
        let eq = compile_cmp(field, CompareOp::Eq, literal)?;
        return Ok(match column(field) {
            Column::Deleted => doc! { "$nor": [eq] },
            _ => {
                doc! { "$and": [ { stored_path(field)?: { "$exists": true } }, { "$nor": [eq] } ] }
            }
        });
    }

    match column(field) {
        Column::Str => match literal {
            Literal::Str(text) => Ok(doc! { stored_path(field)?: { op.mongo(): text.clone() } }),
            other => Err(type_mismatch(&name, other)),
        },
        Column::Date => match literal {
            Literal::Date(date) => {
                let value = bson::DateTime::from_millis(date.epoch_millis());
                Ok(doc! { stored_path(field)?: { op.mongo(): value } })
            }
            other => Err(type_mismatch(&name, other)),
        },
        Column::Deleted => match literal {
            Literal::Bool(wanted) => {
                // `deleted` is derived: a tombstoned document has `deleted_at`.
                Ok(if *wanted {
                    doc! { "deleted_at": { "$ne": Bson::Null } }
                } else {
                    doc! { "deleted_at": { "$eq": Bson::Null } }
                })
            }
            other => Err(type_mismatch(&name, other)),
        },
        Column::Dynamic => {
            let path = stored_path(field)?;
            match literal {
                // The array guard matters here too: without it `eq null` matches
                // an array containing null on the server but not in the evaluator.
                Literal::Null => Ok(doc! { "$and": [
                    { path.clone(): { "$not": { "$type": "array" } } },
                    { path: { "$type": "null" } },
                ] }),
                Literal::Date(date) => Ok(doc! { "$and": [
                    { path.clone(): { "$not": { "$type": "array" } } },
                    { path.clone(): { "$regex": CANONICAL_SHAPE_REGEX } },
                    { path: { op.mongo(): date.canonical().to_string() } },
                ] }),
                other => {
                    let value = scalar_to_bson(other);
                    Ok(doc! { "$and": [
                        { path.clone(): { "$not": { "$type": "array" } } },
                        { path: { op.mongo(): value } },
                    ] })
                }
            }
        }
    }
}

/// `any` / `contains`: at least one element of an array field matches.
fn compile_any(
    field: &FieldPath,
    op: CompareOp,
    literal: &Literal,
) -> Result<BsonDocument, CompileError> {
    let name = field.as_dotted();
    if op.is_ordering() && matches!(literal.family(), LiteralFamily::Null | LiteralFamily::Bool) {
        return Err(CompileError::Unsupported(format!(
            "{name}: ordering comparison against a {:?} literal",
            literal.family()
        )));
    }
    if column(field) != Column::Dynamic {
        return Err(CompileError::Unsupported(format!(
            "{name}: list operators apply to fm/plugins fields only"
        )));
    }
    let path = stored_path(field)?;
    Ok(doc! { path: { "$elemMatch": element_predicate(op, literal) } })
}

/// `every`: no element fails the comparison, and the field is an array.
fn compile_every(
    field: &FieldPath,
    op: CompareOp,
    literal: &Literal,
) -> Result<BsonDocument, CompileError> {
    let name = field.as_dotted();
    if op.is_ordering() && matches!(literal.family(), LiteralFamily::Null | LiteralFamily::Bool) {
        return Err(CompileError::Unsupported(format!(
            "{name}: ordering comparison against a {:?} literal",
            literal.family()
        )));
    }
    if column(field) != Column::Dynamic {
        return Err(CompileError::Unsupported(format!(
            "{name}: list operators apply to fm/plugins fields only"
        )));
    }
    let path = stored_path(field)?;
    let failing = doc! { "$not": element_predicate(op, literal) };
    Ok(doc! { "$and": [
        { path.clone(): { "$type": "array" } },
        { "$nor": [ { path: { "$elemMatch": failing } } ] },
    ] })
}

/// The per-element predicate used inside `$elemMatch`. `ne` is the negation of
/// `eq`, matching the evaluator.
fn element_predicate(op: CompareOp, literal: &Literal) -> BsonDocument {
    match (op, literal) {
        (CompareOp::Ne, _) => doc! { "$not": element_predicate(CompareOp::Eq, literal) },
        (_, Literal::Null) => doc! { "$type": "null" },
        (_, Literal::Date(date)) => doc! {
            "$regex": CANONICAL_SHAPE_REGEX,
            op.mongo(): date.canonical().to_string(),
        },
        (_, other) => doc! { op.mongo(): scalar_to_bson(other) },
    }
}

fn compile_text(
    field: &FieldPath,
    mode: TextMatch,
    needle: &str,
) -> Result<BsonDocument, CompileError> {
    let name = field.as_dotted();
    let pattern = match mode {
        TextMatch::Contains => escape_regex(needle),
        TextMatch::StartsWith => format!("^{}", escape_regex(needle)),
        TextMatch::EndsWith => format!("{}$", escape_regex(needle)),
    };
    let regex = Bson::RegularExpression(bson::Regex {
        pattern,
        options: "i".to_string(),
    });
    match column(field) {
        Column::Str => Ok(doc! { stored_path(field)?: regex }),
        Column::Dynamic => {
            let path = stored_path(field)?;
            Ok(doc! { "$and": [
                { path.clone(): { "$not": { "$type": "array" } } },
                { path: regex },
            ] })
        }
        Column::Date | Column::Deleted => Err(CompileError::Unsupported(format!(
            "{name}: text matching applies to string fields only"
        ))),
    }
}

fn type_mismatch(name: &str, literal: &Literal) -> CompileError {
    CompileError::Unsupported(format!(
        "{name}: column type does not match a {:?} literal",
        literal.value_type()
    ))
}

fn scalar_to_bson(literal: &Literal) -> Bson {
    match literal {
        Literal::Bool(b) => Bson::Boolean(*b),
        Literal::Int(i) => Bson::Int64(*i),
        Literal::Float(f) => Bson::Double(*f),
        Literal::Str(s) => Bson::String(s.clone()),
        Literal::Date(d) => Bson::String(d.canonical().to_string()),
        Literal::Null => Bson::Null,
    }
}

fn escape_regex(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        if matches!(
            c,
            '\\' | '^' | '$' | '.' | '|' | '?' | '*' | '+' | '(' | ')' | '[' | ']' | '{' | '}'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Compile sort keys to a Mongo sort document, in order.
///
/// The caller appends `_id` as the final tiebreaker (the evaluator's
/// `compare_rows` does the same).
pub fn compile_sort(sort: &[SortKey]) -> Result<BsonDocument, CompileError> {
    let mut out = BsonDocument::new();
    for key in sort {
        let name = key.field.as_dotted();
        if matches!(name.as_str(), "content" | "deleted") {
            return Err(CompileError::NotSortable(name));
        }
        let direction = match key.order {
            SortOrder::Asc => 1i32,
            SortOrder::Desc => -1i32,
        };
        out.insert(stored_path(&key.field)?, direction);
    }
    Ok(out)
}

/// Map a DSL field path to its stored Mongo path (e.g. `fm.due` → `fm.due`,
/// `updated_at` → `updated_at`, `id` → `_id`).
///
/// `deleted` maps to `deleted_at`, the column that backs it; the boolean
/// translation happens in [`compile`].
pub fn stored_path(field: &crate::filter::ast::FieldPath) -> Result<String, CompileError> {
    let segments = field.segments();
    match segments[0].as_str() {
        "id" => Ok("_id".to_string()),
        "deleted" => Ok("deleted_at".to_string()),
        "title" | "content" | "created_at" | "updated_at" | "deleted_at" => Ok(segments[0].clone()),
        "fm" | "plugins" => Ok(segments.join(".")),
        other => Err(CompileError::UnknownField(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(json: &str) -> Filter {
        Filter::from_json_str(json).unwrap_or_else(|e| panic!("{json}: {e}"))
    }

    #[test]
    fn scalar_comparisons_guard_against_arrays() {
        let query = compile(&filter(
            r#"{"cmp":{"field":"fm.n","op":"gt","value":{"int":1}}}"#,
        ))
        .unwrap();
        assert_eq!(
            query,
            doc! { "$and": [
                { "fm.n": { "$not": { "$type": "array" } } },
                { "fm.n": { "$gt": 1i64 } },
            ] }
        );
    }

    #[test]
    fn fixed_columns_are_not_array_guarded() {
        let query = compile(&filter(
            r#"{"cmp":{"field":"title","op":"eq","value":{"str":"A"}}}"#,
        ))
        .unwrap();
        assert_eq!(query, doc! { "title": { "$eq": "A" } });
    }

    #[test]
    fn fixed_column_type_mismatch_is_rejected() {
        assert!(matches!(
            compile(&filter(
                r#"{"cmp":{"field":"title","op":"eq","value":{"int":1}}}"#
            )),
            Err(CompileError::Unsupported(_))
        ));
        assert!(matches!(
            compile(&filter(
                r#"{"cmp":{"field":"updated_at","op":"eq","value":{"str":"x"}}}"#
            )),
            Err(CompileError::Unsupported(_))
        ));
    }

    #[test]
    fn deleted_maps_onto_the_tombstone_column() {
        assert_eq!(
            compile(&filter(
                r#"{"cmp":{"field":"deleted","op":"eq","value":{"bool":true}}}"#
            ))
            .unwrap(),
            doc! { "deleted_at": { "$ne": Bson::Null } }
        );
        assert_eq!(
            compile(&filter(
                r#"{"cmp":{"field":"deleted","op":"eq","value":{"bool":false}}}"#
            ))
            .unwrap(),
            doc! { "deleted_at": { "$eq": Bson::Null } }
        );
    }

    #[test]
    fn null_and_missing_stay_distinct() {
        // Both null predicates carry the array guard: `$type` traverses arrays
        // element-wise, so `fm.a: [null]` would otherwise match here and not in
        // the evaluator (which sees a `List`, never a `Null`).
        let guarded_null = doc! { "$and": [
            { "fm.a": { "$not": { "$type": "array" } } },
            { "fm.a": { "$type": "null" } },
        ] };
        assert_eq!(
            compile(&filter(r#"{"is_null":{"field":"fm.a"}}"#)).unwrap(),
            guarded_null
        );
        assert_eq!(
            compile(&filter(r#"{"missing":{"field":"fm.a"}}"#)).unwrap(),
            doc! { "fm.a": { "$exists": false } }
        );
        assert_eq!(
            compile(&filter(
                r#"{"cmp":{"field":"fm.a","op":"eq","value":"null"}}"#
            ))
            .unwrap(),
            guarded_null
        );
    }

    #[test]
    fn dates_compile_to_shape_guarded_string_comparisons() {
        let query = compile(&filter(
            r#"{"cmp":{"field":"fm.due","op":"gte","value":{"date":"2026-01-01"}}}"#,
        ))
        .unwrap();
        assert_eq!(
            query,
            doc! { "$and": [
                { "fm.due": { "$not": { "$type": "array" } } },
                { "fm.due": { "$regex": CANONICAL_SHAPE_REGEX } },
                { "fm.due": { "$gte": "2026-01-01" } },
            ] }
        );
        // The schema columns are real BSON dates.
        let query = compile(&filter(
            r#"{"cmp":{"field":"created_at","op":"lt","value":{"date":"2026-01-01"}}}"#,
        ))
        .unwrap();
        assert_eq!(
            query,
            doc! { "created_at": { "$lt": bson::DateTime::from_millis(1_767_225_600_000) } }
        );
    }

    #[test]
    fn list_operators_use_elem_match() {
        assert_eq!(
            compile(&filter(
                r#"{"contains":{"field":"fm.tags","value":{"str":"work"}}}"#
            ))
            .unwrap(),
            doc! { "fm.tags": { "$elemMatch": { "$eq": "work" } } }
        );
        assert_eq!(
            compile(&filter(
                r#"{"every":{"field":"fm.tags","op":"eq","value":{"str":"work"}}}"#
            ))
            .unwrap(),
            doc! { "$and": [
                { "fm.tags": { "$type": "array" } },
                { "$nor": [ { "fm.tags": { "$elemMatch": { "$not": { "$eq": "work" } } } } ] },
            ] }
        );
        assert!(matches!(
            compile(&filter(
                r#"{"contains":{"field":"title","value":{"str":"x"}}}"#
            )),
            Err(CompileError::Unsupported(_))
        ));
    }

    #[test]
    fn text_escapes_the_needle() {
        let query = compile(&filter(
            r#"{"text":{"field":"title","mode":"starts_with","value":"a.b*"}}"#,
        ))
        .unwrap();
        assert_eq!(
            query,
            doc! { "title": Bson::RegularExpression(bson::Regex {
                pattern: r"^a\.b\*".to_string(),
                options: "i".to_string(),
            }) }
        );
    }

    #[test]
    fn boolean_combinators() {
        assert_eq!(compile(&Filter::All).unwrap(), BsonDocument::new());
        assert_eq!(compile(&Filter::And(vec![])).unwrap(), BsonDocument::new());
        assert_eq!(compile(&Filter::Or(vec![])).unwrap(), never());
        assert_eq!(
            compile(&Filter::Not(Box::new(Filter::All))).unwrap(),
            doc! { "$nor": [BsonDocument::new()] }
        );
    }

    #[test]
    fn sorts_and_paths() {
        let keys = vec![
            SortKey::parse("-updated_at").unwrap(),
            SortKey::parse("fm.due").unwrap(),
        ];
        assert_eq!(
            compile_sort(&keys).unwrap(),
            doc! { "updated_at": -1i32, "fm.due": 1i32 }
        );
        assert!(matches!(
            compile_sort(&[SortKey::parse("content").unwrap()]),
            Err(CompileError::NotSortable(_))
        ));
        assert_eq!(
            stored_path(&FieldPath::parse("id").unwrap()).unwrap(),
            "_id"
        );
        assert_eq!(
            stored_path(&FieldPath::parse("deleted").unwrap()).unwrap(),
            "deleted_at"
        );
    }
}

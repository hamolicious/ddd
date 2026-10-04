use std::cell::RefCell;

use serde::Serialize;

use super::fuzzy::{FuzzyCandidate, FuzzyMatch, FuzzySpec, score_candidate};
use super::project::SqlValue;
use super::schema::{FOLD_FUNCTION, fold};

pub const FUZZY_FUNCTION: &str = "ddd_fuzzy";
pub const FUZZY_TERMS_FUNCTION: &str = "ddd_fuzzy_terms";

pub type SqlCall = fn(&[SqlValue]) -> SqlValue;

#[derive(Clone, Copy)]
pub struct SqlFunction {
    pub name: &'static str,
    pub arity: i32,
    pub deterministic: bool,
    pub call: SqlCall,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SqlFunctionInfo {
    pub name: &'static str,
    pub arity: i32,
    pub deterministic: bool,
}

impl SqlFunction {
    pub fn info(&self) -> SqlFunctionInfo {
        SqlFunctionInfo {
            name: self.name,
            arity: self.arity,
            deterministic: self.deterministic,
        }
    }

    pub fn accepts(&self, count: usize) -> bool {
        self.arity < 0 || usize::try_from(self.arity) == Ok(count)
    }
}

fn fold_value(args: &[SqlValue]) -> SqlValue {
    match args.first() {
        Some(SqlValue::Text(text)) => SqlValue::Text(fold(text)),
        Some(other) => other.clone(),
        None => SqlValue::Null,
    }
}

struct LastMatch {
    spec: String,
    title: String,
    content: String,
    found: Option<FuzzyMatch>,
}

thread_local! {
    static SPEC: RefCell<Option<(String, Option<FuzzySpec>)>> = const { RefCell::new(None) };
    static LAST: RefCell<Option<LastMatch>> = const { RefCell::new(None) };
}

fn text_at(args: &[SqlValue], index: usize) -> &str {
    match args.get(index) {
        Some(SqlValue::Text(text)) => text,
        _ => "",
    }
}

fn parsed_spec(raw: &str) -> Option<FuzzySpec> {
    SPEC.with(|cell| {
        let mut cached = cell.borrow_mut();
        if let Some((known, spec)) = cached.as_ref()
            && known == raw
        {
            return spec.clone();
        }
        let spec = serde_json::from_str::<FuzzySpec>(raw).ok();
        *cached = Some((raw.to_string(), spec.clone()));
        spec
    })
}

fn fuzzy_match(args: &[SqlValue]) -> Option<FuzzyMatch> {
    let (spec, title, content) = (text_at(args, 0), text_at(args, 1), text_at(args, 2));
    LAST.with(|cell| {
        let mut last = cell.borrow_mut();
        if let Some(known) = last.as_ref()
            && known.spec == spec
            && known.title == title
            && known.content == content
        {
            return known.found.clone();
        }
        let found = parsed_spec(spec).and_then(|parsed| {
            score_candidate(
                &parsed,
                &FuzzyCandidate {
                    title: title.to_string(),
                    content: content.to_string(),
                },
            )
        });
        *last = Some(LastMatch {
            spec: spec.to_string(),
            title: title.to_string(),
            content: content.to_string(),
            found: found.clone(),
        });
        found
    })
}

fn fuzzy_score(args: &[SqlValue]) -> SqlValue {
    SqlValue::Real(fuzzy_match(args).map_or(0.0, |found| found.score))
}

fn fuzzy_terms(args: &[SqlValue]) -> SqlValue {
    match fuzzy_match(args) {
        Some(found) => {
            SqlValue::Text(serde_json::to_string(&found.terms).unwrap_or_else(|_| "[]".into()))
        }
        None => SqlValue::Null,
    }
}

pub const SQL_FUNCTIONS: &[SqlFunction] = &[
    SqlFunction {
        name: FOLD_FUNCTION,
        arity: 1,
        deterministic: true,
        call: fold_value,
    },
    SqlFunction {
        name: FUZZY_FUNCTION,
        arity: 3,
        deterministic: true,
        call: fuzzy_score,
    },
    SqlFunction {
        name: FUZZY_TERMS_FUNCTION,
        arity: 3,
        deterministic: true,
        call: fuzzy_terms,
    },
];

pub fn sql_function(name: &str) -> Option<&'static SqlFunction> {
    SQL_FUNCTIONS
        .iter()
        .find(|function| function.name.eq_ignore_ascii_case(name))
}

pub fn call_sql_function(index: usize, args: &[SqlValue]) -> SqlValue {
    match SQL_FUNCTIONS.get(index) {
        Some(function) if function.accepts(args.len()) => (function.call)(args),
        _ => SqlValue::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registry_names_every_function_once() {
        let mut names: Vec<String> = SQL_FUNCTIONS
            .iter()
            .map(|function| function.name.to_ascii_lowercase())
            .collect();
        let count = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), count);
    }

    #[test]
    fn fold_lowercases_text_and_passes_other_values_through() {
        let index = SQL_FUNCTIONS
            .iter()
            .position(|function| function.name == FOLD_FUNCTION)
            .unwrap();
        assert_eq!(
            call_sql_function(index, &[SqlValue::Text("CaFÉ".into())]),
            SqlValue::Text("café".into())
        );
        assert_eq!(
            call_sql_function(index, &[SqlValue::Int(3)]),
            SqlValue::Int(3)
        );
        assert_eq!(call_sql_function(index, &[SqlValue::Null]), SqlValue::Null);
    }

    #[test]
    fn a_call_with_the_wrong_arity_or_index_is_null() {
        assert_eq!(call_sql_function(0, &[]), SqlValue::Null);
        assert_eq!(
            call_sql_function(SQL_FUNCTIONS.len(), &[SqlValue::Int(1)]),
            SqlValue::Null
        );
    }

    fn fuzzy_args(query: &str, title: &str, content: &str) -> Vec<SqlValue> {
        let spec = FuzzySpec {
            terms: super::super::fuzzy::fuzzy_terms(query),
            fields: vec![super::super::text::TextField::Title],
            max_distance: super::super::fuzzy::MAX_FUZZY_DISTANCE,
        };
        vec![
            SqlValue::Text(serde_json::to_string(&spec).unwrap()),
            SqlValue::Text(title.into()),
            SqlValue::Text(content.into()),
        ]
    }

    #[test]
    fn fuzzy_scores_a_row_and_names_the_words_it_matched() {
        let score = sql_function(FUZZY_FUNCTION).unwrap().call;
        let terms = sql_function(FUZZY_TERMS_FUNCTION).unwrap().call;
        let hit = fuzzy_args("reprot", "Monthly Report", "");
        assert!(matches!(score(&hit), SqlValue::Real(found) if found > 0.0));
        assert_eq!(terms(&hit), SqlValue::Text(r#"["Report"]"#.into()));
        let miss = fuzzy_args("reprot", "Groceries", "");
        assert_eq!(score(&miss), SqlValue::Real(0.0));
        assert_eq!(terms(&miss), SqlValue::Null);
    }

    #[test]
    fn fuzzy_with_a_broken_spec_matches_nothing() {
        let score = sql_function(FUZZY_FUNCTION).unwrap().call;
        let args = [
            SqlValue::Text("not json".into()),
            SqlValue::Text("Report".into()),
            SqlValue::Null,
        ];
        assert_eq!(score(&args), SqlValue::Real(0.0));
    }

    #[test]
    fn functions_are_found_by_name_regardless_of_case() {
        assert!(sql_function("DDD_FOLD").is_some());
        assert!(sql_function("nope").is_none());
    }
}

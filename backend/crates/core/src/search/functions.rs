use serde::Serialize;

use super::project::SqlValue;
use super::schema::{FOLD_FUNCTION, fold};

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

pub const SQL_FUNCTIONS: &[SqlFunction] = &[SqlFunction {
    name: FOLD_FUNCTION,
    arity: 1,
    deterministic: true,
    call: fold_value,
}];

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

    #[test]
    fn functions_are_found_by_name_regardless_of_case() {
        assert!(sql_function("DDD_FOLD").is_some());
        assert!(sql_function("nope").is_none());
    }
}

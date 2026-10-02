pub mod ast;
pub mod evaluator;
#[cfg(feature = "mongo")]
pub mod mongo;

pub use ast::{
    CompareOp, FieldPath, Filter, FilterParseError, Literal, SortKey, SortOrder, TextMatch,
};
pub use evaluator::{
    EvalError, FieldRef, Graph, Row, compare_by_key, compare_rows, evaluate, evaluate_in,
    resolve_field,
};
#[cfg(feature = "mongo")]
pub use mongo::{CompileError, compile, compile_sort};

#[cfg(not(feature = "mongo"))]
mod compile_stub {
    use thiserror::Error;

    #[derive(Debug, Clone, PartialEq, Eq, Error)]
    pub enum CompileError {
        #[error("mongo compilation is not available in this build")]
        Unsupported,
    }
}

#[cfg(not(feature = "mongo"))]
pub use compile_stub::CompileError;

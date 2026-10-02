mod builder;
mod doc;
mod engine;
mod plan;
mod snippet;
mod text;

use thiserror::Error;

pub use builder::{Op, Query, lower};
pub use doc::Doc;
pub use engine::{Answer, DEFAULT_CHILDREN_FIELD, Engine, Found, Hit, Page};
pub use plan::{DEFAULT_LIMIT, MAX_LIMIT, Plan, PlanError, Sort, Trash};
pub use snippet::{Range, SNIPPET_MAX_CHARS, Snippet, snippet_for};
pub use text::{TEXT_INDEX_VERSION, TextHit, TextIndex, tokenize};

use crate::filter::{EvalError, FilterParseError};

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum QueryError {
    #[error(transparent)]
    Plan(#[from] PlanError),
    #[error(transparent)]
    Filter(#[from] FilterParseError),
    #[error("{0}")]
    Clause(String),
    #[error(transparent)]
    Eval(#[from] EvalError),
}

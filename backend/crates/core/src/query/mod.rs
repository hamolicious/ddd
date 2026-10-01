//! Querying the workspace: one engine for filter, full-text search, relations and
//! sort, run natively by the server and as wasm by the browser, so a query answers
//! the same wherever it runs.
//!
//! - [`Plan`] (`plan.rs`): a query as JSON, the one shape every caller sends.
//! - [`Query`] (`builder.rs`): the chainable way to write one —
//!   `Query::new().filter("title", Op::TextContains, "a").sort("fm.key")`.
//! - [`Engine`] (`engine.rs`): the rows, their [`TextIndex`] (`text.rs`) and the folder
//!   tree; [`Engine::run`] answers a plan with a page of rows and their [`Snippet`]s
//!   (`snippet.rs`).

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
    /// A filter row the operator cannot take.
    #[error("{0}")]
    Clause(String),
    /// A query bug only running finds: a type mismatch against a fixed column.
    #[error(transparent)]
    Eval(#[from] EvalError),
}

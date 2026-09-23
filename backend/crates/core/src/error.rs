//! Core error type. Parsing itself is tolerant and never errors — these are the
//! hard failures (input over a hard cap, invalid DSL, uncompilable filter).

use thiserror::Error;

use crate::date::DateError;
use crate::filter::{CompileError, EvalError, FilterParseError};

#[derive(Debug, Error)]
pub enum CoreError {
    /// Document text exceeds [`crate::limits::MAX_DOCUMENT_BYTES`].
    #[error("document text too large: {len} bytes (limit {limit})")]
    DocumentTooLarge { len: usize, limit: usize },

    #[error("invalid filter: {0}")]
    FilterParse(#[from] FilterParseError),

    #[error("filter evaluation failed: {0}")]
    FilterEval(#[from] EvalError),

    #[error("filter cannot be compiled: {0}")]
    FilterCompile(#[from] CompileError),

    #[error("invalid date: {0}")]
    Date(#[from] DateError),

    /// A splice target (frontmatter key span, section line) was not found.
    #[error("splice target not found: {0}")]
    SpliceTargetMissing(String),
}

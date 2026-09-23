//! Per-line parse diagnostics. Parsing is tolerant (SPEC §3.4): a malformed
//! line is dropped and recorded here; the remaining keys still parse.

use serde::{Deserialize, Serialize};

/// Why a line or value was dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticKind {
    /// The line is not `key: value` / not parseable as the strict YAML subset.
    MalformedLine,
    /// Key does not match `^[A-Za-z0-9_-]{1,64}$`.
    InvalidKey,
    /// Key seen more than once; last occurrence wins, earlier ones recorded.
    DuplicateKey,
    /// A YAML feature outside the supported subset (anchor, alias, tag, merge
    /// key, block scalar, multi-doc marker).
    UnsupportedFeature,
    /// A hardening cap from [`crate::limits`] was hit.
    LimitExceeded,
    /// Value present but not a supported scalar/flow-sequence shape.
    InvalidValue,
    /// A `%%%` fence was opened but never closed.
    UnterminatedFence,
}

/// One dropped line / rejected value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub kind: DiagnosticKind,
    /// 1-based line number within the whole document text.
    pub line: u32,
    /// The key involved, when known.
    pub key: Option<String>,
    /// Short, stable, human-readable explanation (no positions inside).
    pub message: String,
}

impl Diagnostic {
    pub fn new(
        kind: DiagnosticKind,
        line: u32,
        key: Option<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            line,
            key,
            message: message.into(),
        }
    }
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticKind {
    MalformedLine,
    InvalidKey,
    DuplicateKey,
    UnsupportedFeature,
    LimitExceeded,
    InvalidValue,
    UnterminatedFence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub kind: DiagnosticKind,
    pub line: u32,
    pub key: Option<String>,
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

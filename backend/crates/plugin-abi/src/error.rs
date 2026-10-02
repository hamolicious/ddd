use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    CapabilityDenied,
    Forbidden,
    NotFound,
    Gone,
    AlreadyExists,
    InvalidArgument,
    TooLarge,
    LimitExceeded,
    Reentrancy,
    Timeout,
    Blocked,
    Unavailable,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::CapabilityDenied => "capability_denied",
            ErrorCode::Forbidden => "forbidden",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Gone => "gone",
            ErrorCode::AlreadyExists => "already_exists",
            ErrorCode::InvalidArgument => "invalid_argument",
            ErrorCode::TooLarge => "too_large",
            ErrorCode::LimitExceeded => "limit_exceeded",
            ErrorCode::Reentrancy => "reentrancy",
            ErrorCode::Timeout => "timeout",
            ErrorCode::Blocked => "blocked",
            ErrorCode::Unavailable => "unavailable",
            ErrorCode::Internal => "internal",
        }
    }

    pub fn is_plugin_fault(self) -> bool {
        matches!(
            self,
            ErrorCode::CapabilityDenied
                | ErrorCode::Forbidden
                | ErrorCode::NotFound
                | ErrorCode::Gone
                | ErrorCode::AlreadyExists
                | ErrorCode::InvalidArgument
                | ErrorCode::TooLarge
                | ErrorCode::LimitExceeded
                | ErrorCode::Reentrancy
                | ErrorCode::Blocked
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

impl HostError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn capability_denied(capability: &str) -> Self {
        Self::new(
            ErrorCode::CapabilityDenied,
            format!("capability `{capability}` is not approved for this plugin"),
        )
        .with_detail(serde_json::json!({ "capability": capability }))
    }
}

impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for HostError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_round_trip_through_their_wire_spelling() {
        for code in [
            ErrorCode::CapabilityDenied,
            ErrorCode::Forbidden,
            ErrorCode::NotFound,
            ErrorCode::Gone,
            ErrorCode::AlreadyExists,
            ErrorCode::InvalidArgument,
            ErrorCode::TooLarge,
            ErrorCode::LimitExceeded,
            ErrorCode::Reentrancy,
            ErrorCode::Timeout,
            ErrorCode::Blocked,
            ErrorCode::Unavailable,
            ErrorCode::Internal,
        ] {
            let json = serde_json::to_string(&code).unwrap();
            assert_eq!(json, format!("\"{}\"", code.as_str()));
            let back: ErrorCode = serde_json::from_str(&json).unwrap();
            assert_eq!(back, code);
        }
    }

    #[test]
    fn a_missing_document_never_trips_the_breaker() {
        assert!(ErrorCode::NotFound.is_plugin_fault());
        assert!(!ErrorCode::Timeout.is_plugin_fault());
        assert!(!ErrorCode::Unavailable.is_plugin_fault());
        assert!(!ErrorCode::Internal.is_plugin_fault());
    }
}

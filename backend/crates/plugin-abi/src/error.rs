//! The one error shape, in both directions.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Stable, client-visible error codes. **Append only** — a plugin may match on these,
/// and a renamed code is a breaking ABI change.
///
/// The set is deliberately small and orthogonal. Two distinctions are worth stating
/// because they are easy to collapse and expensive to confuse:
///
/// - [`ErrorCode::CapabilityDenied`] means *the capability is not approved* (the
///   manifest never asked, or the admin said no). [`ErrorCode::Blocked`] means the
///   capability is approved and *this destination* is refused — an undeclared host, a
///   private address. A plugin author reads the first as "my manifest is wrong" and the
///   second as "my URL is wrong".
/// - [`ErrorCode::Forbidden`] is an ownership refusal (rewriting a document another
///   plugin created, calling a plugin that is not a declared dependency), never a
///   capability one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The gating capability is not in the approved set (SPEC §6.2).
    CapabilityDenied,
    /// The target exists but is not this plugin's to touch.
    Forbidden,
    /// No such document, plugin, function or route.
    NotFound,
    /// The document id is in the permanent graveyard (SPEC §3.5).
    Gone,
    /// A document with that id already exists.
    AlreadyExists,
    /// Malformed input: bad JSON, an invalid id, an unparseable filter, a bad key.
    InvalidArgument,
    /// Over a size cap: document text, payload, KV value, HTTP body.
    TooLarge,
    /// Over a rate or count cap: writes per document per minute, call depth, KV keys.
    LimitExceeded,
    /// A call into the same plugin that is already on the call stack.
    Reentrancy,
    /// The host operation ran out of time (the per-invocation deadline, HTTP timeout).
    Timeout,
    /// An outbound destination refused by the host allowlist or the IP policy.
    Blocked,
    /// A dependency is down: Mongo unreachable, callee's circuit breaker open, the
    /// instance pool exhausted.
    Unavailable,
    /// Anything else. The message is safe for a plugin log and never carries server
    /// internals (SPEC: 5xx detail is not leaked).
    Internal,
}

impl ErrorCode {
    /// The wire spelling, for hosts that log the code without serializing the error.
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

    /// `true` when the failure is the plugin's fault rather than the host's.
    ///
    /// The circuit breaker (SPEC §6.3) counts *host-side* failures — timeouts, traps,
    /// unavailability — and must not disable a plugin for honestly reporting that a
    /// document does not exist.
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

/// The error body of [`crate::Envelope::Err`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostError {
    pub code: ErrorCode,
    /// One sentence, safe to log on either side.
    pub message: String,
    /// Structured context: `{"limit": 10, "window_secs": 60}`, `{"host": "…"}`.
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

    /// The canonical refusal for an undeclared or unapproved capability.
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

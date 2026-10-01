//! Document hooks: `document.created`, `document.changed`, `document.deleted`
//! (SPEC §6.3).
//!
//! The rules the payload is shaped by, all of them the host's job to honour:
//!
//! - **At-most-once, fire-and-forget, no retry.** Failures are logged and counted toward
//!   the circuit breaker; nothing is queued for later. A plugin that needs to catch up
//!   after a failure re-reads the workspace on its next cron run — which is why cron and
//!   hooks are both in the design and neither replaces the other.
//! - **Debounced 2 s per document.** A burst of keystrokes is one `document.changed`
//!   carrying the latest state, with [`DocumentEvent::coalesced`] saying how many
//!   changes it stands for.
//! - **Never delivered to the plugin that caused the change.** That is the loop backstop
//!   that matters; the per-plugin-per-document write cap is the one that catches the
//!   loops this does not (two plugins writing to each other's documents).
//! - **Ordering is per-document only.** There is no global hook order, and building on
//!   one is a bug.
//! - **The document body is capability-gated.** Without `documents:read`, a hook payload
//!   carries the id and the origin and nothing else — a hooks-only plugin must not read
//!   the workspace through the side door (SPEC §6.2: "a cron-and-KV plugin can't silently
//!   read the workspace").

use serde::{Deserialize, Serialize};

use crate::Origin;
use crate::documents::DocumentValue;

/// Which hook fired. The wire spelling is the manifest spelling
/// (`"backend": { "hooks": ["document.changed"] }`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HookKind {
    #[serde(rename = "document.created")]
    DocumentCreated,
    #[serde(rename = "document.changed")]
    DocumentChanged,
    #[serde(rename = "document.deleted")]
    DocumentDeleted,
}

impl HookKind {
    pub fn as_str(self) -> &'static str {
        match self {
            HookKind::DocumentCreated => "document.created",
            HookKind::DocumentChanged => "document.changed",
            HookKind::DocumentDeleted => "document.deleted",
        }
    }

    /// The Wasm export the host calls for this hook.
    pub fn export_name(self) -> &'static str {
        match self {
            HookKind::DocumentCreated => crate::names::HOOK_DOCUMENT_CREATED,
            HookKind::DocumentChanged => crate::names::HOOK_DOCUMENT_CHANGED,
            HookKind::DocumentDeleted => crate::names::HOOK_DOCUMENT_DELETED,
        }
    }

    pub fn parse(input: &str) -> Option<Self> {
        match input {
            "document.created" => Some(HookKind::DocumentCreated),
            "document.changed" => Some(HookKind::DocumentChanged),
            "document.deleted" => Some(HookKind::DocumentDeleted),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentEvent {
    pub event: HookKind,
    pub id: String,
    /// Who caused the change. Never this plugin.
    pub origin: Origin,
    /// RFC 3339 UTC of the change the host is reporting (the latest, when coalesced).
    pub at: String,
    /// The change feed sequence number of that change (SPEC §4.1) — the one ordering
    /// number in the system, and a sensible KV cursor.
    pub seq: i64,
    /// How many changes this delivery stands for (≥ 1) after the 2 s debounce.
    #[serde(default = "one")]
    pub coalesced: u32,
    /// The document as it is now. `None` on `document.deleted`, and `None` for a plugin
    /// without `documents:read`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<DocumentValue>,
}

fn one() -> u32 {
    1
}

impl DocumentEvent {
    /// The document, or the [`crate::ErrorCode::CapabilityDenied`] a plugin should report
    /// rather than silently doing nothing.
    pub fn require_document(&self) -> Result<&DocumentValue, crate::HostError> {
        self.document.as_ref().ok_or_else(|| {
            crate::HostError::new(
                crate::ErrorCode::CapabilityDenied,
                "the hook payload carries no document: this plugin has no documents:read capability, \
                 or the document was deleted",
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_names_are_the_manifest_names() {
        assert_eq!(
            serde_json::to_string(&HookKind::DocumentChanged).unwrap(),
            "\"document.changed\""
        );
        assert_eq!(
            HookKind::parse("document.deleted"),
            Some(HookKind::DocumentDeleted)
        );
        assert_eq!(HookKind::parse("document.moved"), None);
        assert_eq!(
            HookKind::DocumentCreated.export_name(),
            "ddd_hook_document_created"
        );
    }

    #[test]
    fn a_payload_without_documents_read_is_still_usable() {
        let event = DocumentEvent {
            event: HookKind::DocumentChanged,
            id: "01J".into(),
            origin: Origin::User { id: "01H".into() },
            at: "2026-09-24T06:00:00Z".into(),
            seq: 42,
            coalesced: 3,
            document: None,
        };
        assert_eq!(event.seq, 42);
        assert_eq!(
            event.require_document().unwrap_err().code,
            crate::ErrorCode::CapabilityDenied
        );
    }
}

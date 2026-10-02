use serde::{Deserialize, Serialize};

use crate::Origin;
use crate::documents::DocumentValue;

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
    pub origin: Origin,
    pub at: String,
    pub seq: i64,
    #[serde(default = "one")]
    pub coalesced: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document: Option<DocumentValue>,
}

fn one() -> u32 {
    1
}

impl DocumentEvent {
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

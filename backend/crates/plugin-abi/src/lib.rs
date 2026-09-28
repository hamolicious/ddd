//! The Life Manager **backend-plugin host ABI**, as types.
//!
//! [`backend/HOST-ABI.md`](../../../HOST-ABI.md) is the prose form of this crate: every
//! host function, its JSON input and output, the hook payloads, the cron and HTTP
//! invocation contracts, the error shape and the limits. The document and this crate
//! change in the same commit — the document is authoritative for *behaviour*, this crate
//! is authoritative for *shape*.
//!
//! **Why a crate and not two copies of some structs.** The server registers the host
//! functions and the plugin calls them; each side would otherwise hand-roll the same
//! JSON, and a silent mismatch in one field name is a plugin that reads `None` forever.
//! One definition, two dependents ([`life-manager-server`] and
//! `life-manager-plugin-sdk`), no conversion layer.
//!
//! **Everything crossing the boundary is JSON.** Extism host functions take and return
//! one memory handle each; this ABI puts a UTF-8 JSON document in it. Binary payloads
//! (an HTTP response body, a webhook body) travel base64-encoded in a named field, so
//! there is exactly one wire format to reason about.
//!
//! **Nothing here traps.** A host function that refuses — a missing capability, a
//! blocked address, a document that is not the caller's to rewrite — returns
//! [`Envelope::Err`], never a Wasm trap: a trap poisons the instance, and SPEC §6.2
//! requires undeclared capabilities to be *erroring stubs* so a plugin can probe for
//! one it does not have.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod call;
pub mod config;
pub mod cron;
pub mod documents;
pub mod error;
pub mod events;
pub mod hooks;
pub mod http;
pub mod kv;
pub mod limits;
pub mod log;
pub mod names;

pub use error::{ErrorCode, HostError};

/// The host ABI version. Bumped **only** for a breaking change (a removed function, a
/// renamed or retyped field); additive fields do not move it.
///
/// One `kernel` semver covers the `@kernel` surface and this ABI (SPEC §6.4). `@kernel`
/// 2.0 removed frontend surface only and left every host function as it was, so the ABI
/// stays at 1 (PLUGIN-PROTOCOLS §10: backend halves get ports later). The install flow
/// checks the manifest's declared range, and the host independently re-checks the
/// module's exported [`names::ABI_VERSION`] — the same belt-and-braces the frontend
/// loader applies to a stale offline bundle.
pub const ABI_VERSION: u32 = 1;

/// A JSON object, as the ABI carries it. `BTreeMap` so serialization is deterministic —
/// two hosts must produce byte-identical payloads for the same state.
pub type JsonMap = BTreeMap<String, Value>;

/// Every host-function result and every plugin-export result.
///
/// ```json
/// {"ok": true,  "value": {…}}
/// {"ok": false, "error": {"code": "capability_denied", "message": "…"}}
/// ```
///
/// Deliberately a struct with a **boolean** `ok` rather than an internally tagged enum:
/// serde's tag would spell the discriminant `"ok": "true"` (a string), and this ABI is
/// language-agnostic — a plugin written in Go or JS must be able to read the obvious
/// thing. `value` and `error` are omitted when empty, so a refusal is exactly
/// `{"ok": false, "error": {…}}`.
/// The `bound` attribute is load-bearing, not decoration: `#[serde(default)]` on a
/// generic field makes serde infer a `T: Default` bound, and then `Envelope<DocumentValue>`
/// would not deserialize. The bound says what is actually required.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(bound(serialize = "T: Serialize", deserialize = "T: Deserialize<'de>"))]
pub struct Envelope<T> {
    pub ok: bool,
    #[serde(default = "Option::default", skip_serializing_if = "Option::is_none")]
    pub value: Option<T>,
    #[serde(default = "Option::default", skip_serializing_if = "Option::is_none")]
    pub error: Option<HostError>,
}

impl<T> Envelope<T> {
    /// Wrap a value.
    pub fn ok(value: T) -> Self {
        Self {
            ok: true,
            value: Some(value),
            error: None,
        }
    }

    /// The no-value success (`{"ok": true}`) — what a hook returns.
    pub fn empty() -> Self {
        Self {
            ok: true,
            value: None,
            error: None,
        }
    }

    /// Wrap a refusal.
    pub fn err(error: HostError) -> Self {
        Self {
            ok: false,
            value: None,
            error: Some(error),
        }
    }

    /// `Ok(value)` / `Err(error)`; a success with no value yields `Ok(None)`.
    ///
    /// A malformed envelope (`ok: false` with no error) is reported as
    /// [`ErrorCode::Internal`] rather than silently read as success — the one case where
    /// being strict about the host's own output is worth a line of code.
    pub fn into_result(self) -> Result<Option<T>, HostError> {
        if self.ok {
            Ok(self.value)
        } else {
            Err(self.error.unwrap_or_else(|| {
                HostError::new(ErrorCode::Internal, "host returned a refusal with no error")
            }))
        }
    }
}

/// Who caused something the host is reporting: a hook's originating actor, or the
/// caller of an invoked function.
///
/// Mirrors `domain::Actor` on the server side (`user` / `plugin:<id>` / `system`) but is
/// a *structured* value here, because a plugin comparing `origin.id` against its own id
/// is the mechanism that stops hook loops (SPEC §6.3) and string-splitting a stored form
/// to do it would be a footgun.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Origin {
    /// A logged-in user applied the change.
    User { id: String },
    /// Another backend plugin applied it. Never the receiving plugin itself: the host
    /// does not deliver a hook to the plugin that caused the change.
    Plugin { id: String },
    /// The server itself (seeding, migration, restore, compaction).
    System,
}

impl Origin {
    /// `true` when this origin is the plugin `plugin_id`.
    pub fn is_plugin(&self, plugin_id: &str) -> bool {
        matches!(self, Origin::Plugin { id } if id == plugin_id)
    }
}

/// What the host tells a plugin about itself, once, at activation (`lm_init`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitPayload {
    /// The plugin's own id — the same string the host uses for its `%%%` section, its
    /// KV namespace and its `plugin:<id>` actor.
    pub plugin_id: String,
    pub version: String,
    /// The host's [`ABI_VERSION`].
    pub abi_version: u32,
    /// Approved capabilities, as the admin approved them (not as the manifest asked).
    /// A plugin can therefore degrade gracefully instead of discovering a denial per
    /// call.
    pub capabilities: Capabilities,
    /// Config keys that currently have a value. Values are **not** included — secrets
    /// are fetched deliberately through `config_get`, never pushed.
    pub config_keys: Vec<String>,
}

/// The approved capability set (SPEC §6.2), as the host reports it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    /// `["read"]`, `["read","write"]`, or empty.
    #[serde(default)]
    pub documents: Vec<String>,
    /// Declared outbound hosts; empty ⇒ `http_request` is an erroring stub.
    #[serde(default)]
    pub http_hosts: Vec<String>,
    /// Route paths served without a session (SPEC §5.1).
    #[serde(default)]
    pub public_routes: Vec<String>,
    /// Native-bridge notifications (frontend-side; carried here for completeness).
    #[serde(default)]
    pub notifications: bool,
}

impl Capabilities {
    pub fn can_read_documents(&self) -> bool {
        self.documents.iter().any(|c| c == "read")
    }

    pub fn can_write_documents(&self) -> bool {
        self.documents.iter().any(|c| c == "write")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_envelope_discriminates_on_ok() {
        let ok: Envelope<u32> = Envelope::ok(7);
        assert_eq!(
            serde_json::to_string(&ok).unwrap(),
            r#"{"ok":true,"value":7}"#
        );
        assert_eq!(
            serde_json::to_string(&Envelope::<u32>::empty()).unwrap(),
            r#"{"ok":true}"#
        );

        let err: Envelope<u32> = Envelope::err(HostError::new(
            ErrorCode::CapabilityDenied,
            "documents:read is not approved",
        ));
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains(r#""ok":false"#));
        assert!(json.contains(r#""code":"capability_denied""#));

        let round: Envelope<u32> = serde_json::from_str(&json).unwrap();
        assert!(round.into_result().is_err());
    }

    #[test]
    fn an_origin_identifies_the_plugin_that_must_not_be_notified() {
        let origin = Origin::Plugin {
            id: "calendar".to_string(),
        };
        assert!(origin.is_plugin("calendar"));
        assert!(!origin.is_plugin("agenda"));
        assert!(!Origin::System.is_plugin("calendar"));
        assert_eq!(
            serde_json::to_string(&origin).unwrap(),
            r#"{"kind":"plugin","id":"calendar"}"#
        );
    }
}

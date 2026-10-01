//! The raw host imports and the one helper that calls them.
//!
//! Every host function has the same shape — one JSON string in, one JSON
//! [`Envelope`](crate::abi::Envelope) out — which is why this file is short and why
//! adding a host function is a two-line change on this side.
//!
//! The imports live in Extism's `extism:host/user` namespace, so they cannot collide with
//! a plugin's own exports. **All of them are always linked**: the host registers an
//! erroring stub for anything the plugin has no capability for, so instantiation never
//! fails on imports (SPEC §6.2) and probing for a capability is a normal call that
//! returns [`ErrorCode::CapabilityDenied`](crate::ErrorCode::CapabilityDenied).

use extism_pdk::host_fn;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::abi::{Envelope, ErrorCode, HostError};

#[host_fn]
unsafe extern "ExtismHost" {
    pub(crate) fn get_document(input: String) -> String;
    pub(crate) fn query_documents(input: String) -> String;
    pub(crate) fn query(input: String) -> String;
    pub(crate) fn create_document(input: String) -> String;
    pub(crate) fn splice_section(input: String) -> String;
    pub(crate) fn rewrite_document(input: String) -> String;
    pub(crate) fn kv_get(input: String) -> String;
    pub(crate) fn kv_set(input: String) -> String;
    pub(crate) fn config_get(input: String) -> String;
    pub(crate) fn emit(input: String) -> String;
    pub(crate) fn emit_client(input: String) -> String;
    pub(crate) fn call_plugin(input: String) -> String;
    pub(crate) fn http_request(input: String) -> String;
    pub(crate) fn log(input: String) -> String;
}

/// A host import, as a function pointer — the generated wrappers all share this type,
/// which is what lets [`call`] be written once.
pub(crate) type HostImport = unsafe fn(String) -> Result<String, extism_pdk::Error>;

/// Serialize `input`, call `host`, and unwrap the envelope.
///
/// Three failure modes, all mapped to [`HostError`] rather than a panic: our own
/// serialization (`internal` — a bug in this SDK), the Extism call itself (`internal` — a
/// poisoned instance or a host that trapped), and the host's refusal (its own code).
pub(crate) fn call<I: Serialize, O: DeserializeOwned>(
    host: HostImport,
    input: &I,
) -> crate::Result<Option<O>> {
    let payload = serde_json::to_string(input).map_err(|err| {
        HostError::new(
            ErrorCode::Internal,
            format!("could not serialize the host-call input: {err}"),
        )
    })?;

    // SAFETY: the import takes and returns an Extism memory handle; the PDK's generated
    // wrapper owns that handle's lifetime. Nothing here dereferences a pointer.
    let raw = unsafe { host(payload) }.map_err(|err| {
        HostError::new(
            ErrorCode::Internal,
            format!("the host call failed: {err:#}"),
        )
    })?;

    let envelope: Envelope<O> = serde_json::from_str(&raw).map_err(|err| {
        HostError::new(
            ErrorCode::Internal,
            format!("the host returned an envelope this SDK cannot read: {err}"),
        )
    })?;
    envelope.into_result()
}

/// [`call`], for a host function that always answers with a value.
pub(crate) fn call_value<I: Serialize, O: DeserializeOwned>(
    host: HostImport,
    input: &I,
) -> crate::Result<O> {
    call(host, input)?.ok_or_else(|| {
        HostError::new(
            ErrorCode::Internal,
            "the host reported success but returned no value",
        )
    })
}

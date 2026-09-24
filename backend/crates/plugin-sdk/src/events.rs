//! Events: the server bus ([`emit`]) and the browsers ([`emit_client`]).
//!
//! Ephemeral, fire-and-forget, no replay. A client that was closed missed it — which is
//! why state belongs in documents and events are for nudges (SPEC §1, §6.3).

use serde::Serialize;

use crate::abi::events::{EmitClientInput, EmitClientOutput, EmitInput, EmitOutput};
use crate::abi::{ErrorCode, HostError};
use crate::host::{self, call_value};

fn to_value<T: Serialize>(payload: &T) -> crate::Result<serde_json::Value> {
    serde_json::to_value(payload).map_err(|err| {
        HostError::new(
            ErrorCode::InvalidArgument,
            format!("the event payload would not serialize: {err}"),
        )
    })
}

/// Publish on the server bus. The host prefixes your plugin id: `emit("synced")` is
/// published as `calendar:synced`, and is never delivered back to you.
pub fn emit<T: Serialize>(event: &str, payload: &T) -> crate::Result<EmitOutput> {
    call_value(
        host::emit,
        &EmitInput {
            event: event.to_string(),
            payload: to_value(payload)?,
        },
    )
}

/// Relay to every connected session, as `plugin:<your-id>:<event>`.
pub fn emit_client<T: Serialize>(event: &str, payload: &T) -> crate::Result<EmitClientOutput> {
    call_value(
        host::emit_client,
        &EmitClientInput {
            event: event.to_string(),
            payload: to_value(payload)?,
            user_id: None,
        },
    )
}

/// Relay to one user's sessions only.
pub fn emit_client_to<T: Serialize>(
    user_id: &str,
    event: &str,
    payload: &T,
) -> crate::Result<EmitClientOutput> {
    call_value(
        host::emit_client,
        &EmitClientInput {
            event: event.to_string(),
            payload: to_value(payload)?,
            user_id: Some(user_id.to_string()),
        },
    )
}

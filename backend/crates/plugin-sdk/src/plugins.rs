//! `call_plugin` — calling another backend half's `lm_call` export.
//!
//! The callee must be in your manifest's `dependencies` (or `optionalDependencies`) at a
//! version in range, and the function in the callee's `backend.exports`; the chain may be
//! three deep; and a plugin already on the stack cannot be re-entered (SPEC §6.3). All are
//! the host's checks, reported as
//! [`Forbidden`](crate::ErrorCode::Forbidden) /
//! [`LimitExceeded`](crate::ErrorCode::LimitExceeded) /
//! [`Reentrancy`](crate::ErrorCode::Reentrancy).

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::abi::call::{CallPluginInput, CallPluginOutput};
use crate::abi::{ErrorCode, HostError};
use crate::host::{self, call_value};

/// Call `function` on `plugin` and deserialize its answer.
pub fn call<I: Serialize, O: DeserializeOwned>(
    plugin: &str,
    function: &str,
    payload: &I,
) -> crate::Result<O> {
    let payload = serde_json::to_value(payload).map_err(|err| {
        HostError::new(
            ErrorCode::InvalidArgument,
            format!("the call payload would not serialize: {err}"),
        )
    })?;
    let output: CallPluginOutput = call_value(
        host::call_plugin,
        &CallPluginInput {
            plugin: plugin.to_string(),
            function: function.to_string(),
            payload,
        },
    )?;
    serde_json::from_value(output.value).map_err(|err| {
        HostError::new(
            ErrorCode::InvalidArgument,
            format!("`{plugin}:{function}` answered with an unexpected shape: {err}"),
        )
    })
}

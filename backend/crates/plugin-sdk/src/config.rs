//! Admin-entered configuration, secrets included — no capability required.
//!
//! Values declared `secret: true` in the manifest arrive decrypted. Two habits worth
//! keeping: fetch a secret at the moment you need it (an instance that never asks never
//! holds it), and never log one — the host cannot know which of your strings came from
//! here.

use crate::abi::config::{ConfigGetInput, ConfigGetOutput};
use crate::abi::{ErrorCode, HostError};
use crate::host::{self, call_value};

/// Every configured value.
pub fn all() -> crate::Result<ConfigGetOutput> {
    call_value(host::config_get, &ConfigGetInput { key: None })
}

/// One value, or `None` when the admin has not set it.
pub fn get(key: &str) -> crate::Result<Option<serde_json::Value>> {
    let output: ConfigGetOutput = call_value(
        host::config_get,
        &ConfigGetInput {
            key: Some(key.to_string()),
        },
    )?;
    Ok(output.values.get(key).cloned())
}

/// One string value, or `None`.
pub fn string(key: &str) -> crate::Result<Option<String>> {
    Ok(get(key)?
        .as_ref()
        .and_then(|value| value.as_str())
        .map(str::to_string))
}

/// One string value, or [`ErrorCode::InvalidArgument`](crate::ErrorCode::InvalidArgument)
/// naming the key.
///
/// The right error for "not configured yet": it tells an operator reading the admin
/// screen exactly which field to fill in, and it does not trip the circuit breaker
/// ([`ErrorCode::is_plugin_fault`](crate::abi::ErrorCode::is_plugin_fault)) — a plugin
/// waiting to be configured is not a broken plugin.
pub fn require_string(key: &str) -> crate::Result<String> {
    string(key)?.ok_or_else(|| {
        HostError::new(
            ErrorCode::InvalidArgument,
            format!("`{key}` is not configured (admin → plugins → config)"),
        )
    })
}

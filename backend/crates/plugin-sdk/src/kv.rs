//! Plugin-scoped key/value state — no capability required.
//!
//! Where a sync cursor, an ETag or a `last_seen` marker belongs. **Not** where a document
//! belongs: KV is invisible to clients, unsearchable and not synced (SPEC §3.3, §6.3).

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::abi::kv::{KvGetInput, KvGetOutput, KvSetInput, KvSetOutput};
use crate::abi::{ErrorCode, HostError};
use crate::host::{self, call_value};

/// Read a key, deserialized into `T`. `Ok(None)` when the key is absent.
pub fn get<T: DeserializeOwned>(key: &str) -> crate::Result<Option<T>> {
    let output: KvGetOutput = call_value(
        host::kv_get,
        &KvGetInput {
            key: key.to_string(),
        },
    )?;
    match output.value {
        None => Ok(None),
        Some(value) => serde_json::from_value(value).map(Some).map_err(|err| {
            HostError::new(
                ErrorCode::InvalidArgument,
                format!("the stored value for `{key}` is not the expected shape: {err}"),
            )
        }),
    }
}

/// Read a key as a string, the common case.
pub fn get_string(key: &str) -> crate::Result<Option<String>> {
    get::<String>(key)
}

/// Write a key.
pub fn set<T: Serialize>(key: &str, value: &T) -> crate::Result<KvSetOutput> {
    let value = serde_json::to_value(value).map_err(|err| {
        HostError::new(
            ErrorCode::InvalidArgument,
            format!("the value for `{key}` would not serialize: {err}"),
        )
    })?;
    call_value(
        host::kv_set,
        &KvSetInput {
            key: key.to_string(),
            value: Some(value),
            remove: false,
        },
    )
}

/// Delete a key. Deleting an absent key succeeds.
pub fn remove(key: &str) -> crate::Result<KvSetOutput> {
    call_value(
        host::kv_set,
        &KvSetInput {
            key: key.to_string(),
            value: None,
            remove: true,
        },
    )
}

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::abi::kv::{KvGetInput, KvGetOutput, KvSetInput, KvSetOutput};
use crate::abi::{ErrorCode, HostError};
use crate::host::{self, call_value};

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

pub fn get_string(key: &str) -> crate::Result<Option<String>> {
    get::<String>(key)
}

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

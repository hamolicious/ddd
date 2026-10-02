use crate::abi::config::{ConfigGetInput, ConfigGetOutput};
use crate::abi::{ErrorCode, HostError};
use crate::host::{self, call_value};

pub fn all() -> crate::Result<ConfigGetOutput> {
    call_value(host::config_get, &ConfigGetInput { key: None })
}

pub fn get(key: &str) -> crate::Result<Option<serde_json::Value>> {
    let output: ConfigGetOutput = call_value(
        host::config_get,
        &ConfigGetInput {
            key: Some(key.to_string()),
        },
    )?;
    Ok(output.values.get(key).cloned())
}

pub fn string(key: &str) -> crate::Result<Option<String>> {
    Ok(get(key)?
        .as_ref()
        .and_then(|value| value.as_str())
        .map(str::to_string))
}

pub fn require_string(key: &str) -> crate::Result<String> {
    string(key)?.ok_or_else(|| {
        HostError::new(
            ErrorCode::InvalidArgument,
            format!("`{key}` is not configured (admin → plugins → config)"),
        )
    })
}

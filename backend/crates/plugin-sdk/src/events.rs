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

pub fn emit<T: Serialize>(event: &str, payload: &T) -> crate::Result<EmitOutput> {
    call_value(
        host::emit,
        &EmitInput {
            event: event.to_string(),
            payload: to_value(payload)?,
        },
    )
}

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

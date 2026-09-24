//! The export side: read the host's JSON input, run the handler, write a JSON envelope.
//!
//! **A refused call is a successful Wasm call.** The dispatchers return `0` even when the
//! handler errors, with `{"ok": false, "error": …}` as the output — the host reads the
//! envelope and logs the code. A non-zero return (or a trap) is reserved for "this
//! instance is broken", which is what the circuit breaker counts (SPEC §6.3).
//!
//! Nothing here panics on bad input: a payload this SDK cannot parse comes back as
//! [`ErrorCode::InvalidArgument`], because a panic in a Wasm module is a trap, a trap
//! poisons the instance, and "the host sent me something odd" does not deserve that.

use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::abi::{Envelope, ErrorCode, HostError};

/// Run a handler that takes a typed payload and answers with a typed value.
pub fn dispatch<I, O, F>(handler: F) -> i32
where
    I: DeserializeOwned,
    O: Serialize,
    F: FnOnce(I) -> crate::Result<O>,
{
    let envelope = match parse::<I>() {
        Ok(payload) => match handler(payload) {
            Ok(value) => Envelope::ok(value),
            Err(error) => Envelope::err(error),
        },
        Err(error) => Envelope::err(error),
    };
    emit(&envelope)
}

/// Run a handler with no return value — a hook, a cron run, an event.
pub fn dispatch_unit<I, F>(handler: F) -> i32
where
    I: DeserializeOwned,
    F: FnOnce(I) -> crate::Result<()>,
{
    let envelope: Envelope<serde_json::Value> = match parse::<I>() {
        Ok(payload) => match handler(payload) {
            Ok(()) => Envelope::empty(),
            Err(error) => Envelope::err(error),
        },
        Err(error) => Envelope::err(error),
    };
    emit(&envelope)
}

/// Answer with a constant — what [`crate::abi_version!`] exports.
pub fn emit_value<T: Serialize>(value: &T) -> i32 {
    emit(&Envelope::ok(value))
}

fn parse<I: DeserializeOwned>() -> crate::Result<I> {
    let bytes = extism_pdk::input_bytes();
    serde_json::from_slice(&bytes).map_err(|err| {
        HostError::new(
            ErrorCode::InvalidArgument,
            format!("the payload did not match what this export expects: {err}"),
        )
    })
}

fn emit<T: Serialize>(envelope: &Envelope<T>) -> i32 {
    let json = match serde_json::to_string(envelope) {
        Ok(json) => json,
        // The handler's own value would not serialize. Report that as an envelope rather
        // than losing the call: a plugin whose output type is wrong should see a message,
        // not a silent zero-length answer.
        Err(err) => format!(
            r#"{{"ok":false,"error":{{"code":"internal","message":"the plugin's return value would not serialize: {}"}}}}"#,
            escape(&err.to_string())
        ),
    };
    match extism_pdk::output(&json) {
        Ok(()) => 0,
        Err(_) => -1,
    }
}

/// Minimal JSON string escaping for the one hand-built envelope above.
fn escape(input: &str) -> String {
    input
        .chars()
        .filter(|c| !c.is_control())
        .flat_map(|c| match c {
            '"' => vec!['\\', '"'],
            '\\' => vec!['\\', '\\'],
            other => vec![other],
        })
        .collect()
}

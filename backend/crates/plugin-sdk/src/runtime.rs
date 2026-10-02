use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::abi::{Envelope, ErrorCode, HostError};

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

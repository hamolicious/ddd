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

pub(crate) type HostImport = unsafe fn(String) -> Result<String, extism_pdk::Error>;

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

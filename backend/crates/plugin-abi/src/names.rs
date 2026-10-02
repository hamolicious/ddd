pub const GET_DOCUMENT: &str = "get_document";
pub const QUERY_DOCUMENTS: &str = "query_documents";
pub const QUERY: &str = "query";
pub const CREATE_DOCUMENT: &str = "create_document";
pub const SPLICE_SECTION: &str = "splice_section";
pub const REWRITE_DOCUMENT: &str = "rewrite_document";
pub const KV_GET: &str = "kv_get";
pub const KV_SET: &str = "kv_set";
pub const CONFIG_GET: &str = "config_get";
pub const EMIT: &str = "emit";
pub const EMIT_CLIENT: &str = "emit_client";
pub const CALL_PLUGIN: &str = "call_plugin";
pub const HTTP_REQUEST: &str = "http_request";
pub const LOG: &str = "log";

pub const HOST_FUNCTIONS: &[&str] = &[
    GET_DOCUMENT,
    QUERY_DOCUMENTS,
    QUERY,
    CREATE_DOCUMENT,
    SPLICE_SECTION,
    REWRITE_DOCUMENT,
    KV_GET,
    KV_SET,
    CONFIG_GET,
    EMIT,
    EMIT_CLIENT,
    CALL_PLUGIN,
    HTTP_REQUEST,
    LOG,
];

pub const ABI_VERSION: &str = "ddd_abi_version";

pub const INIT: &str = "ddd_init";

pub const HOOK_DOCUMENT_CREATED: &str = "ddd_hook_document_created";
pub const HOOK_DOCUMENT_CHANGED: &str = "ddd_hook_document_changed";
pub const HOOK_DOCUMENT_DELETED: &str = "ddd_hook_document_deleted";

pub const CRON: &str = "ddd_cron";
pub const HTTP: &str = "ddd_http";
pub const CALL: &str = "ddd_call";
pub const EVENT: &str = "ddd_event";

pub const EXPORTS: &[&str] = &[
    ABI_VERSION,
    INIT,
    HOOK_DOCUMENT_CREATED,
    HOOK_DOCUMENT_CHANGED,
    HOOK_DOCUMENT_DELETED,
    CRON,
    HTTP,
    CALL,
    EVENT,
];

pub const CLIENT_EVENT_MESSAGE: &str = "plugin.event";

pub const CLIENT_EVENT_PREFIX: &str = "plugin:";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_name_is_listed_exactly_once() {
        let mut sorted = HOST_FUNCTIONS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), HOST_FUNCTIONS.len());

        let mut exports = EXPORTS.to_vec();
        exports.sort_unstable();
        exports.dedup();
        assert_eq!(exports.len(), EXPORTS.len());
        assert!(EXPORTS.iter().all(|name| name.starts_with("ddd_")));
    }
}

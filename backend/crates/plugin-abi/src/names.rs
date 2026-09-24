//! Every name on the boundary, in one place: the host functions a plugin imports and the
//! functions a plugin exports.
//!
//! Both sides read these constants instead of spelling the strings. A typo in an import
//! name is a stub that always errors; a typo in an export name is a hook that never
//! fires — two failures that look like logic bugs for a long time.

// ---------------------------------------------------------------------------
// Host functions (plugin imports). Extism puts these in the `extism:host/user`
// namespace, so they cannot collide with a plugin's own exports.
// ---------------------------------------------------------------------------

pub const GET_DOCUMENT: &str = "get_document";
pub const QUERY_DOCUMENTS: &str = "query_documents";
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

/// Every host function, in the order `backend/HOST-ABI.md` documents them.
///
/// **All twelve plus `log` are linked into every instance**, declared or not: an
/// undeclared one is linked as an *erroring stub* (SPEC §6.2), so instantiation never
/// fails on imports and a plugin may probe for a capability it does not have.
pub const HOST_FUNCTIONS: &[&str] = &[
    GET_DOCUMENT,
    QUERY_DOCUMENTS,
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

// ---------------------------------------------------------------------------
// Plugin exports. Fixed names, one per kind of invocation — a plugin never chooses
// an export name, because the host has to find it without reading Rust.
// ---------------------------------------------------------------------------

/// `() -> u32` (as JSON): the ABI version the module was built against. **Required** for
/// any plugin with a backend half; the install flow refuses a module without it, and the
/// host re-checks it at activation (the same stale-bundle guard the frontend loader
/// applies, SPEC §6.4).
pub const ABI_VERSION: &str = "lm_abi_version";

/// Optional. Called once per instance, with [`crate::InitPayload`], before any other
/// export. A refusal marks the plugin failed.
pub const INIT: &str = "lm_init";

pub const HOOK_DOCUMENT_CREATED: &str = "lm_hook_document_created";
pub const HOOK_DOCUMENT_CHANGED: &str = "lm_hook_document_changed";
pub const HOOK_DOCUMENT_DELETED: &str = "lm_hook_document_deleted";

/// [`crate::cron::CronPayload`] in, `null` out.
pub const CRON: &str = "lm_cron";
/// [`crate::http::HttpRouteRequest`] in, [`crate::http::HttpRouteResponse`] out.
pub const HTTP: &str = "lm_http";
/// [`crate::call::CallPayload`] in, any JSON out.
pub const CALL: &str = "lm_call";
/// [`crate::events::EventPayload`] in, `null` out.
pub const EVENT: &str = "lm_event";

/// Every export the host may call.
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

/// The sync-socket message type that carries an `emit_client` event to browsers
/// (PROTOCOL.md §9 — a client ignores unknown `t` values, so this is additive).
pub const CLIENT_EVENT_MESSAGE: &str = "plugin.event";

/// The client-side event type prefix: `plugin:<id>:<event>`.
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
        assert!(EXPORTS.iter().all(|name| name.starts_with("lm_")));
    }
}

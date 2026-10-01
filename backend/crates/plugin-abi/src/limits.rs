//! Every limit the host enforces, as constants both sides can read.
//!
//! A plugin that knows the caps can respect them (page a query, chunk a write) instead of
//! discovering them as errors. The host is still the enforcer — these are not advice —
//! but a limit a plugin cannot see is a limit it will hit.
//!
//! Values marked *admin-configurable* may be **lowered** by configuration, never raised:
//! a workspace operator can tighten the sandbox, and a plugin author cannot loosen it.

// ---------------------------------------------------------------------------
// Invocation: time, memory, concurrency (SPEC §6.3 "Resource limits")
// ---------------------------------------------------------------------------

/// Per-call wall clock for a hook, an HTTP route or an invoked call. Admin-configurable
/// (`PLUGIN_CALL_TIMEOUT_MS`).
pub const CALL_TIMEOUT_MS: u64 = 5_000;
/// Per-call wall clock for a cron run — the job that is allowed to be slow
/// (`PLUGIN_CRON_TIMEOUT_MS`).
pub const CRON_CALL_TIMEOUT_MS: u64 = 60_000;
/// Linear memory per instance (`PLUGIN_MEMORY_BYTES`).
pub const MEMORY_BYTES: u64 = 128 * 1024 * 1024;
/// Epoch tick. The interruption granularity: a plugin in a tight loop is stopped within
/// one tick of its deadline.
pub const EPOCH_TICK_MS: u64 = 10;
/// Instances kept warm per plugin. Extism calls are not reentrant, so this is also the
/// per-plugin concurrency.
pub const MAX_INSTANCES_PER_PLUGIN: usize = 4;
/// How long a caller waits for a free instance before [`crate::ErrorCode::Unavailable`].
pub const POOL_ACQUIRE_TIMEOUT_MS: u64 = 1_000;
/// Idle instances are dropped after this.
pub const INSTANCE_IDLE_TIMEOUT_SECS: u64 = 300;
/// Consecutive failures or timeouts that open the circuit breaker. Re-enabling is a
/// manual admin action (SPEC §6.3).
pub const BREAKER_FAILURE_THRESHOLD: u32 = 5;
/// `call_plugin` chain depth, counting the top-level invocation as 0.
pub const MAX_CALL_DEPTH: u32 = 3;

// ---------------------------------------------------------------------------
// Host-function payload sizes
// ---------------------------------------------------------------------------

/// Largest JSON a plugin may hand a host function.
pub const MAX_HOST_INPUT_BYTES: usize = 2 * 1024 * 1024;
/// Largest JSON a host function returns. Sized for a 10 MB HTTP body base64-encoded
/// (≈13.4 MB) plus its metadata — the one genuinely large answer in the ABI.
pub const MAX_HOST_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/// Rows per `query_documents` page when the caller does not say.
pub const DEFAULT_QUERY_LIMIT: u32 = 50;
/// Hard ceiling per page; a bigger `limit` is clamped, not refused.
pub const MAX_QUERY_LIMIT: u32 = 200;
/// Document writes (create + splice + rewrite) inside **one** invocation. The
/// first-sync-of-a-big-calendar case is why this is per call and not per minute.
pub const MAX_WRITES_PER_CALL: u32 = 500;
/// Writes by one plugin to one document per minute — the loop backstop of SPEC §6.3.
pub const MAX_WRITES_PER_DOCUMENT_PER_MINUTE: u32 = 10;
/// Document text cap; the same number `core::limits::MAX_DOCUMENT_BYTES` enforces, and
/// the reason it is restated rather than imported is that a plugin links this crate and
/// not the shared core.
pub const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
/// Section line edits per `splice_section` call.
pub const MAX_SECTION_EDITS: usize = 200;

// ---------------------------------------------------------------------------
// KV
// ---------------------------------------------------------------------------

pub const MAX_KV_KEY_BYTES: usize = 256;
pub const MAX_KV_VALUE_BYTES: usize = 64 * 1024;
pub const MAX_KV_KEYS_PER_PLUGIN: u32 = 1_000;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

pub const MAX_EVENT_PAYLOAD_BYTES: usize = 64 * 1024;
pub const MAX_EVENT_NAME_BYTES: usize = 64;

// ---------------------------------------------------------------------------
// HTTP, both directions (SPEC §6.2)
// ---------------------------------------------------------------------------

pub const HTTP_TIMEOUT_MS: u64 = 10_000;
/// Outbound requests inside **one** invocation.
///
/// The counterpart of [`MAX_WRITES_PER_CALL`], and it exists for the same reason: without a
/// number, the only thing bounding a loop of `http_request` was the wall clock, and a cron
/// invocation has 60 s of it. That made the server a request amplifier aimed at whatever host
/// an admin approved for a nightly feed fetch — thousands of requests a run — and reachable
/// once per inbound request rather than once a day on a plugin with a public route.
///
/// Generous on purpose: 100 is far more than the feed-fetch-and-follow-redirects shape this
/// capability exists for (the calendar makes one request per run), and far less than a loop.
/// A plugin that genuinely needs to page through an API spreads the pages across cron runs,
/// which is the same answer `MAX_WRITES_PER_CALL` gives.
pub const MAX_HTTP_REQUESTS_PER_CALL: u32 = 100;
pub const MAX_HTTP_RESPONSE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_HTTP_REQUEST_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_HTTP_REDIRECTS: u32 = 3;
pub const MAX_HTTP_REQUEST_HEADERS: usize = 32;
pub const MAX_HTTP_HEADER_BYTES: usize = 4 * 1024;
/// Inbound route body cap, and the cap on what `ddd_http` may answer with.
pub const MAX_ROUTE_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_ROUTE_RESPONSE_HEADERS: usize = 16;
/// Requests per minute per plugin route, per client (SPEC §5.1 "rate-limited").
pub const ROUTE_REQUESTS_PER_MINUTE: u32 = 120;

// ---------------------------------------------------------------------------
// Package (SPEC §6.2 zip hardening)
// ---------------------------------------------------------------------------

pub const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_PACKAGE_UNCOMPRESSED_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_PACKAGE_ENTRIES: usize = 2_000;
pub const MAX_PACKAGE_ENTRY_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
pub const MAX_BACKEND_WASM_BYTES: u64 = 25 * 1024 * 1024;

#[cfg(test)]
mod tests {
    #[test]
    fn the_output_cap_fits_the_largest_legal_http_body() {
        // base64 is 4 bytes per 3, plus the envelope. If this ever stops holding, an
        // allowed 10 MB feed becomes an unexplainable `too_large`.
        let encoded = super::MAX_HTTP_RESPONSE_BYTES.div_ceil(3) * 4;
        assert!(encoded < super::MAX_HOST_OUTPUT_BYTES as u64);
    }

    #[test]
    fn cron_gets_more_time_than_a_hook() {
        const _: () = assert!(super::CRON_CALL_TIMEOUT_MS > super::CALL_TIMEOUT_MS);
        const _: () = assert!(super::MAX_QUERY_LIMIT >= super::DEFAULT_QUERY_LIMIT);
    }
}

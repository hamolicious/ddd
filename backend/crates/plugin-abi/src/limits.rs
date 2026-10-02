pub const CALL_TIMEOUT_MS: u64 = 5_000;
pub const CRON_CALL_TIMEOUT_MS: u64 = 60_000;
pub const MEMORY_BYTES: u64 = 128 * 1024 * 1024;
pub const EPOCH_TICK_MS: u64 = 10;
pub const MAX_INSTANCES_PER_PLUGIN: usize = 4;
pub const POOL_ACQUIRE_TIMEOUT_MS: u64 = 1_000;
pub const INSTANCE_IDLE_TIMEOUT_SECS: u64 = 300;
pub const BREAKER_FAILURE_THRESHOLD: u32 = 5;
pub const MAX_CALL_DEPTH: u32 = 3;

pub const MAX_HOST_INPUT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_HOST_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

pub const DEFAULT_QUERY_LIMIT: u32 = 50;
pub const MAX_QUERY_LIMIT: u32 = 200;
pub const MAX_WRITES_PER_CALL: u32 = 500;
pub const MAX_WRITES_PER_DOCUMENT_PER_MINUTE: u32 = 10;
pub const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
pub const MAX_SECTION_EDITS: usize = 200;

pub const MAX_KV_KEY_BYTES: usize = 256;
pub const MAX_KV_VALUE_BYTES: usize = 64 * 1024;
pub const MAX_KV_KEYS_PER_PLUGIN: u32 = 1_000;

pub const MAX_EVENT_PAYLOAD_BYTES: usize = 64 * 1024;
pub const MAX_EVENT_NAME_BYTES: usize = 64;

pub const HTTP_TIMEOUT_MS: u64 = 10_000;
pub const MAX_HTTP_REQUESTS_PER_CALL: u32 = 100;
pub const MAX_HTTP_RESPONSE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_HTTP_REQUEST_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_HTTP_REDIRECTS: u32 = 3;
pub const MAX_HTTP_REQUEST_HEADERS: usize = 32;
pub const MAX_HTTP_HEADER_BYTES: usize = 4 * 1024;
pub const MAX_ROUTE_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_ROUTE_RESPONSE_HEADERS: usize = 16;
pub const ROUTE_REQUESTS_PER_MINUTE: u32 = 120;

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
        let encoded = super::MAX_HTTP_RESPONSE_BYTES.div_ceil(3) * 4;
        assert!(encoded < super::MAX_HOST_OUTPUT_BYTES as u64);
    }

    #[test]
    fn cron_gets_more_time_than_a_hook() {
        const _: () = assert!(super::CRON_CALL_TIMEOUT_MS > super::CALL_TIMEOUT_MS);
        const _: () = assert!(super::MAX_QUERY_LIMIT >= super::DEFAULT_QUERY_LIMIT);
    }
}

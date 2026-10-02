use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use ddd_plugin_abi as abi;

use crate::config::Config;

pub const WRITE_WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PluginLimits {
    pub call_timeout: Duration,
    pub cron_timeout: Duration,
    pub memory_bytes: u64,
    pub max_instances: usize,
    pub pool_acquire_timeout: Duration,
    pub instance_idle_timeout: Duration,
    pub breaker_threshold: u32,
    pub http_timeout: Duration,
    pub max_http_response_bytes: u64,
    pub writes_per_call: u32,
    pub http_requests_per_call: u32,
    pub writes_per_document_per_minute: u32,
    pub route_requests_per_minute: u32,
}

impl Default for PluginLimits {
    fn default() -> Self {
        Self {
            call_timeout: Duration::from_millis(abi::limits::CALL_TIMEOUT_MS),
            cron_timeout: Duration::from_millis(abi::limits::CRON_CALL_TIMEOUT_MS),
            memory_bytes: abi::limits::MEMORY_BYTES,
            max_instances: abi::limits::MAX_INSTANCES_PER_PLUGIN,
            pool_acquire_timeout: Duration::from_millis(abi::limits::POOL_ACQUIRE_TIMEOUT_MS),
            instance_idle_timeout: Duration::from_secs(abi::limits::INSTANCE_IDLE_TIMEOUT_SECS),
            breaker_threshold: abi::limits::BREAKER_FAILURE_THRESHOLD,
            http_timeout: Duration::from_millis(abi::limits::HTTP_TIMEOUT_MS),
            max_http_response_bytes: abi::limits::MAX_HTTP_RESPONSE_BYTES,
            writes_per_call: abi::limits::MAX_WRITES_PER_CALL,
            http_requests_per_call: abi::limits::MAX_HTTP_REQUESTS_PER_CALL,
            writes_per_document_per_minute: abi::limits::MAX_WRITES_PER_DOCUMENT_PER_MINUTE,
            route_requests_per_minute: abi::limits::ROUTE_REQUESTS_PER_MINUTE,
        }
    }
}

impl PluginLimits {
    pub fn from_config(config: &Config) -> Self {
        let defaults = Self::default();
        Self {
            call_timeout: config.plugin_call_timeout.min(defaults.call_timeout),
            cron_timeout: config.plugin_cron_timeout.min(defaults.cron_timeout),
            memory_bytes: config.plugin_memory_bytes.min(defaults.memory_bytes),
            max_instances: config.plugin_max_instances.clamp(1, defaults.max_instances),
            pool_acquire_timeout: defaults.pool_acquire_timeout,
            instance_idle_timeout: defaults.instance_idle_timeout,
            breaker_threshold: config
                .plugin_breaker_threshold
                .clamp(1, defaults.breaker_threshold),
            http_timeout: config.plugin_http_timeout.min(defaults.http_timeout),
            max_http_response_bytes: config
                .plugin_http_max_response_bytes
                .min(defaults.max_http_response_bytes),
            writes_per_call: defaults.writes_per_call,
            http_requests_per_call: defaults.http_requests_per_call,
            writes_per_document_per_minute: defaults.writes_per_document_per_minute,
            route_requests_per_minute: defaults.route_requests_per_minute,
        }
    }

    pub fn max_pages(&self) -> u32 {
        u32::try_from(self.memory_bytes / (64 * 1024)).unwrap_or(u32::MAX)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Deadline {
    at: Instant,
}

impl Deadline {
    pub fn new(budget: Duration) -> Self {
        Self {
            at: Instant::now() + budget,
        }
    }

    pub fn at(&self) -> Instant {
        self.at
    }

    pub fn remaining(&self) -> Duration {
        self.at.saturating_duration_since(Instant::now())
    }

    pub fn remaining_ms(&self) -> u64 {
        u64::try_from(self.remaining().as_millis()).unwrap_or(u64::MAX)
    }

    pub fn expired(&self) -> bool {
        self.remaining().is_zero()
    }

    pub fn inherited(&self) -> Self {
        *self
    }

    pub fn capped(&self, cap: Duration) -> Duration {
        self.remaining().min(cap)
    }
}

pub struct WriteLedger {
    limit: u32,
    windows: Mutex<HashMap<(String, String), VecDeque<Instant>>>,
}

impl WriteLedger {
    pub fn new(limit_per_minute: u32) -> Self {
        Self {
            limit: limit_per_minute.max(1),
            windows: Mutex::new(HashMap::new()),
        }
    }

    pub fn record(&self, plugin_id: &str, document_id: &str) -> Result<(), abi::HostError> {
        self.record_at(plugin_id, document_id, Instant::now())
    }

    pub fn record_at(
        &self,
        plugin_id: &str,
        document_id: &str,
        now: Instant,
    ) -> Result<(), abi::HostError> {
        let mut windows = self.windows.lock().expect("write ledger poisoned");
        let window = windows
            .entry((plugin_id.to_string(), document_id.to_string()))
            .or_default();
        while window
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= WRITE_WINDOW)
        {
            window.pop_front();
        }
        if window.len() >= self.limit as usize {
            metrics::counter!(
                crate::telemetry::names::PLUGIN_WRITES_REFUSED,
                "plugin" => plugin_id.to_string()
            )
            .increment(1);
            return Err(abi::HostError::new(
                abi::ErrorCode::LimitExceeded,
                format!(
                    "plugin `{plugin_id}` has already written document {document_id} \
                     {} times in the last {} s",
                    self.limit,
                    WRITE_WINDOW.as_secs()
                ),
            )
            .with_detail(serde_json::json!({
                "limit": self.limit,
                "window_secs": WRITE_WINDOW.as_secs(),
                "document": document_id,
            })));
        }
        window.push_back(now);
        metrics::counter!(
            crate::telemetry::names::PLUGIN_DOCUMENT_WRITES,
            "plugin" => plugin_id.to_string()
        )
        .increment(1);
        Ok(())
    }

    pub fn sweep(&self) -> usize {
        let now = Instant::now();
        let mut windows = self.windows.lock().expect("write ledger poisoned");
        let before = windows.len();
        windows.retain(|_, window| {
            while window
                .front()
                .is_some_and(|at| now.saturating_duration_since(*at) >= WRITE_WINDOW)
            {
                window.pop_front();
            }
            !window.is_empty()
        });
        before - windows.len()
    }

    pub fn len(&self) -> usize {
        self.windows.lock().expect("write ledger poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn forget(&self, plugin_id: &str) {
        let mut windows = self.windows.lock().expect("write ledger poisoned");
        windows.retain(|(plugin, _), _| plugin != plugin_id);
    }
}

#[derive(Debug, Default)]
pub struct CallCounters {
    pub writes: std::sync::atomic::AtomicU32,
    pub logs: std::sync::atomic::AtomicU32,
    pub http_requests: std::sync::atomic::AtomicU32,
}

impl CallCounters {
    pub fn record_write(&self, limit: u32) -> Result<u32, abi::HostError> {
        let taken = self.writes.fetch_add(1, Ordering::Relaxed) + 1;
        if taken > limit {
            self.writes.fetch_sub(1, Ordering::Relaxed);
            return Err(abi::HostError::new(
                abi::ErrorCode::LimitExceeded,
                format!("this invocation has already made its {limit} document writes"),
            )
            .with_detail(serde_json::json!({ "limit": limit })));
        }
        Ok(taken)
    }

    pub fn allow_log(&self) -> bool {
        let taken = self.logs.fetch_add(1, Ordering::Relaxed) + 1;
        taken <= abi::log::MAX_LOG_LINES_PER_CALL
    }

    pub fn log_cap_reached(&self) -> bool {
        self.logs.load(Ordering::Relaxed) == abi::log::MAX_LOG_LINES_PER_CALL
    }

    pub fn writes(&self) -> u32 {
        self.writes.load(Ordering::Relaxed)
    }

    pub fn logs(&self) -> u32 {
        self.logs.load(Ordering::Relaxed)
    }

    pub fn record_http(&self, limit: u32) -> Result<u32, abi::HostError> {
        let taken = self.http_requests.fetch_add(1, Ordering::Relaxed) + 1;
        if taken > limit {
            self.http_requests.fetch_sub(1, Ordering::Relaxed);
            return Err(abi::HostError::new(
                abi::ErrorCode::LimitExceeded,
                format!("this invocation has already made its {limit} outbound requests"),
            )
            .with_detail(serde_json::json!({ "limit": limit })));
        }
        Ok(taken)
    }

    pub fn http_requests(&self) -> u32 {
        self.http_requests.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_nested_deadline_never_extends_the_budget() {
        let deadline = Deadline::new(Duration::from_millis(50));
        assert_eq!(deadline.inherited().at(), deadline.at());
        assert!(deadline.capped(Duration::from_secs(10)) <= Duration::from_millis(50));
    }

    #[test]
    fn the_default_memory_budget_is_two_thousand_pages() {
        assert_eq!(PluginLimits::default().max_pages(), 2048);
    }

    #[test]
    fn configuration_may_lower_a_cap_and_never_raise_one() {
        let defaults = PluginLimits::default();
        let mut config = crate::pluginhost::test_support::config();
        config.plugin_call_timeout = Duration::from_secs(600);
        config.plugin_cron_timeout = Duration::from_secs(6_000);
        config.plugin_memory_bytes = 8 * 1024 * 1024 * 1024;
        config.plugin_max_instances = 4_096;
        config.plugin_breaker_threshold = 1_000;
        config.plugin_http_timeout = Duration::from_secs(600);
        config.plugin_http_max_response_bytes = 1024 * 1024 * 1024;

        let widened = PluginLimits::from_config(&config);
        assert_eq!(widened, defaults, "no knob may exceed its ABI default");

        config.plugin_call_timeout = Duration::from_millis(250);
        config.plugin_memory_bytes = 16 * 1024 * 1024;
        config.plugin_max_instances = 1;
        config.plugin_breaker_threshold = 2;
        let tightened = PluginLimits::from_config(&config);
        assert_eq!(tightened.call_timeout, Duration::from_millis(250));
        assert_eq!(tightened.memory_bytes, 16 * 1024 * 1024);
        assert_eq!(tightened.max_instances, 1);
        assert_eq!(tightened.breaker_threshold, 2);
    }

    #[test]
    fn the_degenerate_settings_have_floors() {
        let mut config = crate::pluginhost::test_support::config();
        config.plugin_max_instances = 0;
        config.plugin_breaker_threshold = 0;
        let limits = PluginLimits::from_config(&config);
        assert_eq!(limits.max_instances, 1);
        assert_eq!(limits.breaker_threshold, 1);
    }

    #[test]
    fn the_write_ledger_is_a_sliding_window_per_plugin_and_document() {
        let ledger = WriteLedger::new(3);
        let start = Instant::now();

        for _ in 0..3 {
            ledger.record_at("calendar", "doc-a", start).expect("under");
        }
        let refused = ledger
            .record_at("calendar", "doc-a", start)
            .expect_err("the fourth write in the window is refused");
        assert_eq!(refused.code, abi::ErrorCode::LimitExceeded);
        assert_eq!(
            refused.detail.as_ref().and_then(|d| d["document"].as_str()),
            Some("doc-a"),
            "the refusal names the document being looped on"
        );

        ledger
            .record_at("calendar", "doc-b", start)
            .expect("a different document");
        ledger
            .record_at("agenda", "doc-a", start)
            .expect("a different plugin");

        let later = start + WRITE_WINDOW + Duration::from_millis(1);
        ledger
            .record_at("calendar", "doc-a", later)
            .expect("the window has rolled over");
    }

    #[test]
    fn sweeping_drops_only_fully_aged_windows() {
        let ledger = WriteLedger::new(10);
        ledger.record("calendar", "doc-a").expect("first");
        assert_eq!(ledger.len(), 1);
        assert_eq!(ledger.sweep(), 0);
        assert_eq!(ledger.len(), 1);

        ledger.forget("calendar");
        assert!(ledger.is_empty(), "uninstall forgets a plugin's windows");
    }

    #[test]
    fn the_per_call_write_cap_refuses_without_consuming_more_budget() {
        let counters = CallCounters::default();
        assert_eq!(counters.record_write(2).expect("first"), 1);
        assert_eq!(counters.record_write(2).expect("second"), 2);

        let refused = counters.record_write(2).expect_err("third");
        assert_eq!(refused.code, abi::ErrorCode::LimitExceeded);
        assert_eq!(
            counters.writes(),
            2,
            "a refused write must not inflate the count the log line reports"
        );
        assert!(counters.record_write(2).is_err());
        assert_eq!(counters.writes(), 2);
    }

    #[test]
    fn the_per_call_http_cap_refuses_without_consuming_more_budget() {
        let counters = CallCounters::default();
        assert_eq!(counters.record_http(2).expect("first"), 1);
        assert_eq!(counters.record_http(2).expect("second"), 2);

        let refused = counters.record_http(2).expect_err("third");
        assert_eq!(refused.code, abi::ErrorCode::LimitExceeded);
        assert_eq!(
            counters.http_requests(),
            2,
            "a refused request must not inflate the count the log line reports"
        );
        assert!(counters.record_http(2).is_err());
        assert_eq!(counters.http_requests(), 2);
    }

    #[test]
    fn the_log_cap_allows_the_line_that_announces_it() {
        let counters = CallCounters::default();
        for _ in 0..abi::log::MAX_LOG_LINES_PER_CALL {
            assert!(counters.allow_log());
        }
        assert!(
            counters.log_cap_reached(),
            "the host should say once that the rest are dropped"
        );
        assert!(!counters.allow_log(), "and then go quiet");
        assert!(!counters.log_cap_reached(), "exactly once");
    }
}

//! Resource limits, deadlines, and the write ledger (SPEC §6.3).
//!
//! The numbers themselves live in [`abi::limits`] — one definition, readable from both
//! sides, so a plugin author can respect a cap instead of discovering it. This module is
//! the *enforcement*: what a configured server actually applies, how a deadline is shared
//! down a call chain, and how the per-document write cap is counted.
//!
//! **Owner:** the `wasm-host` builder.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use ddd_plugin_abi as abi;

use crate::config::Config;

/// The window the per-document write cap is measured over (SPEC §6.3: "10/min").
pub const WRITE_WINDOW: Duration = Duration::from_secs(60);

/// The limits one server applies. Configuration may only **lower** a cap; an operator can
/// tighten the sandbox, a plugin author cannot loosen it, and
/// [`PluginLimits::from_config`] is where that asymmetry is enforced.
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
    /// Read the `PLUGIN_*` environment knobs, clamped to the ABI defaults.
    ///
    /// Every knob is folded with `min` against [`PluginLimits::default`], which is the
    /// asymmetry this function exists for: an operator may tighten the sandbox, and a
    /// configuration file may not widen it. `Config` already parsed and range-checked the
    /// values; clamping them *again* here is deliberate belt-and-braces, because the
    /// failure mode of a forgotten clamp is a 128 MB cap silently becoming 8 GB and only
    /// one of those two mistakes is visible in a log.
    pub fn from_config(config: &Config) -> Self {
        let defaults = Self::default();
        Self {
            call_timeout: config.plugin_call_timeout.min(defaults.call_timeout),
            cron_timeout: config.plugin_cron_timeout.min(defaults.cron_timeout),
            memory_bytes: config.plugin_memory_bytes.min(defaults.memory_bytes),
            // Zero instances would make every call `PoolExhausted`, which reads as a
            // broken host rather than as a configuration mistake — so the floor is one.
            max_instances: config.plugin_max_instances.clamp(1, defaults.max_instances),
            pool_acquire_timeout: defaults.pool_acquire_timeout,
            instance_idle_timeout: defaults.instance_idle_timeout,
            // A threshold of zero would open the breaker before the first call; one is the
            // tightest setting that still means "a failure happened".
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

    /// Wasm pages (64 KiB each), for Extism's `MemoryOptions::max_pages`.
    pub fn max_pages(&self) -> u32 {
        u32::try_from(self.memory_bytes / (64 * 1024)).unwrap_or(u32::MAX)
    }
}

/// A shared point in time after which an invocation must stop.
///
/// **One deadline per top-level invocation, shared by the whole `call_plugin` chain.** A
/// per-call timeout would let a three-deep chain hold a request for fifteen seconds while
/// every individual call looked innocent; sharing it means the outermost budget is the
/// truth, and a callee can see how much of it is left
/// ([`abi::call::CallPayload::deadline_ms`]) and refuse honestly rather than being
/// interrupted mid-write.
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

    /// The deadline a nested call gets: the same instant, never a fresh budget.
    pub fn inherited(&self) -> Self {
        *self
    }

    /// `min(remaining, cap)` — what an outbound HTTP timeout must be so a 10 s request
    /// cannot outlive a 5 s hook.
    pub fn capped(&self, cap: Duration) -> Duration {
        self.remaining().min(cap)
    }
}

/// The per-plugin-per-document write cap (SPEC §6.3: "per-plugin-per-doc write cap
/// (10/min) as a loop backstop").
///
/// The *other* loop backstop is structural — a plugin never receives a hook for its own
/// change — and this one catches what that misses: two plugins writing to each other's
/// documents, and a plugin reacting to its own change arriving through a *different*
/// document.
///
/// A sliding one-minute window per `(plugin, document)`, swept periodically. Deliberately
/// in memory: the cap is a loop breaker, not an audit control, and a counter that survives
/// a restart would be a surprising penalty after a deploy.
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

    /// Record a write, or refuse it. The error carries `{limit, window_secs, document}` so
    /// a plugin author can see which document it is looping on.
    pub fn record(&self, plugin_id: &str, document_id: &str) -> Result<(), abi::HostError> {
        self.record_at(plugin_id, document_id, Instant::now())
    }

    /// [`WriteLedger::record`] with the clock injected, so the window is testable without
    /// sleeping for a minute.
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
        // Prune first, so a plugin that wrote ten times a minute ago is not punished for it.
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

    /// Drop windows that have fully aged out. Called from the maintenance loop.
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

    /// How many `(plugin, document)` windows are currently held — the number the
    /// maintenance loop's log line reports.
    pub fn len(&self) -> usize {
        self.windows.lock().expect("write ledger poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Forget everything one plugin recorded — on uninstall, so a reinstalled plugin does
    /// not inherit a cap it never hit.
    pub fn forget(&self, plugin_id: &str) {
        let mut windows = self.windows.lock().expect("write ledger poisoned");
        windows.retain(|(plugin, _), _| plugin != plugin_id);
    }
}

/// Per-invocation counters: the per-call write cap, the log-line cap, and the numbers that
/// end up in the call's log line.
#[derive(Debug, Default)]
pub struct CallCounters {
    pub writes: std::sync::atomic::AtomicU32,
    pub logs: std::sync::atomic::AtomicU32,
    pub http_requests: std::sync::atomic::AtomicU32,
}

impl CallCounters {
    /// Count one document write against [`PluginLimits::writes_per_call`].
    ///
    /// Counted **before** the write is attempted, so a refused call cannot also have
    /// written: a cap that is checked afterwards is a cap that is one write too late.
    pub fn record_write(&self, limit: u32) -> Result<u32, abi::HostError> {
        let taken = self.writes.fetch_add(1, Ordering::Relaxed) + 1;
        if taken > limit {
            // Give the number back, so a plugin that keeps trying sees the same error
            // instead of an ever-growing counter in the log line.
            self.writes.fetch_sub(1, Ordering::Relaxed);
            return Err(abi::HostError::new(
                abi::ErrorCode::LimitExceeded,
                format!("this invocation has already made its {limit} document writes"),
            )
            .with_detail(serde_json::json!({ "limit": limit })));
        }
        Ok(taken)
    }

    /// `true` while the call may still log.
    ///
    /// The line **at** the cap is allowed and says the rest are dropped, so the log never
    /// just goes quiet: a plugin logging in a loop is exactly the case where a silent
    /// truncation is indistinguishable from a hang.
    pub fn allow_log(&self) -> bool {
        let taken = self.logs.fetch_add(1, Ordering::Relaxed) + 1;
        taken <= abi::log::MAX_LOG_LINES_PER_CALL
    }

    /// `true` exactly once — on the line that hits the cap.
    pub fn log_cap_reached(&self) -> bool {
        self.logs.load(Ordering::Relaxed) == abi::log::MAX_LOG_LINES_PER_CALL
    }

    pub fn writes(&self) -> u32 {
        self.writes.load(Ordering::Relaxed)
    }

    pub fn logs(&self) -> u32 {
        self.logs.load(Ordering::Relaxed)
    }

    /// Count one outbound request against [`PluginLimits::http_requests_per_call`].
    ///
    /// Counting without checking is what this used to do, and the number was only ever read
    /// back for the metrics line: one invocation could issue unbounded `http_request`s, bounded
    /// by nothing but its own deadline.
    pub fn record_http(&self, limit: u32) -> Result<u32, abi::HostError> {
        let taken = self.http_requests.fetch_add(1, Ordering::Relaxed) + 1;
        if taken > limit {
            // Given back, so a plugin that keeps trying sees the same error rather than an
            // ever-growing number in the log — the same shape as `record_write`.
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
        // 128 MiB / 64 KiB. Stated as a test because the conversion is the kind of
        // arithmetic that is wrong by a factor of 1024 in silence.
        assert_eq!(PluginLimits::default().max_pages(), 2048);
    }

    /// A config that asks for *more* than the ABI allows gets the ABI's number. This is
    /// the one asymmetry in the whole limits story, and the only way to see it is to try
    /// to widen every knob at once.
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

    /// Zero instances or a zero breaker threshold would each disable the host in a way
    /// that looks like a bug rather than a setting, so both have a floor of one.
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

        // A different document is a different window — the cap is a loop breaker, not a
        // budget on the plugin.
        ledger
            .record_at("calendar", "doc-b", start)
            .expect("a different document");
        // And so is a different plugin.
        ledger
            .record_at("agenda", "doc-a", start)
            .expect("a different plugin");

        // Once the window has passed, the entries age out rather than being forgiven in a
        // batch: one second past the minute lets exactly the first write's slot through.
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
        // Nothing has aged out yet, so a sweep must not drop a live window.
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
        // A plugin that keeps trying keeps getting the same answer.
        assert!(counters.record_write(2).is_err());
        assert_eq!(counters.writes(), 2);
    }

    /// The outbound-request cap, which used to be a counter nothing compared against a limit:
    /// one invocation could loop `http_request` against its approved host for its whole
    /// deadline, making the server a request amplifier pointed at a third party the admin had
    /// approved for a nightly feed fetch.
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
        // A plugin that keeps looping keeps getting the same answer.
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

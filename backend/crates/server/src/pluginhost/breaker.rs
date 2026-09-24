//! The circuit breaker: **5 consecutive failures or timeouts disable a plugin until an
//! admin re-enables it** (SPEC §6.3).
//!
//! Two decisions worth stating, because both are the unusual choice:
//!
//! - **No automatic half-open retry.** SPEC says "surfaced in admin with manual
//!   re-enable", and that is right for this system: a backend plugin writes *documents*,
//!   so a plugin that fails five times in a row has probably been writing nonsense, and
//!   an operator should look before it writes more. Auto-recovery would also make the
//!   failure invisible, which is the outcome the breaker exists to prevent.
//! - **The open state is persisted** on the plugin's record (`disabled_reason`), so a
//!   restart does not silently re-enable a plugin an operator has not looked at. The
//!   in-memory counter is *not* persisted: counting resets on boot, which is the right
//!   default for "five in a row".
//!
//! What counts as a failure is [`super::PluginHostError::counts_as_failure`] — not a
//! plugin's refusal, and not the host's own routing decisions.
//!
//! **Owner:** the `wasm-host` builder.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// Whether calls reach a plugin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BreakerState {
    /// Calls flow. `failures` is the current consecutive count (0 after any success).
    Closed { failures: u32 },
    /// Calls are refused with `unavailable` until an admin resets it.
    Open {
        since: Instant,
        failures: u32,
        reason: String,
    },
}

impl Default for BreakerState {
    fn default() -> Self {
        BreakerState::Closed { failures: 0 }
    }
}

impl BreakerState {
    pub fn is_open(&self) -> bool {
        matches!(self, BreakerState::Open { .. })
    }

    /// The consecutive-failure count, whichever state it is in.
    pub fn failures(&self) -> u32 {
        match self {
            BreakerState::Closed { failures } | BreakerState::Open { failures, .. } => *failures,
        }
    }

    /// Why it is open, for the admin screen and the plugin record's `disabled_reason`.
    pub fn reason(&self) -> Option<&str> {
        match self {
            BreakerState::Closed { .. } => None,
            BreakerState::Open { reason, .. } => Some(reason.as_str()),
        }
    }

    /// `"closed"` / `"open"` — the label the `/metrics` series carries.
    pub fn label(&self) -> &'static str {
        match self {
            BreakerState::Closed { .. } => "closed",
            BreakerState::Open { .. } => "open",
        }
    }
}

/// What [`CircuitBreaker::record_failure`] tells the caller to do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BreakerTransition {
    /// Still closed; nothing to report beyond the log line.
    Counted { failures: u32 },
    /// This failure opened the breaker: persist `disabled_reason`, write an audit entry,
    /// and stop scheduling cron for it.
    Opened { failures: u32, reason: String },
    /// Already open — the call should not have been attempted.
    AlreadyOpen,
}

/// Per-plugin failure counting.
pub struct CircuitBreaker {
    threshold: u32,
    states: Mutex<HashMap<String, BreakerState>>,
}

impl CircuitBreaker {
    pub fn new(threshold: u32) -> Self {
        Self {
            // A threshold of zero would open before the first call ever ran, which is not a
            // configuration anyone means.
            threshold: threshold.max(1),
            states: Mutex::new(HashMap::new()),
        }
    }

    pub fn threshold(&self) -> u32 {
        self.threshold
    }

    /// Reset the consecutive count. Called after every successful call — including one
    /// where the *plugin* refused, because the plugin answering is the machinery working.
    ///
    /// An **open** breaker is not closed by this: the only way out of open is an admin
    /// (SPEC §6.3's "manual re-enable"), and a late-arriving success from a call that was
    /// already in flight when the breaker opened must not undo the decision.
    pub fn record_success(&self, plugin_id: &str) {
        let mut states = self.states.lock().expect("circuit breaker poisoned");
        match states.get(plugin_id) {
            Some(BreakerState::Open { .. }) => {}
            _ => {
                states.insert(plugin_id.to_string(), BreakerState::Closed { failures: 0 });
            }
        }
    }

    /// Count a host-side failure and say what changed.
    pub fn record_failure(&self, plugin_id: &str, reason: &str) -> BreakerTransition {
        let mut states = self.states.lock().expect("circuit breaker poisoned");
        let current = states.entry(plugin_id.to_string()).or_default();
        match current {
            BreakerState::Open { .. } => BreakerTransition::AlreadyOpen,
            BreakerState::Closed { failures } => {
                let failures = *failures + 1;
                if failures >= self.threshold {
                    // The reason is the *last* failure's, not a summary: an operator
                    // debugging a disabled plugin wants the error that finally did it, and
                    // the four before it are in the log.
                    let reason = format!("{failures} consecutive failures; last: {reason}");
                    *current = BreakerState::Open {
                        since: Instant::now(),
                        failures,
                        reason: reason.clone(),
                    };
                    BreakerTransition::Opened { failures, reason }
                } else {
                    *current = BreakerState::Closed { failures };
                    BreakerTransition::Counted { failures }
                }
            }
        }
    }

    pub fn state(&self, plugin_id: &str) -> BreakerState {
        self.states
            .lock()
            .expect("circuit breaker poisoned")
            .get(plugin_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn is_open(&self, plugin_id: &str) -> bool {
        self.state(plugin_id).is_open()
    }

    /// Re-arm a plugin: the admin's "enable" button, and what activation does.
    pub fn reset(&self, plugin_id: &str) {
        self.states
            .lock()
            .expect("circuit breaker poisoned")
            .insert(plugin_id.to_string(), BreakerState::Closed { failures: 0 });
    }

    /// Mark a plugin open without a call having failed — an admin disabling it by hand, or
    /// a boot that found `disabled_reason` on the record.
    pub fn open(&self, plugin_id: &str, reason: &str) {
        let mut states = self.states.lock().expect("circuit breaker poisoned");
        let failures = states.get(plugin_id).map_or(0, BreakerState::failures);
        states.insert(
            plugin_id.to_string(),
            BreakerState::Open {
                since: Instant::now(),
                failures,
                reason: reason.to_string(),
            },
        );
    }

    /// Everything the admin screen shows.
    pub fn snapshot(&self) -> Vec<(String, BreakerState)> {
        let states = self.states.lock().expect("circuit breaker poisoned");
        let mut out: Vec<(String, BreakerState)> = states
            .iter()
            .map(|(id, state)| (id.clone(), state.clone()))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// How many plugins are currently open — the `/metrics` gauge.
    pub fn open_count(&self) -> usize {
        self.states
            .lock()
            .expect("circuit breaker poisoned")
            .values()
            .filter(|state| state.is_open())
            .count()
    }

    pub fn forget(&self, plugin_id: &str) {
        self.states
            .lock()
            .expect("circuit breaker poisoned")
            .remove(plugin_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_success_resets_the_consecutive_count() {
        let breaker = CircuitBreaker::new(5);
        for expected in 1..=4 {
            assert_eq!(
                breaker.record_failure("calendar", "timeout"),
                BreakerTransition::Counted { failures: expected }
            );
        }
        assert!(!breaker.is_open("calendar"));

        breaker.record_success("calendar");
        assert_eq!(breaker.state("calendar").failures(), 0);

        // Four more after a success is still four — "five in a row", not "five ever".
        for _ in 0..4 {
            breaker.record_failure("calendar", "timeout");
        }
        assert!(!breaker.is_open("calendar"));
    }

    #[test]
    fn five_in_a_row_opens_it_and_only_an_admin_closes_it() {
        let breaker = CircuitBreaker::new(5);
        for _ in 0..4 {
            breaker.record_failure("calendar", "trap");
        }
        let opened = breaker.record_failure("calendar", "trap: unreachable");
        match &opened {
            BreakerTransition::Opened { failures, reason } => {
                assert_eq!(*failures, 5);
                assert!(
                    reason.contains("trap: unreachable"),
                    "the reason names the failure that did it: {reason}"
                );
            }
            other => panic!("expected Opened, got {other:?}"),
        }
        assert!(breaker.is_open("calendar"));

        // A further failure is `AlreadyOpen`: the call should never have been attempted,
        // and the count must not keep climbing.
        assert_eq!(
            breaker.record_failure("calendar", "trap"),
            BreakerTransition::AlreadyOpen
        );
        assert_eq!(breaker.state("calendar").failures(), 5);

        // A success arriving from a call that was already in flight does **not** reopen the
        // gate — auto-recovery is exactly what SPEC §6.3 refuses.
        breaker.record_success("calendar");
        assert!(breaker.is_open("calendar"));

        breaker.reset("calendar");
        assert_eq!(
            breaker.state("calendar"),
            BreakerState::Closed { failures: 0 }
        );
    }

    #[test]
    fn plugins_are_counted_independently() {
        let breaker = CircuitBreaker::new(2);
        breaker.record_failure("calendar", "timeout");
        breaker.record_failure("calendar", "timeout");
        assert!(breaker.is_open("calendar"));
        assert!(
            !breaker.is_open("agenda"),
            "one plugin's failures must not disable another"
        );
        assert_eq!(breaker.open_count(), 1);

        breaker.open("agenda", "admin");
        assert_eq!(breaker.state("agenda").reason(), Some("admin"));
        assert_eq!(breaker.open_count(), 2);

        assert_eq!(
            breaker
                .snapshot()
                .iter()
                .map(|(id, _)| id.as_str())
                .collect::<Vec<_>>(),
            vec!["agenda", "calendar"],
            "the admin screen gets a stable order"
        );

        breaker.forget("calendar");
        assert_eq!(breaker.open_count(), 1);
        assert_eq!(
            breaker.state("calendar"),
            BreakerState::Closed { failures: 0 },
            "an uninstalled plugin starts clean when it comes back"
        );
    }

    /// A threshold of one is the tightest legal setting; zero is a configuration mistake
    /// that would disable every plugin before its first call.
    #[test]
    fn a_zero_threshold_is_clamped_to_one() {
        let breaker = CircuitBreaker::new(0);
        assert_eq!(breaker.threshold(), 1);
        assert!(matches!(
            breaker.record_failure("calendar", "timeout"),
            BreakerTransition::Opened { failures: 1, .. }
        ));
    }
}

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BreakerState {
    Closed {
        failures: u32,
    },
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

    pub fn failures(&self) -> u32 {
        match self {
            BreakerState::Closed { failures } | BreakerState::Open { failures, .. } => *failures,
        }
    }

    pub fn reason(&self) -> Option<&str> {
        match self {
            BreakerState::Closed { .. } => None,
            BreakerState::Open { reason, .. } => Some(reason.as_str()),
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            BreakerState::Closed { .. } => "closed",
            BreakerState::Open { .. } => "open",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BreakerTransition {
    Counted { failures: u32 },
    Opened { failures: u32, reason: String },
    AlreadyOpen,
}

pub struct CircuitBreaker {
    threshold: u32,
    states: Mutex<HashMap<String, BreakerState>>,
}

impl CircuitBreaker {
    pub fn new(threshold: u32) -> Self {
        Self {
            threshold: threshold.max(1),
            states: Mutex::new(HashMap::new()),
        }
    }

    pub fn threshold(&self) -> u32 {
        self.threshold
    }

    pub fn record_success(&self, plugin_id: &str) {
        let mut states = self.states.lock().expect("circuit breaker poisoned");
        match states.get(plugin_id) {
            Some(BreakerState::Open { .. }) => {}
            _ => {
                states.insert(plugin_id.to_string(), BreakerState::Closed { failures: 0 });
            }
        }
    }

    pub fn record_failure(&self, plugin_id: &str, reason: &str) -> BreakerTransition {
        let mut states = self.states.lock().expect("circuit breaker poisoned");
        let current = states.entry(plugin_id.to_string()).or_default();
        match current {
            BreakerState::Open { .. } => BreakerTransition::AlreadyOpen,
            BreakerState::Closed { failures } => {
                let failures = *failures + 1;
                if failures >= self.threshold {
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

    pub fn reset(&self, plugin_id: &str) {
        self.states
            .lock()
            .expect("circuit breaker poisoned")
            .insert(plugin_id.to_string(), BreakerState::Closed { failures: 0 });
    }

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

    pub fn snapshot(&self) -> Vec<(String, BreakerState)> {
        let states = self.states.lock().expect("circuit breaker poisoned");
        let mut out: Vec<(String, BreakerState)> = states
            .iter()
            .map(|(id, state)| (id.clone(), state.clone()))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

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

        assert_eq!(
            breaker.record_failure("calendar", "trap"),
            BreakerTransition::AlreadyOpen
        );
        assert_eq!(breaker.state("calendar").failures(), 5);

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

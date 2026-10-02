use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::error::AppError;

pub const BACKOFF_BASE_SECS: u64 = 2;
pub const MAX_BACKOFF_SECS: u64 = 3_600;
const SWEEP_THRESHOLD: usize = 4_096;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RateKey {
    Account(String),
    Ip(String),
    Named { bucket: &'static str, key: String },
}

pub fn backoff_secs(failures: u32, max_attempts: u32) -> u64 {
    if failures <= max_attempts {
        return 0;
    }
    let exponent = (failures - max_attempts - 1).min(32);
    let multiplier = 1u64.checked_shl(exponent).unwrap_or(u64::MAX);
    BACKOFF_BASE_SECS
        .saturating_mul(multiplier)
        .min(MAX_BACKOFF_SECS)
}

#[derive(Debug)]
struct Bucket {
    failures: u32,
    window_start: Instant,
    blocked_until: Option<Instant>,
}

impl Bucket {
    fn new(now: Instant) -> Self {
        Self {
            failures: 0,
            window_start: now,
            blocked_until: None,
        }
    }

    fn is_stale(&self, now: Instant, window: Duration) -> bool {
        match self.blocked_until {
            Some(until) if until > now => false,
            _ => now.duration_since(self.window_start) > window,
        }
    }
}

pub struct RateLimiter {
    inner: Arc<RateLimiterInner>,
}

struct RateLimiterInner {
    max_attempts: u32,
    window: Duration,
    buckets: Mutex<HashMap<RateKey, Bucket>>,
}

impl RateLimiter {
    pub fn new(max_attempts: u32, window: Duration) -> Self {
        Self {
            inner: Arc::new(RateLimiterInner {
                max_attempts,
                window,
                buckets: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn check(&self, key: &RateKey) -> Result<(), RateLimited> {
        let now = Instant::now();
        let mut buckets = self.lock();

        let stale = match buckets.get(key) {
            None => return Ok(()),
            Some(bucket) => {
                if let Some(until) = bucket.blocked_until
                    && until > now
                {
                    let remaining = until.duration_since(now);
                    return Err(RateLimited {
                        retry_after_secs: remaining.as_secs()
                            + u64::from(remaining.subsec_nanos() > 0),
                    });
                }
                bucket.is_stale(now, self.inner.window)
            }
        };

        if stale {
            buckets.remove(key);
        }
        Ok(())
    }

    pub fn record_failure(&self, key: &RateKey) {
        let now = Instant::now();
        let window = self.inner.window;
        let max_attempts = self.inner.max_attempts;
        let mut buckets = self.lock();

        if buckets.len() >= SWEEP_THRESHOLD {
            buckets.retain(|_, bucket| !bucket.is_stale(now, window));
        }

        let bucket = buckets
            .entry(key.clone())
            .or_insert_with(|| Bucket::new(now));

        let locked = bucket.blocked_until.is_some_and(|until| until > now);
        if !locked && now.duration_since(bucket.window_start) > window {
            bucket.failures = 0;
            bucket.window_start = now;
            bucket.blocked_until = None;
        }

        bucket.failures = bucket.failures.saturating_add(1);
        let secs = backoff_secs(bucket.failures, max_attempts);
        if secs > 0 {
            bucket.blocked_until = Some(now + Duration::from_secs(secs));
        }
    }

    pub fn record_success(&self, key: &RateKey) {
        self.lock().remove(key);
    }

    pub fn sweep(&self) {
        let now = Instant::now();
        let window = self.inner.window;
        self.lock()
            .retain(|_, bucket| !bucket.is_stale(now, window));
    }

    pub fn tracked_keys(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<RateKey, Bucket>> {
        match self.inner.buckets.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimited {
    pub retry_after_secs: u64,
}

impl From<RateLimited> for AppError {
    fn from(limited: RateLimited) -> Self {
        AppError::TooManyRequests {
            retry_after_secs: limited.retry_after_secs,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(email: &str) -> RateKey {
        RateKey::Account(email.to_string())
    }

    #[test]
    fn free_attempts_then_exponential_backoff() {
        assert_eq!(backoff_secs(0, 3), 0);
        assert_eq!(backoff_secs(3, 3), 0, "the last free attempt is free");
        assert_eq!(backoff_secs(4, 3), 2);
        assert_eq!(backoff_secs(5, 3), 4);
        assert_eq!(backoff_secs(6, 3), 8);
        assert_eq!(backoff_secs(7, 3), 16);
    }

    #[test]
    fn backoff_is_capped_and_never_overflows() {
        assert_eq!(backoff_secs(u32::MAX, 3), MAX_BACKOFF_SECS);
        assert_eq!(backoff_secs(60, 3), MAX_BACKOFF_SECS);
        assert!(backoff_secs(30, 3) <= MAX_BACKOFF_SECS);
    }

    #[test]
    fn zero_max_attempts_locks_on_the_first_failure() {
        assert_eq!(backoff_secs(1, 0), BACKOFF_BASE_SECS);
    }

    #[test]
    fn check_passes_until_the_budget_is_spent() {
        let limiter = RateLimiter::new(3, Duration::from_secs(900));
        let key = account("a@b.co");

        for _ in 0..3 {
            assert!(limiter.check(&key).is_ok());
            limiter.record_failure(&key);
        }

        assert!(limiter.check(&key).is_ok(), "3 failures are still free");
        limiter.record_failure(&key);

        let limited = limiter.check(&key).expect_err("4th failure locks out");
        assert!(limited.retry_after_secs > 0);
        assert!(limited.retry_after_secs <= BACKOFF_BASE_SECS);
    }

    #[test]
    fn retry_after_grows_with_further_failures() {
        let limiter = RateLimiter::new(1, Duration::from_secs(900));
        let key = account("a@b.co");

        limiter.record_failure(&key);
        limiter.record_failure(&key);
        let first = limiter.check(&key).expect_err("locked").retry_after_secs;

        limiter.record_failure(&key);
        let second = limiter
            .check(&key)
            .expect_err("still locked")
            .retry_after_secs;

        assert!(second > first, "{second} should exceed {first}");
    }

    #[test]
    fn success_clears_the_key() {
        let limiter = RateLimiter::new(1, Duration::from_secs(900));
        let key = account("a@b.co");

        limiter.record_failure(&key);
        limiter.record_failure(&key);
        assert!(limiter.check(&key).is_err());

        limiter.record_success(&key);
        assert!(limiter.check(&key).is_ok());
        assert_eq!(limiter.tracked_keys(), 0);
    }

    #[test]
    fn keys_are_independent() {
        let limiter = RateLimiter::new(0, Duration::from_secs(900));
        let ip = RateKey::Ip("10.0.0.1".to_string());
        let other = RateKey::Ip("10.0.0.2".to_string());
        let named = RateKey::Named {
            bucket: "register",
            key: "10.0.0.1".to_string(),
        };

        limiter.record_failure(&ip);
        assert!(limiter.check(&ip).is_err());
        assert!(limiter.check(&other).is_ok());
        assert!(limiter.check(&named).is_ok());
    }

    #[test]
    fn expired_windows_are_swept() {
        let limiter = RateLimiter::new(10, Duration::from_millis(0));
        let key = account("a@b.co");
        limiter.record_failure(&key);
        assert_eq!(limiter.tracked_keys(), 1);

        std::thread::sleep(Duration::from_millis(2));
        limiter.sweep();
        assert_eq!(limiter.tracked_keys(), 0);
    }

    #[test]
    fn sweep_keeps_active_lockouts() {
        let limiter = RateLimiter::new(0, Duration::from_millis(0));
        let key = account("a@b.co");
        limiter.record_failure(&key);

        std::thread::sleep(Duration::from_millis(2));
        limiter.sweep();
        assert_eq!(limiter.tracked_keys(), 1, "an active lockout must survive");
        assert!(limiter.check(&key).is_err());
    }
}

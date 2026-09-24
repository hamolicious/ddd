//! Cron invocation (SPEC §6.3): **UTC, missed runs skipped, `last_run` persisted, no
//! overlapping executions.**
//!
//! The manifest declares expressions, not handlers:
//! `"backend": { "cron": ["0 6 * * *", "*/15 * * * *"] }`. Every one of them lands on the
//! single `lm_cron` export; the payload says which fired, by index and by expression, so
//! a plugin with two schedules dispatches on that rather than on the clock.
//!
//! "Missed runs skipped" is a decision with teeth: a server that was down for a day does
//! **not** fire yesterday's six o'clock job on boot. [`CronPayload::missed`] tells the
//! plugin how many firings it slept through, so a sync job can decide to do a full
//! reconciliation instead of an incremental one.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronPayload {
    /// The expression from the manifest, verbatim.
    pub expression: String,
    /// Its index in `backend.cron` — stable across restarts, unlike the string if the
    /// author reformats it.
    pub index: u32,
    /// The scheduled instant (the cron slot), RFC 3339 UTC.
    pub scheduled_for: String,
    /// When the host actually invoked, RFC 3339 UTC. Late by the scheduler's tick and
    /// whatever the pool made it wait.
    pub fired_at: String,
    /// The previous successful run of **this expression**, from `plugins.cron_state`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<String>,
    /// Firings skipped since `last_run` (downtime, or a previous run still in flight).
    #[serde(default)]
    pub missed: u32,
    /// Milliseconds on the invocation deadline —
    /// [`crate::limits::CRON_CALL_TIMEOUT_MS`] unless an admin lowered it.
    pub deadline_ms: u64,
}

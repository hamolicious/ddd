//! Cron: a five-field parser and the scheduler that fires `ddd_cron`.
//!
//! SPEC §6.3, in four clauses and what each one means here:
//!
//! - **UTC.** No timezone field, no DST arithmetic, no ambiguity twice a year. A plugin
//!   that wants local time gets the user's offset from its own config.
//! - **Missed runs skipped.** A server that was down for a day fires each expression
//!   *once* when it comes back, not once per missed slot. The payload carries `missed` so
//!   a sync job can choose a full reconciliation.
//! - **`last_run` persisted** on the plugin's record, so a restart does not re-fire a job
//!   that already ran.
//! - **No overlapping executions.** One expression has at most one run in flight; a slot
//!   that arrives while the previous run is still going is counted as missed.
//!
//! # Why the parser is hand-rolled
//!
//! Every cron crate on crates.io pulls `chrono`, and this workspace deliberately uses
//! `time` (the shared core hand-rolls its own date arithmetic for exactly this reason —
//! SPEC §3.4, parity by construction). A five-field parser with steps, ranges and lists is
//! ~150 lines and fully testable; a second date library is a permanent tax. Non-standard
//! extensions (`@daily`, seconds, `L`, `#`) are **not** supported and are a parse error, so
//! a manifest cannot mean two different things on two servers.
//!
//! # The decision is pure, the effect is not
//!
//! Everything the four clauses above amount to is [`decide`]: a total function of
//! (schedule, `last_run`, now, is-a-run-in-flight) to one of three answers. The scheduler
//! is then a one-minute tick that asks [`decide`] and, when told to, persists `last_run`
//! and hands an [`Invocation`] to the host. That split is what makes "a server down for
//! three days fires once, with `missed: 2`" a unit test with a fake clock instead of a
//! three-day integration test.
//!
//! **Owner:** the `hooks-cron` builder.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration as StdDuration;

use bson::doc;
use ddd_plugin_abi as abi;
use time::{Duration, OffsetDateTime, Time, UtcOffset};

use super::limits::PluginLimits;
use super::{CallKind, Invocation, PluginHost};
use crate::domain::Timestamp;
use crate::state::AppState;

/// How far [`CronSchedule::next_after`] and [`CronSchedule::previous_before`] search before
/// giving up. Four years and change covers every leap-year cycle, which is what makes
/// `0 0 29 2 *` terminate and `0 0 30 2 *` answer `None` instead of looping forever.
const MAX_SEARCH_DAYS: u32 = 366 * 4 + 2;

/// Ceiling on the `missed` count handed to a plugin. A server that was off for a year does
/// not need a million-element walk to say "a lot"; the plugin's only decision is
/// incremental-vs-full reconciliation, and any number above a handful means full.
pub const MAX_MISSED_COUNT: u32 = 10_000;

/// Full-minute alignment offset for the tick. Waking a little *after* the minute boundary
/// means `matches(now)` is never evaluated on the previous minute because of clock jitter.
const TICK_OFFSET: StdDuration = StdDuration::from_millis(500);

/// One parsed expression: `minute hour day-of-month month day-of-week`.
///
/// Five bitmaps plus the two "is this field restricted" flags that the Vixie
/// day-of-month/day-of-week union rule needs (see [`CronSchedule::next_after`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronSchedule {
    minutes: u64,
    hours: u64,
    days_of_month: u64,
    months: u64,
    days_of_week: u64,
    dom_restricted: bool,
    dow_restricted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CronParseError {
    #[error("expected 5 fields (minute hour day-of-month month day-of-week), found {found}")]
    FieldCount { found: usize },
    #[error("{field}: {reason}")]
    Field { field: &'static str, reason: String },
    #[error("{0} is not supported: use the five standard fields")]
    Unsupported(String),
}

impl CronParseError {
    fn field(field: &'static str, reason: impl Into<String>) -> Self {
        CronParseError::Field {
            field,
            reason: reason.into(),
        }
    }
}

const MONTH_NAMES: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const DAY_NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

impl CronSchedule {
    /// Parse a standard five-field expression.
    ///
    /// Supported per field: `*`, a number, `a-b`, `a-b/n`, `*/n`, and comma-separated
    /// lists of those. Month and day-of-week accept three-letter names (`JAN`, `MON`),
    /// case-insensitively; `7` and `0` both mean Sunday.
    pub fn parse(expression: &str) -> Result<CronSchedule, CronParseError> {
        let trimmed = expression.trim();
        if trimmed.starts_with('@') {
            // `@daily` and friends are the one *popular* extension, which is exactly why
            // refusing them is worth doing loudly: a manifest that means "daily" on one
            // server and nothing on another is the failure this refusal prevents.
            return Err(CronParseError::Unsupported(trimmed.to_string()));
        }
        let fields: Vec<&str> = trimmed.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(CronParseError::FieldCount {
                found: fields.len(),
            });
        }

        let minutes = parse_field(fields[0], "minute", 0, 59, None)?;
        let hours = parse_field(fields[1], "hour", 0, 23, None)?;
        let days_of_month = parse_field(fields[2], "day-of-month", 1, 31, None)?;
        let months = parse_field(fields[3], "month", 1, 12, Some(&MONTH_NAMES))?;
        // Day-of-week accepts 0–7 so that both spellings of Sunday parse; 7 is folded onto
        // 0 immediately so every later comparison has one representation.
        let days_of_week_raw = parse_field(fields[4], "day-of-week", 0, 7, Some(&DAY_NAMES))?;
        let days_of_week = if days_of_week_raw & (1 << 7) != 0 {
            (days_of_week_raw | 1) & !(1 << 7)
        } else {
            days_of_week_raw
        };

        Ok(CronSchedule {
            minutes,
            hours,
            days_of_month,
            months,
            days_of_week,
            // "Restricted" is *the field is not `*`* — the Vixie definition. `*/1` is
            // therefore restricted even though it selects everything; it also matches
            // everything, so the union rule cannot change an answer because of it.
            dom_restricted: fields[2] != "*",
            dow_restricted: fields[4] != "*",
        })
    }

    /// The next firing instant strictly after `after`, in UTC.
    ///
    /// `None` only for an expression that can never fire (`0 0 30 2 *` — 30 February);
    /// the search is bounded at four years, which is what makes that terminate.
    ///
    /// **Day-of-month and day-of-week are OR'd** when both are restricted, as in Vixie
    /// cron: `0 0 1 * MON` is the first of the month *and* every Monday. It surprises
    /// people, and matching the standard surprises fewer of them than inventing a
    /// different rule.
    pub fn next_after(&self, after: OffsetDateTime) -> Option<OffsetDateTime> {
        let from = truncate_to_minute(after.to_offset(UtcOffset::UTC)) + Duration::minutes(1);
        let mut date = from.date();
        let mut hour = from.hour();
        let mut minute = from.minute();

        for _ in 0..MAX_SEARCH_DAYS {
            if self.day_matches(date)
                && let Some((h, m)) = self.first_slot_at_or_after(hour, minute)
            {
                return slot(date, h, m);
            }
            date = date.next_day()?;
            hour = 0;
            minute = 0;
        }
        None
    }

    /// The most recent firing instant at or before `at`, in UTC — the slot a tick is
    /// standing in for.
    ///
    /// This is the half of the search that makes "missed runs skipped" expressible: after
    /// downtime the scheduler fires *this* slot once, rather than replaying every slot it
    /// slept through.
    pub fn previous_at_or_before(&self, at: OffsetDateTime) -> Option<OffsetDateTime> {
        let from = truncate_to_minute(at.to_offset(UtcOffset::UTC));
        let mut date = from.date();
        let mut hour = from.hour();
        let mut minute = from.minute();

        for _ in 0..MAX_SEARCH_DAYS {
            if self.day_matches(date)
                && let Some((h, m)) = self.last_slot_at_or_before(hour, minute)
            {
                return slot(date, h, m);
            }
            date = date.previous_day()?;
            hour = 23;
            minute = 59;
        }
        None
    }

    /// Does this expression fire in the minute containing `at`?
    pub fn matches(&self, at: OffsetDateTime) -> bool {
        let at = at.to_offset(UtcOffset::UTC);
        bit(self.minutes, u64::from(at.minute()))
            && bit(self.hours, u64::from(at.hour()))
            && self.day_matches(at.date())
    }

    /// Firings strictly between `after` and `until` — how `missed` is counted, capped so a
    /// year of downtime does not produce a million-element walk.
    pub fn count_between(&self, after: OffsetDateTime, until: OffsetDateTime, cap: u32) -> u32 {
        let mut count = 0;
        let mut cursor = after;
        while count < cap {
            match self.next_after(cursor) {
                Some(next) if next < until => {
                    count += 1;
                    cursor = next;
                }
                _ => break,
            }
        }
        count
    }

    /// Month plus the day-of-month/day-of-week union rule.
    fn day_matches(&self, date: time::Date) -> bool {
        if !bit(self.months, u64::from(u8::from(date.month()))) {
            return false;
        }
        let dom = bit(self.days_of_month, u64::from(date.day()));
        let dow = bit(
            self.days_of_week,
            u64::from(date.weekday().number_days_from_sunday()),
        );
        match (self.dom_restricted, self.dow_restricted) {
            (true, true) => dom || dow,
            (true, false) => dom,
            (false, true) => dow,
            (false, false) => true,
        }
    }

    fn first_slot_at_or_after(&self, hour: u8, minute: u8) -> Option<(u8, u8)> {
        for h in hour..24 {
            if !bit(self.hours, u64::from(h)) {
                continue;
            }
            let start = if h == hour { minute } else { 0 };
            for m in start..60 {
                if bit(self.minutes, u64::from(m)) {
                    return Some((h, m));
                }
            }
        }
        None
    }

    fn last_slot_at_or_before(&self, hour: u8, minute: u8) -> Option<(u8, u8)> {
        for h in (0..=hour).rev() {
            if !bit(self.hours, u64::from(h)) {
                continue;
            }
            let end = if h == hour { minute } else { 59 };
            for m in (0..=end).rev() {
                if bit(self.minutes, u64::from(m)) {
                    return Some((h, m));
                }
            }
        }
        None
    }
}

fn bit(mask: u64, index: u64) -> bool {
    index < 64 && mask & (1 << index) != 0
}

fn truncate_to_minute(at: OffsetDateTime) -> OffsetDateTime {
    let time = Time::from_hms(at.hour(), at.minute(), 0).unwrap_or(Time::MIDNIGHT);
    at.replace_time(time)
}

fn slot(date: time::Date, hour: u8, minute: u8) -> Option<OffsetDateTime> {
    Time::from_hms(hour, minute, 0)
        .ok()
        .map(|time| OffsetDateTime::new_utc(date, time))
}

/// One comma-separated field to a bitmap.
fn parse_field(
    raw: &str,
    field: &'static str,
    lo: u64,
    hi: u64,
    names: Option<&[&str]>,
) -> Result<u64, CronParseError> {
    if raw.is_empty() {
        return Err(CronParseError::field(field, "empty"));
    }
    if let Some(bad) = raw.chars().find(|c| {
        !(c.is_ascii_alphanumeric() || matches!(c, '*' | ',' | '-' | '/' | '_' | '.' | '?'))
    }) {
        return Err(CronParseError::field(
            field,
            format!("illegal char `{bad}`"),
        ));
    }
    // `L` (last), `#` (nth weekday), `?` (either) and `W` (nearest weekday) are the
    // Quartz/extended dialect. Refused by name so the error says which feature, not
    // "invalid".
    if raw.contains('#') || raw.contains('?') {
        return Err(CronParseError::Unsupported(raw.to_string()));
    }
    if raw.eq_ignore_ascii_case("l") || raw.to_ascii_lowercase().ends_with('w') {
        return Err(CronParseError::Unsupported(raw.to_string()));
    }

    let mut mask = 0u64;
    for item in raw.split(',') {
        mask |= parse_item(item, field, lo, hi, names)?;
    }
    if mask == 0 {
        return Err(CronParseError::field(field, "selects nothing"));
    }
    Ok(mask)
}

fn parse_item(
    item: &str,
    field: &'static str,
    lo: u64,
    hi: u64,
    names: Option<&[&str]>,
) -> Result<u64, CronParseError> {
    if item.is_empty() {
        return Err(CronParseError::field(field, "empty list item"));
    }

    let (range, step) = match item.split_once('/') {
        Some((range, step)) => {
            let step: u64 = step
                .parse()
                .map_err(|_| CronParseError::field(field, format!("`{step}` is not a step")))?;
            if step == 0 {
                return Err(CronParseError::field(field, "step 0"));
            }
            (range, step)
        }
        None => (item, 1),
    };

    let (start, end) = if range == "*" {
        (lo, hi)
    } else if let Some((from, to)) = range.split_once('-') {
        (
            parse_value(from, field, lo, hi, names)?,
            parse_value(to, field, lo, hi, names)?,
        )
    } else {
        let value = parse_value(range, field, lo, hi, names)?;
        // A bare value with a step (`5/10`) is the GNU extension; Vixie needs a range,
        // and accepting it would make the same string mean two things on two servers.
        if step != 1 {
            return Err(CronParseError::field(
                field,
                format!("`{item}`: a step needs a range (`{value}-{hi}/{step}`)"),
            ));
        }
        (value, value)
    };

    if end < start {
        return Err(CronParseError::field(
            field,
            format!("range `{range}` counts backwards"),
        ));
    }

    let mut mask = 0u64;
    let mut value = start;
    while value <= end {
        mask |= 1 << value;
        value += step;
    }
    Ok(mask)
}

fn parse_value(
    raw: &str,
    field: &'static str,
    lo: u64,
    hi: u64,
    names: Option<&[&str]>,
) -> Result<u64, CronParseError> {
    let lowered = raw.to_ascii_lowercase();
    if let Some(names) = names
        && let Some(index) = names.iter().position(|name| *name == lowered)
    {
        // Month names are 1-based, day names 0-based — which is exactly `lo`.
        return Ok(lo + index as u64);
    }
    let value: u64 = raw
        .parse()
        .map_err(|_| CronParseError::field(field, format!("`{raw}` is not a number")))?;
    if value < lo || value > hi {
        return Err(CronParseError::field(
            field,
            format!("`{raw}` is outside {lo}–{hi}"),
        ));
    }
    Ok(value)
}

// ---------------------------------------------------------------------------
// The decision (pure)
// ---------------------------------------------------------------------------

/// What one tick should do with one job. Total, pure, and the whole of SPEC §6.3's cron
/// clauses — which is why it is a separate type from the scheduler that acts on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CronDecision {
    /// Nothing is due: no slot has passed since `last_run`.
    Idle,
    /// A slot is due but the previous run of this expression is still in flight. **It is
    /// not queued** — it is counted as missed, and the next tick after the run finishes
    /// fires the then-current slot (SPEC §6.3: "no overlapping executions").
    Overlapping { scheduled_for: OffsetDateTime },
    /// Fire once, standing in for `scheduled_for`, having skipped `missed` slots.
    Fire {
        scheduled_for: OffsetDateTime,
        missed: u32,
    },
}

/// The tick decision for one expression.
///
/// - `last_run` is what the record persists: the wall clock at which the previous run
///   *started*. It is compared against the slot rather than against `now`, so a run that
///   started late still counts as having covered its slot.
/// - **A job that has never run waits for a real slot.** Firing immediately on the first
///   tick after an install would mean approving a plugin at 15:00 runs its `0 6 * * *`
///   nightly job at 15:00 — a surprise, and not what "missed runs skipped" means. Downtime
///   catch-up only applies once there *is* a `last_run` to be behind.
/// - After downtime the answer is one [`CronDecision::Fire`] for the most recent slot, with
///   `missed` counting the slots between `last_run` and that one.
pub fn decide(
    schedule: &CronSchedule,
    last_run: Option<OffsetDateTime>,
    now: OffsetDateTime,
    running: bool,
) -> CronDecision {
    let Some(slot) = schedule.previous_at_or_before(now) else {
        return CronDecision::Idle;
    };

    match last_run {
        // Never run: only the slot we are standing in counts, so an install does not
        // trigger yesterday's job.
        None => {
            if !schedule.matches(now) {
                return CronDecision::Idle;
            }
            if running {
                return CronDecision::Overlapping {
                    scheduled_for: slot,
                };
            }
            CronDecision::Fire {
                scheduled_for: slot,
                missed: 0,
            }
        }
        Some(last) if last >= slot => CronDecision::Idle,
        Some(last) => {
            if running {
                return CronDecision::Overlapping {
                    scheduled_for: slot,
                };
            }
            CronDecision::Fire {
                scheduled_for: slot,
                // Strictly between: the slot being fired is not one of the misses.
                missed: schedule.count_between(last, slot, MAX_MISSED_COUNT),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

/// The scheduler: one task, a one-minute tick aligned to the wall clock.
///
/// A tick rather than a per-job timer, because the job set changes on every install and a
/// tick re-reads it for free. Sixty seconds of granularity is what cron means.
pub struct CronScheduler {
    state: AppState,
    limits: PluginLimits,
}

/// `(plugin, index)` of every cron run in flight — the no-overlap set of SPEC §6.3.
///
/// **Process-wide, not per-scheduler.** "No overlapping executions" is a statement about the
/// job, so every path that can start one has to consult the same set. While this lived as a
/// private field of [`CronScheduler`], the admin "run cron now" route
/// (`routes::plugin_api::run_cron`) could not see it and did not try: a manual run and a
/// scheduled run of the same job executed in parallel, four pool instances being plenty for
/// both. For the calendar that meant two `run_sync`es whose reconciliation reads both returned
/// the pre-write state, so both planned a `Create` for every new uid and the workspace got two
/// documents per event — permanently, since the write ledger cannot catch two brand-new ids
/// and there is no `delete_document`.
///
/// In memory because a run cannot survive a restart: a process that died mid-run has no run in
/// flight. One process is all there is (SPEC §8: explicitly single-replica); the named v2 seam
/// for HA is a leader-elected cron, which is where this becomes a distributed lock.
fn in_flight() -> &'static StdMutex<HashSet<(String, u32)>> {
    static IN_FLIGHT: OnceLock<StdMutex<HashSet<(String, u32)>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| StdMutex::new(HashSet::new()))
}

/// A claim on one `(plugin, index)` cron slot, released on drop.
///
/// A guard rather than a matched pair of calls: the release has to happen on *every* exit
/// from the run, and a job whose slot is never released never runs again for the life of the
/// process.
#[must_use = "dropping the guard immediately releases the cron slot"]
pub struct CronClaim {
    key: (String, u32),
}

impl CronClaim {
    /// Claim the slot, or `None` when a run of this job is already in flight.
    ///
    /// The lock is released **before** a `CronClaim` can exist, and that ordering is the whole
    /// of the function's correctness: the guard's `Drop` re-locks the same non-reentrant mutex,
    /// so constructing one while holding the guard self-deadlocks. `bool::then_some` does
    /// exactly that — its argument is evaluated by the caller, so a *refused* claim built the
    /// guard, dropped it immediately, and hung the thread. `then` with a closure is lazy, and the
    /// insert is a separate statement so the lock is gone either way.
    pub fn try_acquire(plugin_id: &str, index: u32) -> Option<CronClaim> {
        let key = (plugin_id.to_string(), index);
        let claimed = match in_flight().lock() {
            Ok(mut set) => set.insert(key.clone()),
            // A poisoned set cannot be reasoned about, so nothing starts. Refusing to run is
            // the safe half of "at most once".
            Err(_) => false,
        };
        claimed.then(|| CronClaim { key })
    }

    /// Is a run of this job in flight right now?
    pub fn is_running(plugin_id: &str, index: u32) -> bool {
        in_flight()
            .lock()
            .map(|set| set.contains(&(plugin_id.to_string(), index)))
            .unwrap_or(false)
    }
}

impl Drop for CronClaim {
    fn drop(&mut self) {
        if let Ok(mut set) = in_flight().lock() {
            set.remove(&self.key);
        }
    }
}

impl CronScheduler {
    pub fn spawn(state: crate::state::AppState) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            if !state.config.plugin_enable_cron {
                tracing::info!("plugin cron disabled (PLUGIN_ENABLE_CRON=0)");
                return;
            }
            let scheduler = CronScheduler::new(state);
            loop {
                tokio::time::sleep(until_next_minute(OffsetDateTime::now_utc())).await;
                let fired = scheduler.tick(OffsetDateTime::now_utc()).await;
                if fired > 0 {
                    tracing::debug!(jobs = fired, "plugin cron: jobs fired");
                }
            }
        })
    }

    pub fn new(state: AppState) -> Self {
        let limits = PluginLimits::from_config(&state.config);
        Self { state, limits }
    }

    /// Fire everything due at `now`. Returns how many invocations were started.
    ///
    /// Order per job: skip if already running (count a miss), skip if the breaker is open,
    /// invoke with the cron timeout, then persist `last_run` **whatever the outcome** —
    /// a job that fails must not be retried sixty seconds later forever.
    pub async fn tick(&self, now: OffsetDateTime) -> usize {
        let host = PluginHost::get(&self.state);
        let active = host.active();
        if active.is_empty() {
            return 0;
        }

        let persisted = self.load_cron_state().await;
        let mut fired = 0usize;

        for plugin in active {
            if plugin.cron.is_empty() {
                continue;
            }
            if !plugin.has_export(abi::names::CRON) {
                // Declared schedules with no handler: reported once per tick at debug
                // rather than per job, because it is an install-time mistake and the
                // install flow already refuses the manifest that causes it.
                tracing::debug!(
                    plugin = %plugin.id,
                    "plugin cron: schedules declared but `ddd_cron` is not exported"
                );
                continue;
            }
            let entries = persisted.get(&plugin.id);

            for (index, expression) in plugin.cron.iter().enumerate() {
                let index = u32::try_from(index).unwrap_or(u32::MAX);
                let schedule = match CronSchedule::parse(expression) {
                    Ok(schedule) => schedule,
                    Err(err) => {
                        // Unreachable through the installer (§7.1 validates every
                        // expression), so this is the "a record was written by hand"
                        // path: refuse the job, never the tick.
                        tracing::warn!(
                            plugin = %plugin.id, %expression, error = %err,
                            "plugin cron: unparseable expression, job skipped"
                        );
                        continue;
                    }
                };

                let stored = entries
                    .and_then(|entries| entries.iter().find(|entry| entry.index == index).cloned());
                let last_run = stored
                    .as_ref()
                    .and_then(|entry| entry.last_run)
                    .map(to_offset);
                let running = self.is_running(&plugin.id, index);

                match decide(&schedule, last_run, now, running) {
                    CronDecision::Idle => {}
                    CronDecision::Overlapping { scheduled_for } => {
                        tracing::warn!(
                            plugin = %plugin.id, %expression,
                            scheduled_for = %rfc3339(scheduled_for),
                            "plugin cron: slot skipped, previous run still in flight"
                        );
                    }
                    CronDecision::Fire {
                        scheduled_for,
                        missed,
                    } => {
                        self.fire(
                            Arc::clone(&host),
                            Arc::clone(&plugin),
                            index,
                            expression,
                            scheduled_for,
                            missed,
                            stored.as_ref().and_then(|entry| entry.last_run),
                            now,
                        )
                        .await;
                        fired += 1;
                    }
                }
            }
        }

        fired
    }

    /// Start one run: persist `last_run` first, then invoke on a task of its own so one
    /// slow job cannot delay the tick (and therefore every other plugin's schedule).
    #[allow(clippy::too_many_arguments)]
    async fn fire(
        &self,
        host: Arc<PluginHost>,
        plugin: Arc<super::ActivePlugin>,
        index: u32,
        expression: &str,
        scheduled_for: OffsetDateTime,
        missed: u32,
        last_run: Option<Timestamp>,
        now: OffsetDateTime,
    ) {
        let fired_at = Timestamp::from_millis(now.unix_timestamp() * 1_000);
        let payload = abi::cron::CronPayload {
            expression: expression.to_string(),
            index,
            scheduled_for: rfc3339(scheduled_for),
            fired_at: fired_at.to_rfc3339(),
            last_run: last_run.map(Timestamp::to_rfc3339),
            missed,
            deadline_ms: u64::try_from(self.limits.cron_timeout.as_millis()).unwrap_or(u64::MAX),
        };

        let expression_owned = expression.to_string();

        // **Claim the slot before anything is persisted.** `decide` already reported "not
        // running", but that check and this insert are not one critical section, so the claim
        // is what actually decides. Recording `last_run` first meant a lost race left the
        // record claiming a completed run that never happened — `runs` incremented,
        // `last_status` stuck at `"running"`, and `decide` treating the slot as covered so the
        // job did not run until the next one.
        let Some(claim) = CronClaim::try_acquire(&plugin.id, index) else {
            tracing::debug!(
                plugin = %plugin.id, index,
                "plugin cron: a run of this job is already in flight; not firing"
            );
            return;
        };

        // `last_run` is written **before** the call, so a crash mid-run does not re-fire on
        // boot (SPEC §6.3: "`last_run` persisted"). The cost is stated rather than hidden:
        // a run that dies leaves its slot recorded as taken, and the next slot is the
        // recovery — which is what "at-most-once, reconcile on the next run" means
        // everywhere else in this subsystem too.
        self.update_entry(&plugin.id, index, &expression_owned, |entry| {
            entry.last_run = Some(fired_at);
            entry.runs = entry.runs.saturating_add(1);
            entry.last_status = Some("running".to_string());
        })
        .await;

        let invocation = Invocation::top_level(
            plugin.id.clone(),
            CallKind::Cron { index },
            serde_json::to_value(&payload).unwrap_or(serde_json::Value::Null),
            &self.limits,
        );

        let state = self.state.clone();
        let scheduler_state = self.state.clone();
        tokio::spawn(async move {
            let outcome = host.call(&state, invocation).await;
            let status = match &outcome {
                Ok(call) => {
                    tracing::info!(
                        plugin = %plugin.id, index, expression = %expression_owned,
                        duration_ms = call.duration.as_millis(),
                        writes = call.writes,
                        "plugin cron: run finished"
                    );
                    "ok".to_string()
                }
                Err(err) => {
                    tracing::warn!(
                        plugin = %plugin.id, index, expression = %expression_owned,
                        error = %err,
                        "plugin cron: run failed"
                    );
                    err_code(err)
                }
            };
            let failed = outcome.is_err();
            update_entry_on(
                &scheduler_state,
                &plugin.id,
                index,
                &expression_owned,
                |entry| {
                    entry.last_status = Some(status);
                    if failed {
                        entry.failures = entry.failures.saturating_add(1);
                    }
                },
            )
            .await;
            // Released here, by dropping the guard — including if the task above panics.
            drop(claim);
        });
    }

    fn is_running(&self, plugin_id: &str, index: u32) -> bool {
        CronClaim::is_running(plugin_id, index)
    }

    /// Every plugin's persisted cron state, in one read per tick.
    async fn load_cron_state(&self) -> HashMap<String, Vec<CronState>> {
        let mut map = HashMap::new();
        let collection = self.state.collections.raw(crate::db::PLUGINS);
        let cursor = collection
            .find(doc! {})
            .projection(doc! { "_id": 1, "cron_state": 1 })
            .await;
        let mut cursor = match cursor {
            Ok(cursor) => cursor,
            Err(err) => {
                tracing::warn!(error = %err, "plugin cron: cannot read plugin records");
                return map;
            }
        };
        use futures::StreamExt;
        while let Some(next) = cursor.next().await {
            let Ok(record) = next else { continue };
            let Ok(id) = record.get_str("_id") else {
                continue;
            };
            let entries = record
                .get_array("cron_state")
                .ok()
                .map(|array| {
                    array
                        .iter()
                        .filter_map(|value| {
                            bson::from_bson::<CronState>(value.clone())
                                .inspect_err(|err| {
                                    tracing::warn!(
                                        plugin = %id, error = %err,
                                        "plugin cron: unreadable cron_state entry, ignored"
                                    );
                                })
                                .ok()
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            map.insert(id.to_string(), entries);
        }
        map
    }

    async fn update_entry(
        &self,
        plugin_id: &str,
        index: u32,
        expression: &str,
        mutate: impl FnOnce(&mut CronState),
    ) {
        update_entry_on(&self.state, plugin_id, index, expression, mutate).await;
    }
}

/// Read-modify-write one `cron_state` entry.
///
/// The whole array is rewritten rather than updated in place with `arrayFilters`, because
/// the scheduler is the only writer of this field and the array is a handful of entries:
/// the simpler write is the one whose failure mode is obvious. A lost update here costs one
/// duplicated cron run, never a document.
async fn update_entry_on(
    state: &AppState,
    plugin_id: &str,
    index: u32,
    expression: &str,
    mutate: impl FnOnce(&mut CronState),
) {
    let collection = state.collections.raw(crate::db::PLUGINS);
    let existing = match collection
        .find_one(doc! { "_id": plugin_id })
        .projection(doc! { "cron_state": 1 })
        .await
    {
        Ok(Some(record)) => record,
        Ok(None) => {
            tracing::warn!(plugin = %plugin_id, "plugin cron: no record to persist last_run on");
            return;
        }
        Err(err) => {
            tracing::warn!(plugin = %plugin_id, error = %err, "plugin cron: cannot read record");
            return;
        }
    };

    let mut entries: Vec<CronState> = existing
        .get_array("cron_state")
        .ok()
        .map(|array| {
            array
                .iter()
                .filter_map(|value| bson::from_bson::<CronState>(value.clone()).ok())
                .collect()
        })
        .unwrap_or_default();

    let position = entries.iter().position(|entry| entry.index == index);
    let entry = match position {
        Some(position) => &mut entries[position],
        None => {
            entries.push(CronState {
                index,
                expression: expression.to_string(),
                last_run: None,
                last_status: None,
                runs: 0,
                failures: 0,
            });
            entries.last_mut().expect("just pushed")
        }
    };
    entry.expression = expression.to_string();
    mutate(entry);

    let serialized = match bson::to_bson(&entries) {
        Ok(value) => value,
        Err(err) => {
            tracing::error!(plugin = %plugin_id, error = %err, "plugin cron: cannot encode cron_state");
            return;
        }
    };
    if let Err(err) = collection
        .update_one(
            doc! { "_id": plugin_id },
            doc! { "$set": { "cron_state": serialized } },
        )
        .await
    {
        tracing::warn!(plugin = %plugin_id, error = %err, "plugin cron: cannot persist cron_state");
    }
}

fn err_code(error: &super::PluginHostError) -> String {
    use super::PluginHostError as E;
    match error {
        E::Timeout { .. } => "timeout",
        E::Trap { .. } => "trap",
        E::BadResponse { .. } => "bad_response",
        E::Disabled { .. } => "disabled",
        E::NotActive(_) => "not_active",
        E::NoExport { .. } => "no_export",
        E::AbiMismatch { .. } => "abi_mismatch",
        E::PoolExhausted { .. } => "pool_exhausted",
        E::Instantiate { .. } => "instantiate",
        E::ShuttingDown => "shutting_down",
        E::Internal(_) => "internal",
    }
    .to_string()
}

fn rfc3339(at: OffsetDateTime) -> String {
    Timestamp::from_millis(at.unix_timestamp() * 1_000).to_rfc3339()
}

fn to_offset(stamp: Timestamp) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(stamp.timestamp_millis()) * 1_000_000)
        .unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

/// Time until the next wall-clock minute boundary, plus [`TICK_OFFSET`].
fn until_next_minute(now: OffsetDateTime) -> StdDuration {
    let seconds = u64::from(now.second());
    let nanos = u64::from(now.nanosecond());
    let remaining = StdDuration::from_secs(60)
        .saturating_sub(StdDuration::new(seconds, u32::try_from(nanos).unwrap_or(0)));
    remaining + TICK_OFFSET
}

/// Persisted per expression, on the plugin's record.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CronState {
    pub index: u32,
    pub expression: String,
    /// RFC 3339 UTC of the last run that started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<crate::domain::Timestamp>,
    /// `"ok"`, or the error code of the last failure — what the admin screen shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
    #[serde(default)]
    pub runs: u64,
    #[serde(default)]
    pub failures: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    fn schedule(expression: &str) -> CronSchedule {
        CronSchedule::parse(expression).expect("parses")
    }

    #[test]
    fn the_five_standard_field_forms_parse() {
        assert!(schedule("0 6 * * *").matches(datetime!(2026-09-24 06:00 UTC)));
        assert!(!schedule("0 6 * * *").matches(datetime!(2026-09-24 06:01 UTC)));

        let quarter = schedule("*/15 * * * *");
        for minute in [0, 15, 30, 45] {
            assert!(quarter.matches(datetime!(2026-09-24 10:00 UTC) + Duration::minutes(minute)));
        }
        assert!(!quarter.matches(datetime!(2026-09-24 10:07 UTC)));

        // Lists, ranges, stepped ranges, and names in both name fields.
        assert!(schedule("5,10 1-3 * * *").matches(datetime!(2026-09-24 02:10 UTC)));
        assert!(schedule("0 0-23/6 * * *").matches(datetime!(2026-09-24 18:00 UTC)));
        assert!(schedule("0 0 1 JAN *").matches(datetime!(2026-01-01 00:00 UTC)));
        assert!(schedule("0 0 * * FRI").matches(datetime!(2026-09-25 00:00 UTC)));
        // 0 and 7 are both Sunday.
        assert_eq!(schedule("0 0 * * 0"), schedule("0 0 * * 7"));
        assert!(schedule("0 0 * * 7").matches(datetime!(2026-09-27 00:00 UTC)));
    }

    #[test]
    fn day_of_month_and_day_of_week_are_ored_when_both_are_restricted() {
        // Vixie cron: the first of the month *and* every Monday.
        let both = schedule("0 0 1 * MON");
        assert!(both.matches(datetime!(2026-09-01 00:00 UTC))); // a Tuesday, but the 1st
        assert!(both.matches(datetime!(2026-09-07 00:00 UTC))); // a Monday, not the 1st
        assert!(!both.matches(datetime!(2026-09-08 00:00 UTC)));

        // Only one restricted ⇒ that one decides, no union.
        let dom_only = schedule("0 0 1 * *");
        assert!(dom_only.matches(datetime!(2026-09-01 00:00 UTC)));
        assert!(!dom_only.matches(datetime!(2026-09-07 00:00 UTC)));
    }

    #[test]
    fn malformed_expressions_are_parse_errors_rather_than_surprising_schedules() {
        assert_eq!(
            CronSchedule::parse("0 6 * *"),
            Err(CronParseError::FieldCount { found: 4 })
        );
        assert!(matches!(
            CronSchedule::parse("@daily"),
            Err(CronParseError::Unsupported(_))
        ));
        // A seconds field is six fields, not a minute of 0.
        assert!(matches!(
            CronSchedule::parse("0 0 6 * * *"),
            Err(CronParseError::FieldCount { found: 6 })
        ));
        for bad in [
            "60 * * * *",   // minute out of range
            "0 24 * * *",   // hour out of range
            "0 0 0 * *",    // day-of-month is 1-based
            "0 0 * 13 *",   // month out of range
            "0 0 * * 8",    // day-of-week out of range
            "*/0 * * * *",  // zero step
            "5-1 * * * *",  // backwards range
            "0 0 L * *",    // Quartz "last"
            "0 0 * * 5#2",  // Quartz "nth weekday"
            "0 0 ? * *",    // Quartz "either"
            "5/10 * * * *", // a step without a range
            "x * * * *",
        ] {
            assert!(
                CronSchedule::parse(bad).is_err(),
                "`{bad}` must not parse into a schedule"
            );
        }
    }

    #[test]
    fn next_after_walks_hours_days_months_and_leap_years() {
        let daily = schedule("0 6 * * *");
        assert_eq!(
            daily.next_after(datetime!(2026-09-24 05:59 UTC)),
            Some(datetime!(2026-09-24 06:00 UTC))
        );
        // Strictly after: standing on the slot yields tomorrow's.
        assert_eq!(
            daily.next_after(datetime!(2026-09-24 06:00 UTC)),
            Some(datetime!(2026-09-25 06:00 UTC))
        );
        // Month boundary.
        assert_eq!(
            daily.next_after(datetime!(2026-09-30 23:59 UTC)),
            Some(datetime!(2026-10-01 06:00 UTC))
        );
        // A leap day is reachable and terminates.
        assert_eq!(
            schedule("0 0 29 2 *").next_after(datetime!(2026-09-24 00:00 UTC)),
            Some(datetime!(2028-02-29 00:00 UTC))
        );
        // 30 February can never fire, and saying so must not loop forever.
        assert_eq!(
            schedule("0 0 30 2 *").next_after(datetime!(2026-09-24 00:00 UTC)),
            None
        );
    }

    #[test]
    fn previous_at_or_before_finds_the_slot_a_tick_stands_in_for() {
        let daily = schedule("0 6 * * *");
        assert_eq!(
            daily.previous_at_or_before(datetime!(2026-09-24 06:00 UTC)),
            Some(datetime!(2026-09-24 06:00 UTC))
        );
        assert_eq!(
            daily.previous_at_or_before(datetime!(2026-09-24 05:59 UTC)),
            Some(datetime!(2026-09-23 06:00 UTC))
        );
        assert_eq!(
            schedule("0 0 1 * *").previous_at_or_before(datetime!(2026-10-05 12:00 UTC)),
            Some(datetime!(2026-10-01 00:00 UTC))
        );
    }

    #[test]
    fn count_between_counts_strictly_between_and_respects_the_cap() {
        let daily = schedule("0 6 * * *");
        assert_eq!(
            daily.count_between(
                datetime!(2026-09-21 06:00 UTC),
                datetime!(2026-09-24 06:00 UTC),
                100
            ),
            2
        );
        assert_eq!(
            daily.count_between(
                datetime!(2026-09-23 06:00 UTC),
                datetime!(2026-09-24 06:00 UTC),
                100
            ),
            0
        );
        assert_eq!(
            daily.count_between(
                datetime!(2020-01-01 06:00 UTC),
                datetime!(2026-09-24 06:00 UTC),
                5
            ),
            5
        );
    }

    // ---- the scheduler's decision, on a fake clock -------------------------

    #[test]
    fn a_job_that_has_never_run_waits_for_a_real_slot() {
        let daily = schedule("0 6 * * *");
        assert_eq!(
            decide(&daily, None, datetime!(2026-09-24 15:00 UTC), false),
            CronDecision::Idle,
            "approving a plugin at 15:00 must not run its 06:00 job at 15:00"
        );
        assert_eq!(
            decide(&daily, None, datetime!(2026-09-24 06:00 UTC), false),
            CronDecision::Fire {
                scheduled_for: datetime!(2026-09-24 06:00 UTC),
                missed: 0
            }
        );
    }

    #[test]
    fn a_slot_already_covered_by_last_run_is_idle() {
        let daily = schedule("0 6 * * *");
        // The run started two seconds into its slot; the rest of that minute's ticks and
        // the whole day after it are idle.
        let last = Some(datetime!(2026-09-24 06:00:02 UTC));
        assert_eq!(
            decide(&daily, last, datetime!(2026-09-24 06:00:30 UTC), false),
            CronDecision::Idle
        );
        assert_eq!(
            decide(&daily, last, datetime!(2026-09-24 23:59 UTC), false),
            CronDecision::Idle
        );
    }

    #[test]
    fn downtime_fires_once_and_reports_the_slots_it_slept_through() {
        let daily = schedule("0 6 * * *");
        // Down from the 21st's run until the 24th at 07:00: the 22nd and 23rd were missed,
        // the 24th's slot is the one that fires, and it fires *once*.
        let decision = decide(
            &daily,
            Some(datetime!(2026-09-21 06:00 UTC)),
            datetime!(2026-09-24 07:00 UTC),
            false,
        );
        assert_eq!(
            decision,
            CronDecision::Fire {
                scheduled_for: datetime!(2026-09-24 06:00 UTC),
                missed: 2
            }
        );

        // And once it has fired, the same tick a minute later is idle — "once when it
        // returns", not once per missed slot.
        assert_eq!(
            decide(
                &daily,
                Some(datetime!(2026-09-24 07:00 UTC)),
                datetime!(2026-09-24 07:01 UTC),
                false
            ),
            CronDecision::Idle
        );
    }

    #[test]
    fn a_slot_arriving_while_the_previous_run_is_in_flight_does_not_overlap() {
        let quarter = schedule("*/15 * * * *");
        let last = Some(datetime!(2026-09-24 10:00 UTC));

        // 10:15 is due, but 10:00's run has not finished.
        assert_eq!(
            decide(&quarter, last, datetime!(2026-09-24 10:15 UTC), true),
            CronDecision::Overlapping {
                scheduled_for: datetime!(2026-09-24 10:15 UTC)
            }
        );
        // The skipped slot is never queued: once the run finishes, the *then-current* slot
        // fires and the skipped one is counted as missed.
        assert_eq!(
            decide(&quarter, last, datetime!(2026-09-24 10:30 UTC), false),
            CronDecision::Fire {
                scheduled_for: datetime!(2026-09-24 10:30 UTC),
                missed: 1
            }
        );
    }

    #[test]
    fn the_tick_aligns_to_the_wall_clock_minute() {
        let at = datetime!(2026-09-24 10:00:15 UTC);
        let wait = until_next_minute(at);
        assert_eq!(wait, StdDuration::from_secs(45) + TICK_OFFSET);
        // Exactly on the boundary still waits a whole minute rather than firing twice.
        assert_eq!(
            until_next_minute(datetime!(2026-09-24 10:00:00 UTC)),
            StdDuration::from_secs(60) + TICK_OFFSET
        );
    }

    #[test]
    fn timestamps_round_trip_through_the_record_form() {
        let at = datetime!(2026-09-24 06:00 UTC);
        assert_eq!(rfc3339(at), "2026-09-24T06:00:00Z");
        assert_eq!(
            to_offset(Timestamp::from_millis(at.unix_timestamp() * 1000)),
            at
        );
    }

    /// "No overlapping executions" (SPEC §6.3) is a property of the *job*, so every path that
    /// can start one has to consult the same set — the scheduler tick and the admin
    /// "run cron now" route alike. While this set was a private field of `CronScheduler` the
    /// route could not see it and did not try, and a button press ran in parallel with the
    /// 06:00 tick: for the calendar, two reconciliations that each read the pre-write state and
    /// each created a document per event, permanently.
    #[test]
    fn a_cron_slot_can_only_be_claimed_once_at_a_time() {
        let plugin = format!("claim-test-{}", crate::domain::new_id());

        assert!(!CronClaim::is_running(&plugin, 0));
        let first = CronClaim::try_acquire(&plugin, 0).expect("the slot is free");
        assert!(CronClaim::is_running(&plugin, 0));
        assert!(
            CronClaim::try_acquire(&plugin, 0).is_none(),
            "a second claim on a running job must be refused"
        );

        // A different index of the same plugin, and the same index of another plugin, are
        // different jobs.
        let other_index = CronClaim::try_acquire(&plugin, 1).expect("a different job");
        let other_plugin =
            CronClaim::try_acquire(&format!("{plugin}-b"), 0).expect("a different plugin");

        // Released by drop, on every path out of a run — including an unwind.
        drop(first);
        assert!(!CronClaim::is_running(&plugin, 0));
        assert!(CronClaim::try_acquire(&plugin, 0).is_some());
        drop(other_index);
        drop(other_plugin);
    }

    /// A claim dropped while unwinding still releases. Without this, one panicking run would
    /// wedge that job for the life of the process.
    #[test]
    fn a_panicking_run_still_releases_its_slot() {
        let plugin = format!("claim-panic-{}", crate::domain::new_id());
        let outcome = std::panic::catch_unwind(|| {
            let _claim = CronClaim::try_acquire(&plugin, 0).expect("the slot is free");
            panic!("the job blew up");
        });
        assert!(outcome.is_err());
        assert!(
            !CronClaim::is_running(&plugin, 0),
            "the slot was never released"
        );
    }
}

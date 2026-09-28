//! Document hooks: from a change-feed notice to a plugin invocation (SPEC §6.3).
//!
//! # Where a hook comes from
//!
//! Not from the docstore, and not from a new callback: from the **change feed** the sync
//! layer already publishes ([`crate::feed::ChangeFeed::subscribe`]). Every projection
//! change allocates a sequence number and broadcasts a [`crate::feed::FeedNotice`] — so
//! hooks ride the same stream every client does, which means a hook can never fire for a
//! change clients will not see, and vice versa.
//!
//! # The rules, and what each one costs
//!
//! - **Debounced 2 s per document.** A burst of keystrokes is one invocation carrying the
//!   latest state and a `coalesced` count. Cost: a hook is *late* by up to two seconds,
//!   deliberately.
//! - **At-most-once, no retry.** A failure is logged and counted on the breaker. Cost: a
//!   plugin that must not miss a change has to reconcile on its cron run rather than
//!   trusting hooks — a full reconciliation is the shape that survives a missed delivery.
//! - **Never delivered to the plugin that caused the change.** The origin comes from the
//!   row's `updated_by` (`plugin:<id>`), which is "the last applier the server saw"
//!   (SPEC §3.5). **Known consequence, stated rather than discovered:** when a user and a
//!   plugin both touch one document inside the debounce window, the last applier wins the
//!   attribution, so the delivery can be suppressed for a change the user actually made.
//!   The alternative — per-hook origin tracking through the CRDT — costs far more than a
//!   two-second edge case is worth, and the per-document write cap catches the loops this
//!   would otherwise miss.
//! - **Ordering is per-document only.** There is no global order and nothing may assume
//!   one. It is enforced by dispatching **one task per document** and holding that
//!   document's id in the queue's in-flight set until the task finishes: a document whose
//!   previous delivery is still running has its next delivery *deferred* — and therefore
//!   coalesced further — never started alongside it.
//! - **The payload is capability-gated:** no `documents:read`, no document in the payload
//!   (SPEC §6.2).
//!
//! # Which hook, and how it is decided
//!
//! The feed deliberately does not distinguish "created" from "edited" — both are
//! [`FeedChangeKind::Upsert`], because a client's answer to either is "re-read this row".
//! A hook does have to distinguish them, so the kind is resolved in two steps:
//!
//! 1. the **newest** notice in the debounce window picks the shape (`Tombstoned` →
//!    `document.deleted`, `Restored` → `document.changed`, `Upsert` → provisionally
//!    `document.changed`);
//! 2. a provisional `document.changed` is promoted to `document.created` when the row says
//!    `created_at == updated_at` — true exactly once, because `MongoDocStore::create`
//!    writes both from one instant and every later applied update bumps `updated_at`.
//!
//! Step 1 uses the *newest* notice rather than a merge rule, because a delivery carries the
//! document's **current** state: a create-then-trash inside two seconds is one
//! `document.deleted` (the document is in Trash now), and a trash-then-restore is one
//! `document.changed` (it is back).
//!
//! # Two loop backstops, and which one lives here
//!
//! SPEC §6.3 names both: a plugin never receives a hook for *its own* change (structural —
//! [`should_deliver`]), and a per-plugin-per-document **write** cap of 10/min
//! ([`super::limits::WriteLedger`], enforced where the writes happen). This module adds the
//! delivery-side half of that same budget — [`HOOK_DELIVERIES_PER_DOCUMENT_PER_MINUTE`] —
//! because the write cap alone breaks a loop only *after* every iteration has paid for a
//! Wasm invocation, a document read and a refused write. Two plugins echoing each other
//! through one document stop here after ten deliveries a minute, rather than spinning at
//! ten refused writes a minute forever.
//!
//! **Owner:** the `hooks-cron` builder.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use std::time::{Duration, Instant};

use life_manager_plugin_abi as abi;

use crate::domain::{Document, Id, Timestamp};
use crate::feed::{FeedChangeKind, FeedNotice};
use crate::state::AppState;
use crate::telemetry::names;

use super::limits::PluginLimits;
use super::{ActivePlugin, CallKind, Invocation, PluginHost};

/// SPEC §6.3: "debounced 2 s per doc".
pub const HOOK_DEBOUNCE: Duration = Duration::from_secs(2);

/// How long a coalescing entry may keep being extended before it fires anyway. Without a
/// ceiling, a document edited every 1.9 s never delivers a hook at all.
pub const HOOK_MAX_DELAY: Duration = Duration::from_secs(30);

/// Pending deliveries the debouncer holds, so `/metrics` can show a backlog rather than a
/// mystery.
pub const HOOK_QUEUE_WARN_LEN: usize = 10_000;

/// How often the debouncer looks for due entries. Finer than the debounce by a factor of
/// eight: the tick is the *granularity* of "2 s", not a second scheduling policy.
pub const HOOK_TICK: Duration = Duration::from_millis(250);

/// The delivery-side loop backstop, per `(plugin, document)` (see the module docs). The
/// same number as the write cap it complements: one budget, two enforcement points.
pub const HOOK_DELIVERIES_PER_DOCUMENT_PER_MINUTE: u32 =
    abi::limits::MAX_WRITES_PER_DOCUMENT_PER_MINUTE;

/// The sliding window the cap above is counted over.
pub const HOOK_RATE_WINDOW: Duration = Duration::from_secs(60);

/// Pending deliveries across the process, so [`super::PluginHostStats`] can report the
/// backlog without holding the dispatcher. A server has one dispatcher; the integration
/// tests build several `AppState`s, which only makes this number a sum — which is what a
/// backlog gauge wants anyway.
static PENDING: AtomicUsize = AtomicUsize::new(0);

/// The debouncer's current backlog — for [`super::PluginHostStats::hooks_pending`].
pub fn pending_count() -> usize {
    PENDING.load(Ordering::Relaxed)
}

/// One coalesced pending hook for one document.
#[derive(Debug, Clone)]
pub struct PendingHook {
    pub document_id: Id,
    pub kind: abi::hooks::HookKind,
    pub seq: i64,
    pub coalesced: u32,
    /// When it becomes due.
    pub due: Instant,
    /// When the first change in this window arrived (bounds the delay).
    pub first_seen: Instant,
    /// `true` when the newest notice in this window was a plain upsert — the only case in
    /// which the delivery may be promoted to `document.created` (see the module docs).
    pub promotable: bool,
}

impl PendingHook {
    /// The window's deadline: two seconds after the newest change, but never more than
    /// [`HOOK_MAX_DELAY`] after the first.
    fn deadline(first_seen: Instant, now: Instant) -> Instant {
        (now + HOOK_DEBOUNCE).min(first_seen + HOOK_MAX_DELAY)
    }
}

/// The debouncer's whole mutable state, with **no database and no plugin host** in it.
///
/// Separate from [`HookDispatcher`] on purpose: coalescing, the delay ceiling,
/// per-document ordering and the delivery cap are the parts that have to be right, and
/// none of them needs Mongo — so all of them are unit-testable against a supplied clock
/// rather than against a sleeping integration test.
pub struct HookQueue {
    pending: StdMutex<HashMap<Id, PendingHook>>,
    /// Documents whose delivery task is still running — the per-document ordering lock.
    /// The queue itself is held behind an `Arc`, so a spawned task clears its own entry
    /// through [`HookQueue::release`].
    in_flight: StdMutex<HashSet<Id>>,
    /// Sliding delivery windows per `(plugin, document)`: the loop backstop.
    deliveries: StdMutex<HashMap<(String, Id), VecDeque<Instant>>>,
    /// When the delivery windows were last swept. The sweep is driven from
    /// [`HookQueue::take_due`] — i.e. from this module's own tick — rather than from the
    /// host's maintenance loop, so that a map with one key per `(plugin, document)` ever
    /// touched cannot grow forever because a caller elsewhere forgot to call `sweep`.
    last_sweep: StdMutex<Instant>,
    /// Latch so a sustained backlog warns once rather than four times a second.
    warned: AtomicBool,
}

impl Default for HookQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl HookQueue {
    pub fn new() -> Self {
        Self {
            pending: StdMutex::new(HashMap::new()),
            in_flight: StdMutex::new(HashSet::new()),
            deliveries: StdMutex::new(HashMap::new()),
            last_sweep: StdMutex::new(Instant::now()),
            warned: AtomicBool::new(false),
        }
    }

    /// Fold one feed notice into the pending map.
    ///
    /// `Purged` is deliberately **not** a hook: a purge is the end of a document's
    /// existence 30 days after the delete that already fired `document.deleted`, and a
    /// plugin has nothing useful to do with it.
    pub fn observe(&self, notice: &FeedNotice) {
        self.observe_at(notice, Instant::now());
    }

    /// [`HookQueue::observe`] with the clock supplied — the seam the debounce tests use.
    pub fn observe_at(&self, notice: &FeedNotice, now: Instant) {
        let Some((kind, promotable)) = shape_of(notice.kind) else {
            return;
        };

        let len = {
            let mut pending = self.pending();
            match pending.entry(notice.id.clone()) {
                Entry::Occupied(mut occupied) => {
                    let entry = occupied.get_mut();
                    // The newest notice decides the shape, and `seq` follows it, so the
                    // delivery describes the document as it is now.
                    entry.kind = kind;
                    entry.promotable = promotable;
                    entry.seq = entry.seq.max(notice.seq);
                    entry.coalesced = entry.coalesced.saturating_add(1);
                    entry.due = PendingHook::deadline(entry.first_seen, now);
                }
                Entry::Vacant(vacant) => {
                    vacant.insert(PendingHook {
                        document_id: notice.id.clone(),
                        kind,
                        seq: notice.seq,
                        coalesced: 1,
                        due: PendingHook::deadline(now, now),
                        first_seen: now,
                        promotable,
                    });
                }
            }
            pending.len()
        };
        self.publish_backlog(len);
    }

    /// Entries whose window has closed, removed from the map and marked in flight.
    ///
    /// A document whose previous delivery is still running is skipped **and kept**, with
    /// its deadline pushed out by one debounce — that is what makes per-document ordering
    /// hold without a queue per document.
    pub fn take_due(&self, now: Instant) -> Vec<PendingHook> {
        let mut due = Vec::new();
        let len = {
            let mut pending = self.pending();
            let mut in_flight = self.in_flight();
            let ready: Vec<Id> = pending
                .values()
                .filter(|entry| entry.due <= now)
                .map(|entry| entry.document_id.clone())
                .collect();
            for id in ready {
                if in_flight.contains(&id) {
                    if let Some(entry) = pending.get_mut(&id) {
                        entry.due = now + HOOK_DEBOUNCE;
                    }
                    continue;
                }
                if let Some(entry) = pending.remove(&id) {
                    in_flight.insert(id);
                    due.push(entry);
                }
            }
            pending.len()
        };
        self.publish_backlog(len);
        self.sweep_if_stale(now);
        due
    }

    /// Sweep the delivery windows at most once per window length.
    ///
    /// On the tick rather than on a separate schedule: `take_due` runs four times a second
    /// anyway, and a map that is only pruned by an external caller is a map that leaks the
    /// first time that caller is refactored.
    fn sweep_if_stale(&self, now: Instant) {
        {
            let mut last = self
                .last_sweep
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if now.saturating_duration_since(*last) < HOOK_RATE_WINDOW {
                return;
            }
            *last = now;
        }
        self.sweep_at(now);
    }

    /// Clear a document's in-flight mark — called when its delivery task finishes, and
    /// directly when no task was spawned for it after all.
    ///
    /// Prefer [`HookQueue::claim`] for anything that spawns: see why there.
    pub fn release(&self, document_id: &str) {
        self.in_flight().remove(document_id);
    }

    /// An in-flight mark that clears itself on drop.
    ///
    /// **A release that only runs at the end of a task is not a release.** `take_due` marks a
    /// document in flight and `flush_due` spawns a task whose last statement cleared the mark;
    /// anything that skipped that statement — a panic anywhere inside the delivery, an abort at
    /// shutdown — left the id in `in_flight` forever. `take_due` then took the
    /// `in_flight.contains` branch on every tick and pushed the entry's deadline out by another
    /// debounce, so that document's hooks stalled for the life of the process while its pending
    /// entry was retained: silent, self-healing-looking, and visible only as a permanently
    /// non-zero `lm_plugin_hooks_pending`.
    ///
    /// A guard whose `Drop` runs on every one of those paths is the difference.
    #[must_use = "dropping the claim immediately clears the in-flight mark"]
    pub fn claim(self: &Arc<Self>, document_id: &str) -> HookClaim {
        HookClaim {
            queue: Arc::clone(self),
            document_id: document_id.to_string(),
        }
    }

    /// Record one delivery against the per-`(plugin, document)` window, or refuse it.
    ///
    /// Refusing is the loop backstop (see the module docs): a plugin being woken ten times
    /// a minute about one document is in a loop, not doing work.
    pub fn allow_delivery(&self, plugin_id: &str, document_id: &str) -> bool {
        self.allow_delivery_at(plugin_id, document_id, Instant::now())
    }

    /// [`HookQueue::allow_delivery`] with the clock supplied.
    pub fn allow_delivery_at(&self, plugin_id: &str, document_id: &str, now: Instant) -> bool {
        let mut windows = self.deliveries();
        let window = windows
            .entry((plugin_id.to_string(), document_id.to_string()))
            .or_default();
        prune(window, now);
        if window.len() >= HOOK_DELIVERIES_PER_DOCUMENT_PER_MINUTE as usize {
            drop(windows);
            metrics::counter!(
                names::PLUGIN_HOOKS_DELIVERED,
                "plugin" => plugin_id.to_string(),
                "outcome" => "rate_capped",
            )
            .increment(1);
            tracing::warn!(
                plugin = %plugin_id, document = %document_id,
                limit = HOOK_DELIVERIES_PER_DOCUMENT_PER_MINUTE,
                "plugin hooks: delivery cap reached for this document; hook suppressed \
                 (loop backstop, SPEC §6.3)"
            );
            return false;
        }
        window.push_back(now);
        true
    }

    /// Drop windows that have fully aged out. Called from the maintenance loop; returns how
    /// many windows are still live.
    pub fn sweep(&self) -> usize {
        self.sweep_at(Instant::now())
    }

    /// [`HookQueue::sweep`] with the clock supplied.
    pub fn sweep_at(&self, now: Instant) -> usize {
        let mut windows = self.deliveries();
        for window in windows.values_mut() {
            prune(window, now);
        }
        windows.retain(|_, window| !window.is_empty());
        windows.len()
    }

    /// How many documents are waiting for their window to close.
    pub fn pending_len(&self) -> usize {
        self.pending().len()
    }

    fn publish_backlog(&self, len: usize) {
        PENDING.store(len, Ordering::Relaxed);
        metrics::gauge!(names::PLUGIN_HOOKS_PENDING).set(len as f64);
        if len >= HOOK_QUEUE_WARN_LEN {
            if !self.warned.swap(true, Ordering::Relaxed) {
                tracing::warn!(
                    pending = len,
                    "plugin hooks: debounce backlog is large; hook delivery is falling behind"
                );
            }
        } else if len < HOOK_QUEUE_WARN_LEN / 2 {
            self.warned.store(false, Ordering::Relaxed);
        }
    }

    fn pending(&self) -> MutexGuard<'_, HashMap<Id, PendingHook>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn in_flight(&self) -> MutexGuard<'_, HashSet<Id>> {
        self.in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn deliveries(&self) -> MutexGuard<'_, HashMap<(String, Id), VecDeque<Instant>>> {
        self.deliveries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// One document's in-flight mark, held for as long as its delivery is running. See
/// [`HookQueue::claim`].
pub struct HookClaim {
    queue: Arc<HookQueue>,
    document_id: String,
}

impl Drop for HookClaim {
    fn drop(&mut self) {
        self.queue.release(&self.document_id);
    }
}

/// Drop timestamps that have fallen out of the sliding window.
fn prune(window: &mut VecDeque<Instant>, now: Instant) {
    while window
        .front()
        .is_some_and(|at| now.saturating_duration_since(*at) >= HOOK_RATE_WINDOW)
    {
        window.pop_front();
    }
}

/// One document's resolved change: read once, delivered to every eligible plugin.
///
/// Built per *document* rather than per plugin so that ten subscribers cost one document
/// read, and so every one of them sees the same snapshot of it.
#[derive(Debug, Clone)]
pub struct ResolvedChange {
    pub id: Id,
    pub kind: abi::hooks::HookKind,
    pub origin: abi::Origin,
    pub at: String,
    pub seq: i64,
    pub coalesced: u32,
    /// The document, or `None` when this is a delete (HOST-ABI.md §4.2). Gated per plugin
    /// on `documents:read` by [`ResolvedChange::event_for`].
    pub document: Option<abi::documents::DocumentValue>,
}

impl ResolvedChange {
    /// The payload one plugin receives.
    pub fn event_for(&self, plugin: &ActivePlugin) -> abi::hooks::DocumentEvent {
        abi::hooks::DocumentEvent {
            event: self.kind,
            id: self.id.clone(),
            origin: self.origin.clone(),
            at: self.at.clone(),
            seq: self.seq,
            coalesced: self.coalesced,
            // SPEC §6.2: a hooks-only plugin must not read the workspace through the side
            // door. Without `documents:read` the payload is the id, the origin and the
            // sequence number — enough to decide "do I care", and nothing more.
            document: if plugin.capabilities.can_read_documents() {
                self.document.clone()
            } else {
                None
            },
        }
    }
}

/// Subscribes to the change feed, coalesces, and dispatches.
pub struct HookDispatcher {
    state: AppState,
    queue: Arc<HookQueue>,
}

impl HookDispatcher {
    /// Start the dispatcher. One task subscribes to the feed and drives the debounce timer;
    /// both stop when the returned handle is dropped.
    pub fn spawn(state: AppState) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            // Both halves in one `select!` rather than two tasks: dropping the handle then
            // stops the timer *and* the subscription, instead of leaving a timer ticking
            // against a queue nothing feeds.
            let mut notices = state.feed.subscribe();
            let dispatcher = HookDispatcher::new(state);
            let mut tick = tokio::time::interval(HOOK_TICK);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        dispatcher.flush_due().await;
                    }
                    received = notices.recv() => match received {
                        Ok(notice) => dispatcher.observe(&notice),
                        // A lagged receiver is a genuinely missed hook. That is what
                        // at-most-once means (SPEC §6.3), and why a plugin that must not
                        // miss a change reconciles on its cron run — so it is logged
                        // loudly rather than papered over with a re-read of the feed.
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                            tracing::warn!(
                                missed,
                                "plugin hooks: change-feed notices dropped; those changes \
                                 deliver no hook (at-most-once, no retry)"
                            );
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    },
                }
            }
            tracing::info!("plugin hooks: change feed closed, dispatcher stopped");
        })
    }

    pub fn new(state: AppState) -> Self {
        Self {
            state,
            queue: Arc::new(HookQueue::new()),
        }
    }

    /// The debouncer's state, for the maintenance loop's sweep and for `/metrics`.
    pub fn queue(&self) -> &Arc<HookQueue> {
        &self.queue
    }

    /// Fold one feed notice into the pending map.
    pub fn observe(&self, notice: &FeedNotice) {
        self.queue.observe(notice);
    }

    /// Dispatch everything due, returning how many **documents** were dispatched.
    ///
    /// One task per document, because per-document ordering is the only ordering promised
    /// and a slow plugin must not delay another document's hook.
    pub async fn flush_due(&self) -> usize {
        let due = self.queue.take_due(Instant::now());
        if due.is_empty() {
            return 0;
        }

        // Claimed the moment they come off the queue, so every path out of this function —
        // including a panic inside it — clears the in-flight mark. `take_due` already set it;
        // this is what guarantees it comes back off.
        let due: Vec<(PendingHook, HookClaim)> = due
            .into_iter()
            .map(|pending| {
                let claim = self.queue.claim(&pending.document_id);
                (pending, claim)
            })
            .collect();

        let host = PluginHost::get(&self.state);
        let subscribers: Vec<Arc<ActivePlugin>> = host
            .active()
            .into_iter()
            .filter(|plugin| !plugin.hooks.is_empty())
            .collect();
        if subscribers.is_empty() {
            // Nothing subscribes, so the entries are *dropped*, not held: holding them
            // would grow an unbounded backlog on a workspace with no hook plugins at all.
            // Dropping the claims is what releases them.
            return 0;
        }
        let limits = PluginLimits::from_config(&self.state.config);

        let mut dispatched = 0;
        for (pending, claim) in due {
            let Some(change) = self.resolve(&pending).await else {
                continue;
            };
            let eligible: Vec<Arc<ActivePlugin>> = subscribers
                .iter()
                .filter(|plugin| should_deliver(plugin, change.kind, &change.origin))
                .filter(|plugin| self.queue.allow_delivery(&plugin.id, &change.id))
                .map(Arc::clone)
                .collect();
            if eligible.is_empty() {
                continue;
            }

            let state = self.state.clone();
            let host = Arc::clone(&host);
            tokio::spawn(async move {
                // Moved in, so the mark is held for exactly as long as the delivery runs and
                // is cleared by unwinding too.
                let _claim = claim;
                // Sequential over the eligible plugins: the promise is ordering *per
                // document*, and honouring it with one task per document costs a slow
                // plugin's neighbours a few seconds of latency on that one document —
                // cheaper than a second in-flight set keyed by (plugin, document).
                for plugin in eligible {
                    let event = change.event_for(&plugin);
                    let payload = match serde_json::to_value(&event) {
                        Ok(payload) => payload,
                        Err(err) => {
                            tracing::error!(
                                plugin = %plugin.id, document = %change.id, error = %err,
                                "plugin hooks: cannot serialize a hook payload"
                            );
                            continue;
                        }
                    };
                    let invocation = Invocation::top_level(
                        plugin.id.clone(),
                        CallKind::Hook(change.kind),
                        payload,
                        &limits,
                    );
                    deliver(&state, &host, &plugin, change.kind, &change.id, invocation).await;
                }
            });
            dispatched += 1;
        }
        dispatched
    }

    /// Read the row and resolve the hook kind, origin and payload for one pending entry.
    pub async fn resolve(&self, pending: &PendingHook) -> Option<ResolvedChange> {
        // `get` rather than `get_stale`: the payload claims to be "the document as it is
        // now", and after a two-second debounce forcing the materialization flush costs
        // nothing and makes the claim true (SPEC §3.5's read-your-writes rule).
        let document = match self.state.docs.get(&pending.document_id).await {
            Ok(document) => document,
            Err(err) => {
                // Purged between the notice and the flush, or otherwise unreadable. There
                // is no retry: at-most-once (SPEC §6.3).
                tracing::debug!(
                    document = %pending.document_id, error = %err,
                    "plugin hooks: document unreadable at delivery time, hook dropped"
                );
                return None;
            }
        };
        Some(resolve_change(pending, &document))
    }
}

/// One stored row plus one pending entry to the payload every subscriber shares.
///
/// Pure, so the kind/origin/timestamp rules are testable without a database.
pub fn resolve_change(pending: &PendingHook, document: &Document) -> ResolvedChange {
    let kind = resolve_kind(pending, document);
    let deleted = matches!(kind, abi::hooks::HookKind::DocumentDeleted);
    let origin = if deleted {
        origin_from_stored(document.deleted_by.as_deref())
    } else {
        origin_from_stored(document.updated_by.as_deref())
    };
    let at = match document.deleted_at {
        Some(at) if deleted => Timestamp::from(at).to_rfc3339(),
        _ => Timestamp::from(document.updated_at).to_rfc3339(),
    };

    ResolvedChange {
        id: pending.document_id.clone(),
        kind,
        origin,
        at,
        seq: pending.seq,
        coalesced: pending.coalesced,
        // HOST-ABI.md §4.2: the document is absent on `document.deleted`.
        document: if deleted {
            None
        } else {
            Some(document_value(document))
        },
    }
}

/// Invoke one plugin's hook export, fire-and-forget.
///
/// At-most-once and no retry (SPEC §6.3): the outcome is logged and counted, and that is
/// the whole of the error handling. The circuit breaker inside [`PluginHost::call`] is what
/// turns a persistently failing plugin off.
async fn deliver(
    state: &AppState,
    host: &PluginHost,
    plugin: &ActivePlugin,
    kind: abi::hooks::HookKind,
    document_id: &str,
    invocation: Invocation,
) {
    match host.call(state, invocation).await {
        Ok(outcome) => {
            metrics::counter!(
                names::PLUGIN_HOOKS_DELIVERED,
                "plugin" => plugin.id.clone(),
                "outcome" => "ok",
            )
            .increment(1);
            tracing::debug!(
                plugin = %plugin.id, document = %document_id, event = kind.as_str(),
                duration_ms = outcome.duration.as_millis(), writes = outcome.writes,
                "plugin hooks: delivered"
            );
        }
        Err(err) => {
            metrics::counter!(
                names::PLUGIN_HOOKS_DELIVERED,
                "plugin" => plugin.id.clone(),
                "outcome" => "failed",
            )
            .increment(1);
            tracing::warn!(
                plugin = %plugin.id, document = %document_id, event = kind.as_str(),
                error = %err,
                "plugin hooks: delivery failed; not retried (at-most-once)"
            );
        }
    }
}

/// Build the payload for one plugin.
///
/// `None` ⇒ do not deliver: the plugin caused the change, does not subscribe to this hook,
/// or does not export the handler.
///
/// The dispatcher resolves once per document and fans out; this is the single-plugin
/// spelling of the same thing, kept because it is the readable unit and what a "replay this
/// one hook" path wants.
pub async fn payload_for(
    state: &AppState,
    plugin: &super::ActivePlugin,
    pending: &PendingHook,
) -> Option<abi::hooks::DocumentEvent> {
    let document = state.docs.get(&pending.document_id).await.ok()?;
    let change = resolve_change(pending, &document);
    if !should_deliver(plugin, change.kind, &change.origin) {
        return None;
    }
    Some(change.event_for(plugin))
}

/// Should this plugin receive this hook at all?
///
/// Two independent reasons not to, and the first is the loop backstop that matters
/// (SPEC §6.3): **a plugin is never told about a change it caused.** The second is plain
/// routing — it did not declare the hook, or its module has no handler for it, and
/// scheduling a call that can only answer "no such export" would count a host failure
/// against a plugin that did nothing wrong.
pub fn should_deliver(
    plugin: &ActivePlugin,
    kind: abi::hooks::HookKind,
    origin: &abi::Origin,
) -> bool {
    if origin.is_plugin(&plugin.id) {
        return false;
    }
    plugin.subscribes_to(kind)
}

/// The hook shape a feed notice implies, and whether it may later be promoted to
/// `document.created`. `None` ⇒ not a hook at all.
fn shape_of(kind: FeedChangeKind) -> Option<(abi::hooks::HookKind, bool)> {
    match kind {
        // Created or edited — indistinguishable in the feed, resolved from the row.
        FeedChangeKind::Upsert => Some((abi::hooks::HookKind::DocumentChanged, true)),
        FeedChangeKind::Tombstoned => Some((abi::hooks::HookKind::DocumentDeleted, false)),
        // A restore is never a creation, even for a document that was never edited: the
        // row's timestamps cannot tell the difference, so the notice does.
        FeedChangeKind::Restored => Some((abi::hooks::HookKind::DocumentChanged, false)),
        FeedChangeKind::Purged => None,
    }
}

/// The delivered hook kind: the window's shape, with `document.changed` promoted to
/// `document.created` for a row that has not been updated since it was written.
fn resolve_kind(pending: &PendingHook, document: &Document) -> abi::hooks::HookKind {
    if !pending.promotable || pending.kind != abi::hooks::HookKind::DocumentChanged {
        return pending.kind;
    }
    if document.deleted_at.is_some() {
        // The row is in Trash but the newest notice was an upsert (an edit of a trashed
        // document). That is a change, and certainly not a creation.
        return abi::hooks::HookKind::DocumentChanged;
    }
    if document.created_at == document.updated_at {
        abi::hooks::HookKind::DocumentCreated
    } else {
        abi::hooks::HookKind::DocumentChanged
    }
}

/// Map the row's `updated_by`/`deleted_by` (`Actor::as_stored`) to an ABI origin.
pub fn origin_from_stored(stored: Option<&str>) -> abi::Origin {
    match stored {
        Some("system") => abi::Origin::System,
        Some(stored) => match stored.strip_prefix("plugin:") {
            Some(id) => abi::Origin::Plugin { id: id.to_string() },
            None => abi::Origin::User {
                id: stored.to_string(),
            },
        },
        // No recorded applier is the server itself, not a user with an empty id.
        None => abi::Origin::System,
    }
}

/// One stored document as the ABI's [`abi::documents::DocumentValue`].
///
/// Public because `host_fns`' `get_document` and `query_documents` need exactly this
/// conversion and there must be one of it: a plugin comparing `created_by` from a hook
/// against `created_by` from a read relies on both saying the same thing.
pub fn document_value(document: &Document) -> abi::documents::DocumentValue {
    abi::documents::DocumentValue {
        id: document.id.clone(),
        title: document.title.clone(),
        content: Some(document.content.clone()),
        fm: json_map(&document.fm),
        plugins: json_map(&document.plugins),
        fm_parse_error: document.fm_parse_error,
        materialized_version: document.materialized_version.clone(),
        created_at: Timestamp::from(document.created_at).to_rfc3339(),
        created_by: document.created_by.clone(),
        updated_at: Timestamp::from(document.updated_at).to_rfc3339(),
        updated_by: document.updated_by.clone(),
        deleted: document.deleted_at.is_some(),
    }
}

/// A materialized `fm`/`plugins` subdocument as plain JSON — never extended JSON
/// (HOST-ABI.md §2.4).
fn json_map(document: &bson::Document) -> abi::JsonMap {
    match crate::domain::materialized_to_json(document) {
        serde_json::Value::Object(map) => map.into_iter().collect(),
        _ => abi::JsonMap::new(),
    }
}

// ---------------------------------------------------------------------------
// The event bridge: `emit` (server bus) and `emit_client` (browsers)
// ---------------------------------------------------------------------------
//
// These are the bodies of `host_fns::emit` and `host_fns::emit_client`, which
// `backend/CONTRACTS.md` assigns to this builder. They live here rather than inline in
// `host_fns.rs` so that the one file three areas share carries two one-line delegations
// instead of two implementations — and so the name validation, the payload cap and the
// namespacing rule have one definition next to the hook dispatcher that shares them.
//
// **Names are namespaced by the host, always.** A plugin emits `"synced"`; the server bus
// publishes `"calendar:synced"` and a browser sees `"plugin:calendar:synced"`. The prefix is
// taken from the calling instance and is never on the wire, for the same reason
// `splice_section` does not take a `plugin_id`: a plugin that could name the prefix could
// impersonate another plugin's event (HOST-ABI.md §3.8).

/// `emit` — publish on the **server-side** bus.
///
/// Delivery is a nested invocation of each subscriber's `lm_event`, sharing this
/// invocation's deadline and stack (HOST-ABI.md §3.8, §5). Never delivered back to the
/// emitter, and `subscribers: 0` is the normal state of an event bus, not an error.
pub fn emit_to_plugins(
    context: &super::host_fns::HostContext,
    input: abi::events::EmitInput,
) -> Result<abi::events::EmitOutput, abi::HostError> {
    // The name and payload caps are `host_fns`' — one definition for both buses, and it is
    // what refuses a `:` in the name so a plugin cannot spell another plugin's event.
    super::host_fns::check_event(&input.event, &input.payload)?;
    let namespaced = format!("{}:{}", context.plugin.id, input.event);

    let host = PluginHost::get(&context.state);
    let subscribers: Vec<Arc<ActivePlugin>> = host
        .active()
        .into_iter()
        .filter(|plugin| {
            // Never back to the emitter — the same rule as document hooks, for the same
            // reason (SPEC §6.3).
            plugin.id != context.plugin.id
                && plugin.events.iter().any(|name| name == &namespaced)
                && plugin.has_export(abi::names::EVENT)
        })
        .collect();

    if subscribers.is_empty() {
        return Ok(abi::events::EmitOutput {
            event: namespaced,
            subscribers: 0,
        });
    }

    let payload = abi::events::EventPayload {
        event: namespaced.clone(),
        payload: input.payload,
        origin: abi::Origin::Plugin {
            id: context.plugin.id.clone(),
        },
        at: Timestamp::now().to_rfc3339(),
    };
    let payload = serde_json::to_value(&payload).map_err(|err| {
        abi::HostError::new(
            abi::ErrorCode::Internal,
            format!("cannot serialize the event payload: {err}"),
        )
    })?;

    // The invocation this host function is running inside, reconstructed so that
    // `Invocation::nested` — the one place the depth, reentrancy and shared-deadline rules
    // are written — is what decides whether a delivery is legal. Duplicating those three
    // checks here is how they drift apart.
    let current = Invocation {
        plugin_id: context.plugin.id.clone(),
        kind: context.kind.clone(),
        payload: serde_json::Value::Null,
        deadline: context.deadline,
        depth: context.depth,
        stack: context.stack.clone(),
        user_id: context.user_id.clone(),
    };

    let mut delivered = 0u32;
    for subscriber in subscribers {
        let nested = match current.nested(&subscriber.id, abi::names::EVENT, payload.clone()) {
            Ok(mut nested) => {
                // `nested` describes a `call_plugin`; this is an event, and the kind is what
                // picks the export and the metric label.
                nested.kind = CallKind::Event {
                    emitter: context.plugin.id.clone(),
                };
                nested
            }
            // A subscriber already on the call stack is **skipped**, not an error: it did
            // not ask to be re-entered and the emitter did nothing wrong (HOST-ABI.md
            // §3.10's reentrancy rule, applied to fan-out).
            Err(err) if err.code == abi::ErrorCode::Reentrancy => {
                tracing::debug!(
                    emitter = %context.plugin.id, subscriber = %subscriber.id, event = %namespaced,
                    "plugin events: subscriber is already on the call stack, skipped"
                );
                continue;
            }
            // Depth exhausted refuses the whole emit: silently dropping every delivery
            // would make a three-deep chain look like an event bus with no listeners.
            Err(err) => return Err(err),
        };

        // Synchronous host function, asynchronous invocation: this runs on a
        // `spawn_blocking` thread (see `host_fns`' module docs), and the nested call
        // shares — and therefore cannot outlive — this invocation's deadline.
        let outcome = context.runtime.block_on(host.call(&context.state, nested));
        match outcome {
            Ok(_) => delivered += 1,
            Err(err) => tracing::warn!(
                emitter = %context.plugin.id, subscriber = %subscriber.id, event = %namespaced,
                error = %err,
                "plugin events: delivery failed; not retried (fire-and-forget)"
            ),
        }
    }

    Ok(abi::events::EmitOutput {
        event: namespaced,
        subscribers: delivered,
    })
}

/// `emit_client` — relay to connected browsers over the sync socket.
///
/// Ephemeral by construction (SPEC §6.3): a client that was closed missed it, a socket whose
/// queue is full drops it, and nothing is replayed on reconnect. State belongs in documents.
pub fn emit_to_clients(
    context: &super::host_fns::HostContext,
    input: abi::events::EmitClientInput,
) -> Result<abi::events::EmitClientOutput, abi::HostError> {
    // Same caps as `emit`, from the same place (see `emit_to_plugins`).
    super::host_fns::check_event(&input.event, &input.payload)?;

    // `user_id` is validated as an id rather than trusted: a malformed target would
    // otherwise silently reach nobody, which reads as "no sockets connected".
    if let Some(user_id) = input.user_id.as_deref()
        && !crate::domain::is_valid_id(user_id)
    {
        return Err(abi::HostError::new(
            abi::ErrorCode::InvalidArgument,
            "user_id must be a ULID",
        ));
    }

    let sockets = crate::routes::sync::publish_plugin_event(
        &context.state,
        &context.plugin.id,
        &input.event,
        &input.payload,
        input.user_id.as_deref(),
    );

    Ok(abi::events::EmitClientOutput {
        // The type a frontend plugin listens for: `plugin:<id>:<event>`
        // (`abi::names::CLIENT_EVENT_PREFIX`, and `web/kernel-api/src/events.ts`).
        event: format!(
            "{}{}:{}",
            abi::names::CLIENT_EVENT_PREFIX,
            context.plugin.id,
            input.event
        ),
        sockets: u32::try_from(sockets).unwrap_or(u32::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::DateTime as BsonDateTime;

    // ---- origin and eligibility -------------------------------------------

    #[test]
    fn an_origin_is_read_from_the_stored_applier_string() {
        assert_eq!(
            origin_from_stored(Some("plugin:calendar")),
            abi::Origin::Plugin {
                id: "calendar".to_string()
            }
        );
        assert_eq!(origin_from_stored(Some("system")), abi::Origin::System);
        assert_eq!(
            origin_from_stored(Some("01HUSER")),
            abi::Origin::User {
                id: "01HUSER".to_string()
            }
        );
        assert_eq!(origin_from_stored(None), abi::Origin::System);
    }

    #[test]
    fn a_plugin_is_never_told_about_its_own_change() {
        let calendar = active("calendar", &[abi::hooks::HookKind::DocumentChanged], true);

        assert!(
            !should_deliver(
                &calendar,
                abi::hooks::HookKind::DocumentChanged,
                &abi::Origin::Plugin {
                    id: "calendar".to_string()
                }
            ),
            "the plugin that caused the change must not receive the hook (SPEC §6.3)"
        );
        assert!(should_deliver(
            &calendar,
            abi::hooks::HookKind::DocumentChanged,
            &abi::Origin::User {
                id: "01HUSER".to_string()
            }
        ));
        // Another plugin's change *is* delivered — that is the loop the delivery cap and
        // the write cap have to catch, not the origin check.
        assert!(should_deliver(
            &calendar,
            abi::hooks::HookKind::DocumentChanged,
            &abi::Origin::Plugin {
                id: "todos".to_string()
            }
        ));
    }

    #[test]
    fn a_declared_hook_with_no_handler_is_not_scheduled() {
        // Declaring `document.changed` and shipping a module without the export is an
        // install-time mistake; scheduling the call anyway would count a host failure
        // against the plugin on every edit in the workspace.
        let no_export = active("calendar", &[abi::hooks::HookKind::DocumentChanged], false);
        assert!(!should_deliver(
            &no_export,
            abi::hooks::HookKind::DocumentChanged,
            &abi::Origin::System
        ));
        // And an undeclared hook is not delivered either.
        let changed_only = active("calendar", &[abi::hooks::HookKind::DocumentChanged], true);
        assert!(!should_deliver(
            &changed_only,
            abi::hooks::HookKind::DocumentDeleted,
            &abi::Origin::System
        ));
    }

    #[test]
    fn the_payload_carries_no_document_without_documents_read() {
        let pending = pending("doc1", 7, abi::hooks::HookKind::DocumentChanged, false);
        let change = resolve_change(&pending, &document("doc1", 1_000, 2_000, None));

        let with_read = active("a", &[abi::hooks::HookKind::DocumentChanged], true);
        assert!(change.event_for(&with_read).document.is_some());

        let mut without_read = active("b", &[abi::hooks::HookKind::DocumentChanged], true);
        without_read.capabilities.documents.clear();
        let event = change.event_for(&without_read);
        assert!(
            event.document.is_none(),
            "a hooks-only plugin must not read the workspace through the payload (SPEC §6.2)"
        );
        // The id, origin and sequence number are still there: enough to decide "do I care".
        assert_eq!(event.id, "doc1");
        assert_eq!(event.seq, 7);
    }

    // ---- kind resolution ---------------------------------------------------

    #[test]
    fn an_untouched_row_delivers_created_and_an_edited_one_delivers_changed() {
        let fresh = pending("doc1", 1, abi::hooks::HookKind::DocumentChanged, true);
        assert_eq!(
            resolve_change(&fresh, &document("doc1", 1_000, 1_000, None)).kind,
            abi::hooks::HookKind::DocumentCreated,
            "created_at == updated_at is true exactly once, at creation"
        );
        assert_eq!(
            resolve_change(&fresh, &document("doc1", 1_000, 2_000, None)).kind,
            abi::hooks::HookKind::DocumentChanged
        );
    }

    #[test]
    fn a_delete_carries_the_deleting_actor_and_no_document() {
        let pending = pending("doc1", 9, abi::hooks::HookKind::DocumentDeleted, false);
        let mut row = document("doc1", 1_000, 2_000, Some(3_000));
        row.deleted_by = Some("plugin:todos".to_string());
        row.updated_by = Some("01HUSER".to_string());

        let change = resolve_change(&pending, &row);
        assert_eq!(change.kind, abi::hooks::HookKind::DocumentDeleted);
        assert_eq!(
            change.origin,
            abi::Origin::Plugin {
                id: "todos".to_string()
            },
            "a delete's origin is deleted_by, not updated_by"
        );
        assert!(
            change.document.is_none(),
            "HOST-ABI.md §4.2: no document on document.deleted"
        );
    }

    #[test]
    fn a_restore_is_never_reported_as_a_creation() {
        // A document created and trashed without ever being edited still has
        // created_at == updated_at, so the *notice* is what rules out the promotion.
        let restored = pending("doc1", 4, abi::hooks::HookKind::DocumentChanged, false);
        assert_eq!(
            resolve_change(&restored, &document("doc1", 1_000, 1_000, None)).kind,
            abi::hooks::HookKind::DocumentChanged
        );
    }

    // ---- debounce ----------------------------------------------------------

    #[test]
    fn changes_inside_the_window_coalesce_into_one_delivery() {
        let queue = HookQueue::new();
        let start = Instant::now();

        queue.observe_at(&notice("doc1", 10, FeedChangeKind::Upsert), start);
        queue.observe_at(
            &notice("doc1", 11, FeedChangeKind::Upsert),
            start + Duration::from_millis(400),
        );
        queue.observe_at(
            &notice("doc1", 12, FeedChangeKind::Upsert),
            start + Duration::from_millis(900),
        );

        assert_eq!(queue.pending_len(), 1);
        assert!(
            queue
                .take_due(start + Duration::from_millis(2_100))
                .is_empty(),
            "the debounce window restarts on every change"
        );

        let due = queue.take_due(start + Duration::from_millis(2_950));
        assert_eq!(due.len(), 1);
        assert_eq!(
            due[0].coalesced, 3,
            "one delivery standing for three changes"
        );
        assert_eq!(due[0].seq, 12, "carrying the newest sequence number");
        assert_eq!(queue.pending_len(), 0);
    }

    #[test]
    fn a_continuously_edited_document_still_delivers_within_the_ceiling() {
        let queue = HookQueue::new();
        let start = Instant::now();
        // An edit every 1.9 s would push the window out forever without HOOK_MAX_DELAY.
        // The clock is advanced in HOOK_TICK steps, the way the dispatcher actually asks,
        // so the assertion can be about the ceiling and not about the tick granularity.
        let edit_every = Duration::from_millis(1_900);
        let mut elapsed = Duration::ZERO;
        let mut next_edit = Duration::ZERO;
        let mut seq = 0;
        while elapsed < HOOK_MAX_DELAY * 4 {
            if elapsed >= next_edit {
                queue.observe_at(
                    &notice("doc1", seq, FeedChangeKind::Upsert),
                    start + elapsed,
                );
                next_edit = elapsed + edit_every;
                seq += 1;
            }
            if !queue.take_due(start + elapsed).is_empty() {
                assert!(
                    elapsed <= HOOK_MAX_DELAY + HOOK_TICK,
                    "the ceiling must fire within one tick of HOOK_MAX_DELAY after the first \
                     change, not {elapsed:?} later"
                );
                assert!(
                    seq > 1,
                    "the point of the ceiling is that the edits never stopped"
                );
                return;
            }
            elapsed += HOOK_TICK;
        }
        panic!("a continuously edited document never delivered a hook");
    }

    #[test]
    fn two_documents_debounce_independently() {
        let queue = HookQueue::new();
        let start = Instant::now();
        queue.observe_at(&notice("doc1", 1, FeedChangeKind::Upsert), start);
        queue.observe_at(
            &notice("doc2", 2, FeedChangeKind::Upsert),
            start + Duration::from_millis(1_500),
        );

        let due = queue.take_due(start + HOOK_DEBOUNCE + Duration::from_millis(10));
        assert_eq!(due.len(), 1, "only doc1's window has closed");
        assert_eq!(due[0].document_id, "doc1");
    }

    #[test]
    fn a_purge_is_not_a_hook() {
        let queue = HookQueue::new();
        queue.observe(&notice("doc1", 1, FeedChangeKind::Purged));
        assert_eq!(
            queue.pending_len(),
            0,
            "a purge fires nothing: the document.deleted for it fired 30 days earlier"
        );
    }

    #[test]
    fn the_newest_notice_decides_the_shape() {
        let queue = HookQueue::new();
        let start = Instant::now();

        // Created then trashed inside one window: the document is in Trash now.
        queue.observe_at(&notice("doc1", 1, FeedChangeKind::Upsert), start);
        queue.observe_at(&notice("doc1", 2, FeedChangeKind::Tombstoned), start);
        let due = queue.take_due(start + HOOK_DEBOUNCE);
        assert_eq!(due[0].kind, abi::hooks::HookKind::DocumentDeleted);
        assert!(!due[0].promotable);
        queue.release("doc1");

        // Trashed then restored: it is back, and a restore is never a creation.
        queue.observe_at(&notice("doc2", 3, FeedChangeKind::Tombstoned), start);
        queue.observe_at(&notice("doc2", 4, FeedChangeKind::Restored), start);
        let due = queue.take_due(start + HOOK_DEBOUNCE);
        assert_eq!(due[0].kind, abi::hooks::HookKind::DocumentChanged);
        assert!(
            !due[0].promotable,
            "a restored document must not be reported as created"
        );
    }

    #[test]
    fn a_document_being_delivered_defers_rather_than_races() {
        let queue = HookQueue::new();
        let start = Instant::now();
        queue.observe_at(&notice("doc1", 1, FeedChangeKind::Upsert), start);

        // The first flush takes it and marks it in flight.
        assert_eq!(queue.take_due(start + HOOK_DEBOUNCE).len(), 1);

        // A new change arrives and becomes due while that delivery is still running.
        let later = start + Duration::from_secs(3);
        queue.observe_at(&notice("doc1", 2, FeedChangeKind::Upsert), later);
        assert!(
            queue
                .take_due(later + HOOK_DEBOUNCE + Duration::from_millis(10))
                .is_empty(),
            "per-document ordering: the second delivery waits for the first"
        );
        assert_eq!(queue.pending_len(), 1, "and it is kept, not dropped");

        // Once the first delivery finishes, the deferred one goes out.
        queue.release("doc1");
        let second = queue.take_due(later + Duration::from_secs(10));
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].seq, 2);
    }

    /// A claim dropped while unwinding still releases. A delivery task whose *last* statement
    /// was the release left the id in `in_flight` on any panic, and `take_due` then deferred
    /// every later change to that document for the life of the process — visible only as a
    /// permanently non-zero `lm_plugin_hooks_pending`.
    #[test]
    fn a_panicking_delivery_still_releases_its_document() {
        let queue = Arc::new(HookQueue::new());
        let start = Instant::now();
        queue.observe_at(&notice("doc1", 1, FeedChangeKind::Upsert), start);
        assert_eq!(queue.take_due(start + HOOK_DEBOUNCE).len(), 1);

        let outcome = {
            let queue = Arc::clone(&queue);
            std::panic::catch_unwind(move || {
                let _claim = queue.claim("doc1");
                panic!("the delivery blew up");
            })
        };
        assert!(outcome.is_err());

        // The next change to that document is delivered rather than deferred forever.
        let later = start + Duration::from_secs(3);
        queue.observe_at(&notice("doc1", 2, FeedChangeKind::Upsert), later);
        let second = queue.take_due(later + HOOK_DEBOUNCE + Duration::from_millis(10));
        assert_eq!(second.len(), 1, "the in-flight mark was never cleared");
        assert_eq!(second[0].seq, 2);
    }

    // ---- the delivery cap --------------------------------------------------

    #[test]
    fn the_delivery_cap_trips_and_recovers_after_the_window() {
        let queue = HookQueue::new();
        let start = Instant::now();

        for attempt in 0..HOOK_DELIVERIES_PER_DOCUMENT_PER_MINUTE {
            assert!(
                queue.allow_delivery_at("calendar", "doc1", start),
                "delivery {attempt} is within the cap"
            );
        }
        assert!(
            !queue.allow_delivery_at("calendar", "doc1", start),
            "the eleventh delivery for one document in one minute is a loop, not work"
        );

        // The cap is per (plugin, document): neither dimension leaks into the other.
        assert!(queue.allow_delivery_at("calendar", "doc2", start));
        assert!(queue.allow_delivery_at("todos", "doc1", start));

        // A sliding window, so the next minute delivers again.
        assert!(queue.allow_delivery_at(
            "calendar",
            "doc1",
            start + HOOK_RATE_WINDOW + Duration::from_millis(1)
        ));
    }

    #[test]
    fn the_sweep_drops_windows_that_have_aged_out() {
        let queue = HookQueue::new();
        let start = Instant::now();
        assert!(queue.allow_delivery_at("calendar", "doc1", start));
        assert_eq!(queue.sweep_at(start), 1, "a fresh window is kept");
        assert_eq!(
            queue.sweep_at(start + HOOK_RATE_WINDOW + Duration::from_millis(1)),
            0,
            "an aged-out window is forgotten rather than held per document forever"
        );
    }

    #[test]
    fn the_tick_sweeps_delivery_windows_without_an_external_caller() {
        let queue = HookQueue::new();
        let start = Instant::now();
        assert!(queue.allow_delivery_at("calendar", "doc1", start));
        assert_eq!(queue.deliveries().len(), 1);

        // A tick inside the window changes nothing…
        queue.take_due(start);
        assert_eq!(queue.deliveries().len(), 1);

        // …and a tick past it prunes, with no maintenance loop involved. The map is keyed
        // by (plugin, document), so without this it grows once per document ever touched.
        queue.take_due(start + HOOK_RATE_WINDOW + Duration::from_millis(1));
        assert_eq!(queue.deliveries().len(), 0);
    }

    // ---- helpers -----------------------------------------------------------

    fn notice(id: &str, seq: i64, kind: FeedChangeKind) -> FeedNotice {
        FeedNotice {
            seq,
            id: id.to_string(),
            kind,
        }
    }

    fn pending(id: &str, seq: i64, kind: abi::hooks::HookKind, promotable: bool) -> PendingHook {
        let now = Instant::now();
        PendingHook {
            document_id: id.to_string(),
            kind,
            seq,
            coalesced: 1,
            due: now,
            first_seen: now,
            promotable,
        }
    }

    fn document(id: &str, created_ms: i64, updated_ms: i64, deleted_ms: Option<i64>) -> Document {
        Document {
            id: id.to_string(),
            crdt: bson::Binary {
                subtype: bson::spec::BinarySubtype::Generic,
                bytes: Vec::new(),
            },
            state_vector: bson::Binary {
                subtype: bson::spec::BinarySubtype::Generic,
                bytes: Vec::new(),
            },
            content: "---\ntitle: T\n---\n".to_string(),
            title: "T".to_string(),
            fm: bson::doc! { "title": "T" },
            plugins: bson::doc! {},
            materialized_version: "abc".to_string(),
            fm_parse_error: false,
            created_at: BsonDateTime::from_millis(created_ms),
            created_by: Some("01HUSER".to_string()),
            updated_at: BsonDateTime::from_millis(updated_ms),
            updated_by: Some("01HUSER".to_string()),
            deleted_at: deleted_ms.map(BsonDateTime::from_millis),
            deleted_by: None,
            feed_seq: Some(1),
        }
    }

    fn active(id: &str, hooks: &[abi::hooks::HookKind], with_exports: bool) -> ActivePlugin {
        ActivePlugin {
            id: id.to_string(),
            version: "1.0.0".to_string(),
            capabilities: abi::Capabilities {
                documents: vec!["read".to_string()],
                http_hosts: Vec::new(),
                public_routes: Vec::new(),
                notifications: false,
            },
            calls: Default::default(),
            hooks: hooks.to_vec(),
            cron: Vec::new(),
            routes: Vec::new(),
            events: Vec::new(),
            config_keys: Vec::new(),
            config: Default::default(),
            wasm_path: std::path::PathBuf::from("backend.wasm"),
            module_sha256: String::new(),
            abi_version: abi::ABI_VERSION,
            exports: if with_exports {
                hooks
                    .iter()
                    .map(|hook| hook.export_name().to_string())
                    .collect()
            } else {
                Vec::new()
            },
        }
    }
}

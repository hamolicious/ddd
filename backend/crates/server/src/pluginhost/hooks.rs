use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};
use std::time::{Duration, Instant};

use ddd_plugin_abi as abi;

use crate::domain::{Document, Id, Timestamp};
use crate::feed::{FeedChangeKind, FeedNotice};
use crate::state::AppState;
use crate::telemetry::names;

use super::limits::PluginLimits;
use super::{ActivePlugin, CallKind, Invocation, PluginHost};

pub const HOOK_DEBOUNCE: Duration = Duration::from_secs(2);

pub const HOOK_MAX_DELAY: Duration = Duration::from_secs(30);

pub const HOOK_QUEUE_WARN_LEN: usize = 10_000;

pub const HOOK_TICK: Duration = Duration::from_millis(250);

pub const HOOK_DELIVERIES_PER_DOCUMENT_PER_MINUTE: u32 =
    abi::limits::MAX_WRITES_PER_DOCUMENT_PER_MINUTE;

pub const HOOK_RATE_WINDOW: Duration = Duration::from_secs(60);

static PENDING: AtomicUsize = AtomicUsize::new(0);

pub fn pending_count() -> usize {
    PENDING.load(Ordering::Relaxed)
}

#[derive(Debug, Clone)]
pub struct PendingHook {
    pub document_id: Id,
    pub kind: abi::hooks::HookKind,
    pub seq: i64,
    pub coalesced: u32,
    pub due: Instant,
    pub first_seen: Instant,
    pub promotable: bool,
}

impl PendingHook {
    fn deadline(first_seen: Instant, now: Instant) -> Instant {
        (now + HOOK_DEBOUNCE).min(first_seen + HOOK_MAX_DELAY)
    }
}

pub struct HookQueue {
    pending: StdMutex<HashMap<Id, PendingHook>>,
    in_flight: StdMutex<HashSet<Id>>,
    deliveries: StdMutex<HashMap<(String, Id), VecDeque<Instant>>>,
    last_sweep: StdMutex<Instant>,
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

    pub fn observe(&self, notice: &FeedNotice) {
        self.observe_at(notice, Instant::now());
    }

    pub fn observe_at(&self, notice: &FeedNotice, now: Instant) {
        let Some((kind, promotable)) = shape_of(notice.kind) else {
            return;
        };

        let len = {
            let mut pending = self.pending();
            match pending.entry(notice.id.clone()) {
                Entry::Occupied(mut occupied) => {
                    let entry = occupied.get_mut();
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

    pub fn release(&self, document_id: &str) {
        self.in_flight().remove(document_id);
    }

    #[must_use = "dropping the claim immediately clears the in-flight mark"]
    pub fn claim(self: &Arc<Self>, document_id: &str) -> HookClaim {
        HookClaim {
            queue: Arc::clone(self),
            document_id: document_id.to_string(),
        }
    }

    pub fn allow_delivery(&self, plugin_id: &str, document_id: &str) -> bool {
        self.allow_delivery_at(plugin_id, document_id, Instant::now())
    }

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

    pub fn sweep(&self) -> usize {
        self.sweep_at(Instant::now())
    }

    pub fn sweep_at(&self, now: Instant) -> usize {
        let mut windows = self.deliveries();
        for window in windows.values_mut() {
            prune(window, now);
        }
        windows.retain(|_, window| !window.is_empty());
        windows.len()
    }

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

pub struct HookClaim {
    queue: Arc<HookQueue>,
    document_id: String,
}

impl Drop for HookClaim {
    fn drop(&mut self) {
        self.queue.release(&self.document_id);
    }
}

fn prune(window: &mut VecDeque<Instant>, now: Instant) {
    while window
        .front()
        .is_some_and(|at| now.saturating_duration_since(*at) >= HOOK_RATE_WINDOW)
    {
        window.pop_front();
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedChange {
    pub id: Id,
    pub kind: abi::hooks::HookKind,
    pub origin: abi::Origin,
    pub at: String,
    pub seq: i64,
    pub coalesced: u32,
    pub document: Option<abi::documents::DocumentValue>,
}

impl ResolvedChange {
    pub fn event_for(&self, plugin: &ActivePlugin) -> abi::hooks::DocumentEvent {
        abi::hooks::DocumentEvent {
            event: self.kind,
            id: self.id.clone(),
            origin: self.origin.clone(),
            at: self.at.clone(),
            seq: self.seq,
            coalesced: self.coalesced,
            document: if plugin.capabilities.can_read_documents() {
                self.document.clone()
            } else {
                None
            },
        }
    }
}

pub struct HookDispatcher {
    state: AppState,
    queue: Arc<HookQueue>,
}

impl HookDispatcher {
    pub fn spawn(state: AppState) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
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

    pub fn queue(&self) -> &Arc<HookQueue> {
        &self.queue
    }

    pub fn observe(&self, notice: &FeedNotice) {
        self.queue.observe(notice);
    }

    pub async fn flush_due(&self) -> usize {
        let due = self.queue.take_due(Instant::now());
        if due.is_empty() {
            return 0;
        }

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
                let _claim = claim;
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

    pub async fn resolve(&self, pending: &PendingHook) -> Option<ResolvedChange> {
        let document = match self.state.docs.get(&pending.document_id).await {
            Ok(document) => document,
            Err(err) => {
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
        document: if deleted {
            None
        } else {
            Some(document_value(document))
        },
    }
}

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

fn shape_of(kind: FeedChangeKind) -> Option<(abi::hooks::HookKind, bool)> {
    match kind {
        FeedChangeKind::Upsert => Some((abi::hooks::HookKind::DocumentChanged, true)),
        FeedChangeKind::Tombstoned => Some((abi::hooks::HookKind::DocumentDeleted, false)),
        FeedChangeKind::Restored => Some((abi::hooks::HookKind::DocumentChanged, false)),
        FeedChangeKind::Purged => None,
    }
}

fn resolve_kind(pending: &PendingHook, document: &Document) -> abi::hooks::HookKind {
    if !pending.promotable || pending.kind != abi::hooks::HookKind::DocumentChanged {
        return pending.kind;
    }
    if document.deleted_at.is_some() {
        return abi::hooks::HookKind::DocumentChanged;
    }
    if document.created_at == document.updated_at {
        abi::hooks::HookKind::DocumentCreated
    } else {
        abi::hooks::HookKind::DocumentChanged
    }
}

pub fn origin_from_stored(stored: Option<&str>) -> abi::Origin {
    match stored {
        Some("system") => abi::Origin::System,
        Some(stored) => match stored.strip_prefix("plugin:") {
            Some(id) => abi::Origin::Plugin { id: id.to_string() },
            None => abi::Origin::User {
                id: stored.to_string(),
            },
        },
        None => abi::Origin::System,
    }
}

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

fn json_map(document: &bson::Document) -> abi::JsonMap {
    match crate::domain::materialized_to_json(document) {
        serde_json::Value::Object(map) => map.into_iter().collect(),
        _ => abi::JsonMap::new(),
    }
}

pub fn emit_to_plugins(
    context: &super::host_fns::HostContext,
    input: abi::events::EmitInput,
) -> Result<abi::events::EmitOutput, abi::HostError> {
    super::host_fns::check_event(&input.event, &input.payload)?;
    let namespaced = format!("{}:{}", context.plugin.id, input.event);

    let host = PluginHost::get(&context.state);
    let subscribers: Vec<Arc<ActivePlugin>> = host
        .active()
        .into_iter()
        .filter(|plugin| {
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
                nested.kind = CallKind::Event {
                    emitter: context.plugin.id.clone(),
                };
                nested
            }
            Err(err) if err.code == abi::ErrorCode::Reentrancy => {
                tracing::debug!(
                    emitter = %context.plugin.id, subscriber = %subscriber.id, event = %namespaced,
                    "plugin events: subscriber is already on the call stack, skipped"
                );
                continue;
            }
            Err(err) => return Err(err),
        };

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

pub fn emit_to_clients(
    context: &super::host_fns::HostContext,
    input: abi::events::EmitClientInput,
) -> Result<abi::events::EmitClientOutput, abi::HostError> {
    super::host_fns::check_event(&input.event, &input.payload)?;

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
        let no_export = active("calendar", &[abi::hooks::HookKind::DocumentChanged], false);
        assert!(!should_deliver(
            &no_export,
            abi::hooks::HookKind::DocumentChanged,
            &abi::Origin::System
        ));
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
        assert_eq!(event.id, "doc1");
        assert_eq!(event.seq, 7);
    }

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
        let restored = pending("doc1", 4, abi::hooks::HookKind::DocumentChanged, false);
        assert_eq!(
            resolve_change(&restored, &document("doc1", 1_000, 1_000, None)).kind,
            abi::hooks::HookKind::DocumentChanged
        );
    }

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

        queue.observe_at(&notice("doc1", 1, FeedChangeKind::Upsert), start);
        queue.observe_at(&notice("doc1", 2, FeedChangeKind::Tombstoned), start);
        let due = queue.take_due(start + HOOK_DEBOUNCE);
        assert_eq!(due[0].kind, abi::hooks::HookKind::DocumentDeleted);
        assert!(!due[0].promotable);
        queue.release("doc1");

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

        assert_eq!(queue.take_due(start + HOOK_DEBOUNCE).len(), 1);

        let later = start + Duration::from_secs(3);
        queue.observe_at(&notice("doc1", 2, FeedChangeKind::Upsert), later);
        assert!(
            queue
                .take_due(later + HOOK_DEBOUNCE + Duration::from_millis(10))
                .is_empty(),
            "per-document ordering: the second delivery waits for the first"
        );
        assert_eq!(queue.pending_len(), 1, "and it is kept, not dropped");

        queue.release("doc1");
        let second = queue.take_due(later + Duration::from_secs(10));
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].seq, 2);
    }

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

        let later = start + Duration::from_secs(3);
        queue.observe_at(&notice("doc1", 2, FeedChangeKind::Upsert), later);
        let second = queue.take_due(later + HOOK_DEBOUNCE + Duration::from_millis(10));
        assert_eq!(second.len(), 1, "the in-flight mark was never cleared");
        assert_eq!(second[0].seq, 2);
    }

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

        assert!(queue.allow_delivery_at("calendar", "doc2", start));
        assert!(queue.allow_delivery_at("todos", "doc1", start));

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

        queue.take_due(start);
        assert_eq!(queue.deliveries().len(), 1);

        queue.take_due(start + HOOK_RATE_WINDOW + Duration::from_millis(1));
        assert_eq!(queue.deliveries().len(), 0);
    }

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
            deps: Default::default(),
            provides: None,
            callable: Default::default(),
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

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Query, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, header};
use axum::response::Response;
use axum::routing::get;
use futures::{SinkExt, StreamExt};
use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use tokio::sync::{Notify, broadcast};

use crate::auth::{AuthUser, AuthVia};
use crate::docstore::{DocStoreError, EditTiming, TrashFilter};
use crate::domain::{Id, Timestamp, is_valid_id};
use crate::error::{AppError, AppResult};
use crate::feed::{
    BOOTSTRAP_DEFAULT_LIMIT, BOOTSTRAP_MAX_LIMIT, FEED_BATCH_DEFAULT_ROWS, FEED_BATCH_MAX_ROWS,
    FEED_CATCHUP_MAX_ROWS, FeedRow,
};
use crate::state::AppState;
use crate::telemetry::names;

pub const PROTOCOL_VERSION: u32 = 1;

pub const SUBPROTOCOL: &str = "ddd.v1";

pub const BEARER_SUBPROTOCOL_PREFIX: &str = "ddd.bearer.";

pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_SUBSCRIPTIONS: usize = 32;
pub const MAX_SOCKETS_PER_SESSION: usize = 8;
pub const MAX_SOCKETS_PER_USER: usize = 16;
pub const MAX_SOCKETS_TOTAL: usize = 512;
pub const FEED_QUEUE_MESSAGES: usize = 64;
pub const DOC_QUEUE_FRAMES: usize = 256;
pub const INBOUND_FRAMES_PER_SEC: u32 = 200;
pub const INBOUND_BYTES_PER_SEC: u64 = 2 * 1024 * 1024;
pub const HEARTBEAT_SECS: u32 = 25;
pub const SESSION_REVALIDATE_SECS: u64 = 300;
pub const SESSION_REVALIDATE_JITTER_SECS: u64 = 60;
pub const TAIL_COALESCE_MS: u64 = 50;

const QUEUE_MAX_BYTES: usize = 8 * 1024 * 1024;
const FEED_BATCH_MAX_BYTES: usize = 512 * 1024;
const FEED_SUBSCRIBES_PER_SEC: f64 = 1.0;
const FEED_SUBSCRIBE_BURST: f64 = 5.0;
const BOOTSTRAP_MAX_PER_USER: usize = 2;
const BOOTSTRAP_MAX_TOTAL: usize = 8;
const CTL_QUEUE_MESSAGES: usize = 1024;
const OVERFLOW_BUDGET: usize = 10;
const OVERFLOW_WINDOW: Duration = Duration::from_secs(60);
const SERVER_PING_SECS: u64 = 30;
const MISSED_PINGS_BEFORE_CLOSE: u32 = 2;
const MALFORMED_UPDATE_BUDGET: u32 = 3;
const DOC_BROADCAST_CAPACITY: usize = 256;
const FLOOR_SEQ: i64 = 0;
const WRITER_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

pub mod close {
    pub const PROTOCOL_ERROR: u16 = 4400;
    pub const UNAUTHENTICATED: u16 = 4401;
    pub const ORIGIN_REFUSED: u16 = 4403;
    pub const FLOOD: u16 = 4408;
    pub const UNSUPPORTED_VERSION: u16 = 4409;
    pub const FRAME_TOO_LARGE: u16 = 4413;
    pub const TOO_MANY_SOCKETS: u16 = 4429;
    pub const SHUTTING_DOWN: u16 = 4503;
}

pub mod frame {
    pub const SYNC_STEP1: u8 = 0x01;
    pub const SYNC_STEP2: u8 = 0x02;
    pub const UPDATE: u8 = 0x03;
    pub const AWARENESS: u8 = 0x04;
    pub const AWARENESS_QUERY: u8 = 0x05;
    pub const HISTORY: u8 = 0x06;
    pub const RESERVED_FLOOR: u8 = 0x10;
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/sync", get(upgrade_guarded))
        .route("/sync/bootstrap", get(bootstrap))
}

async fn upgrade_guarded(
    State(state): State<AppState>,
    headers: HeaderMap,
    _origin: OriginChecked,
    user: AuthUser,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    upgrade(State(state), headers, user, ws).await
}

pub struct OriginChecked;

impl FromRequestParts<AppState> for OriginChecked {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let via = crate::auth::credential_from_parts(parts, state.config.session_cookie_name())
            .map(|(_, via)| via);
        if origin_verdict(state, &parts.headers, via) {
            Ok(OriginChecked)
        } else {
            Err(AppError::Forbidden)
        }
    }
}

pub async fn upgrade(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: AuthUser,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    if !origin_allowed(&state, &headers, user.via) {
        return Err(AppError::Forbidden);
    }
    if !offers_subprotocol(&headers) {
        return Err(AppError::bad_request(format!(
            "WebSocket client must offer the `{SUBPROTOCOL}` subprotocol"
        )));
    }

    Ok(ws
        .max_frame_size(MAX_FRAME_BYTES * 2)
        .max_message_size(MAX_FRAME_BYTES * 2)
        .protocols([SUBPROTOCOL])
        .on_upgrade(move |socket| async move { serve(state, user, socket).await }))
}

pub fn origin_allowed(state: &AppState, headers: &HeaderMap, via: AuthVia) -> bool {
    origin_verdict(state, headers, Some(via))
}

fn origin_verdict(state: &AppState, headers: &HeaderMap, via: Option<AuthVia>) -> bool {
    match headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        Some(origin) => {
            if state.config.origin_allowed(origin) {
                return true;
            }
            state.config.app_origins.is_empty() && origin_matches_host(origin, headers)
        }
        None => !matches!(via, Some(AuthVia::Cookie)),
    }
}

fn origin_matches_host(origin: &str, headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let authority = origin
        .trim_end_matches('/')
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(origin);
    authority.eq_ignore_ascii_case(host)
}

pub fn offers_subprotocol(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| value.trim() == SUBPROTOCOL)
}

pub use crate::auth::bearer_from_subprotocols as bearer_token_from_subprotocols;

type ConnId = u64;

const NO_CONN: ConnId = 0;

#[derive(Debug, Clone)]
struct DocEvent {
    origin: ConnId,
    kind: u8,
    bytes: Arc<Vec<u8>>,
}

static HUBS: LazyLock<StdMutex<HashMap<String, Arc<SyncHub>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

struct ConnEntry {
    session_id: String,
    user_id: Id,
    outbox: Arc<Outbox>,
}

struct SyncHub {
    docs: StdMutex<HashMap<Id, broadcast::Sender<DocEvent>>>,
    sessions: StdMutex<HashMap<String, usize>>,
    conns: StdMutex<HashMap<ConnId, ConnEntry>>,
    shutdown: broadcast::Sender<()>,
    shutting_down: AtomicBool,
    next_conn: AtomicU64,
    connections: AtomicUsize,
    subscriptions: AtomicUsize,
    signal_watch: AtomicBool,
    bootstraps: StdMutex<HashMap<Id, usize>>,
    bootstraps_total: AtomicUsize,
}

impl SyncHub {
    fn new() -> Arc<Self> {
        let (shutdown, _) = broadcast::channel(1);
        Arc::new(Self {
            docs: StdMutex::new(HashMap::new()),
            sessions: StdMutex::new(HashMap::new()),
            conns: StdMutex::new(HashMap::new()),
            shutdown,
            shutting_down: AtomicBool::new(false),
            next_conn: AtomicU64::new(1),
            connections: AtomicUsize::new(0),
            subscriptions: AtomicUsize::new(0),
            signal_watch: AtomicBool::new(false),
            bootstraps: StdMutex::new(HashMap::new()),
            bootstraps_total: AtomicUsize::new(0),
        })
    }

    fn get(state: &AppState) -> Arc<Self> {
        let key = state.db.name().to_string();
        let mut hubs = HUBS.lock().expect("sync hub registry poisoned");
        Arc::clone(hubs.entry(key).or_insert_with(SyncHub::new))
    }

    fn acquire_socket(self: &Arc<Self>, session_id: &str, user_id: &str) -> Option<SocketSlot> {
        if self.connections.load(Ordering::Relaxed) >= MAX_SOCKETS_TOTAL {
            tracing::warn!(
                limit = MAX_SOCKETS_TOTAL,
                "sync: refusing a socket — process-wide connection cap reached"
            );
            return None;
        }
        {
            let mut sessions = self.sessions.lock().expect("sync session map poisoned");
            let per_session = sessions.get(session_id).copied().unwrap_or(0);
            if per_session >= MAX_SOCKETS_PER_SESSION {
                return None;
            }
            let per_user = self
                .conns
                .lock()
                .expect("sync connection registry poisoned")
                .values()
                .filter(|entry| entry.user_id == user_id)
                .count();
            if per_user >= MAX_SOCKETS_PER_USER {
                tracing::debug!(
                    user = %user_id,
                    limit = MAX_SOCKETS_PER_USER,
                    "sync: refusing a socket — per-user connection cap reached"
                );
                return None;
            }
            sessions.insert(session_id.to_string(), per_session + 1);
        }
        self.connections.fetch_add(1, Ordering::Relaxed);
        metrics::gauge!(names::WS_CONNECTIONS).set(self.connections.load(Ordering::Relaxed) as f64);
        Some(SocketSlot {
            hub: Arc::clone(self),
            session_id: session_id.to_string(),
        })
    }

    fn register(&self, conn_id: ConnId, entry: ConnEntry) {
        self.conns
            .lock()
            .expect("sync connection registry poisoned")
            .insert(conn_id, entry);
    }

    fn unregister(&self, conn_id: ConnId) {
        self.conns
            .lock()
            .expect("sync connection registry poisoned")
            .remove(&conn_id);
    }

    fn close_matching(&self, reason: &str, predicate: impl Fn(&ConnEntry) -> bool) -> usize {
        let targets: Vec<Arc<Outbox>> = {
            let conns = self
                .conns
                .lock()
                .expect("sync connection registry poisoned");
            conns
                .values()
                .filter(|entry| predicate(entry))
                .map(|entry| Arc::clone(&entry.outbox))
                .collect()
        };
        for outbox in &targets {
            outbox.request_close(close::UNAUTHENTICATED, reason);
        }
        targets.len()
    }

    fn acquire_bootstrap(self: &Arc<Self>, user_id: &str) -> Option<BootstrapSlot> {
        let mut streams = self.bootstraps.lock().expect("bootstrap registry poisoned");
        let total = self.bootstraps_total.load(Ordering::Relaxed);
        if total >= BOOTSTRAP_MAX_TOTAL {
            return None;
        }
        let per_user = streams.entry(user_id.to_string()).or_insert(0);
        if *per_user >= BOOTSTRAP_MAX_PER_USER {
            if *per_user == 0 {
                streams.remove(user_id);
            }
            return None;
        }
        *per_user += 1;
        drop(streams);
        self.bootstraps_total.fetch_add(1, Ordering::Relaxed);
        Some(BootstrapSlot {
            hub: Arc::clone(self),
            user_id: user_id.to_string(),
        })
    }

    fn doc_channel(&self, id: &str) -> broadcast::Sender<DocEvent> {
        let mut docs = self.docs.lock().expect("sync doc map poisoned");
        docs.entry(id.to_string())
            .or_insert_with(|| broadcast::channel(DOC_BROADCAST_CAPACITY).0)
            .clone()
    }

    fn publish(&self, id: &str, event: DocEvent) {
        let sender = {
            let docs = self.docs.lock().expect("sync doc map poisoned");
            docs.get(id).cloned()
        };
        if let Some(sender) = sender {
            let _ = sender.send(event);
        }
    }

    fn prune(&self, id: &str) {
        let mut docs = self.docs.lock().expect("sync doc map poisoned");
        if docs
            .get(id)
            .is_some_and(|sender| sender.receiver_count() == 0)
        {
            docs.remove(id);
        }
    }

    fn subscribe_shutdown(&self) -> broadcast::Receiver<()> {
        self.shutdown.subscribe()
    }

    fn begin_shutdown(&self) {
        if !self.shutting_down.swap(true, Ordering::SeqCst) {
            let _ = self.shutdown.send(());
        }
    }

    fn watch_signals(self: &Arc<Self>) {
        if self.signal_watch.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        {
            let hub = Arc::clone(self);
            tokio::spawn(async move {
                let mut sigterm =
                    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    {
                        Ok(stream) => stream,
                        Err(err) => {
                            tracing::warn!(error = %err, "sync: cannot watch SIGTERM");
                            return;
                        }
                    };
                sigterm.recv().await;
                tracing::info!("sync: SIGTERM — closing sockets with 4503");
                hub.begin_shutdown();
            });
        }
    }
}

struct SocketSlot {
    hub: Arc<SyncHub>,
    session_id: String,
}

impl Drop for SocketSlot {
    fn drop(&mut self) {
        let mut sessions = self.hub.sessions.lock().expect("sync session map poisoned");
        if let Some(count) = sessions.get_mut(&self.session_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                sessions.remove(&self.session_id);
            }
        }
        drop(sessions);
        let live = self
            .hub
            .connections
            .fetch_sub(1, Ordering::Relaxed)
            .saturating_sub(1);
        metrics::gauge!(names::WS_CONNECTIONS).set(live as f64);
    }
}

struct BootstrapSlot {
    hub: Arc<SyncHub>,
    user_id: Id,
}

impl Drop for BootstrapSlot {
    fn drop(&mut self) {
        let mut streams = self
            .hub
            .bootstraps
            .lock()
            .expect("bootstrap registry poisoned");
        if let Some(count) = streams.get_mut(&self.user_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                streams.remove(&self.user_id);
            }
        }
        drop(streams);
        self.hub
            .bootstraps_total
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |total| {
                Some(total.saturating_sub(1))
            })
            .ok();
    }
}

pub fn close_all_sockets(state: &AppState) -> usize {
    let hub = SyncHub::get(state);
    let live = hub.connections.load(Ordering::Relaxed);
    hub.begin_shutdown();
    live
}

pub fn close_session_sockets(state: &AppState, session_id: &str) -> usize {
    let closed = SyncHub::get(state)
        .close_matching("session revoked", |entry| entry.session_id == session_id);
    if closed > 0 {
        tracing::info!(session = %session_id, sockets = closed, "sync: sockets closed after session revocation");
    }
    closed
}

pub fn close_user_sockets(state: &AppState, user_id: &str) -> usize {
    close_user_sockets_except(state, user_id, "")
}

pub fn close_user_sockets_except(state: &AppState, user_id: &str, keep_session_id: &str) -> usize {
    let closed = SyncHub::get(state).close_matching("session revoked", |entry| {
        entry.user_id == user_id && entry.session_id != keep_session_id
    });
    if closed > 0 {
        tracing::info!(user = %user_id, sockets = closed, "sync: sockets closed after revocation");
    }
    closed
}

pub fn publish_update(state: &AppState, id: &str, update: &[u8]) {
    if update.is_empty() {
        return;
    }
    SyncHub::get(state).publish(
        id,
        DocEvent {
            origin: NO_CONN,
            kind: frame::UPDATE,
            bytes: Arc::new(update.to_vec()),
        },
    );
}

pub fn publish_plugin_event(
    state: &AppState,
    plugin_id: &str,
    event: &str,
    payload: &serde_json::Value,
    user_id: Option<&str>,
) -> usize {
    const PLUGIN_EVENT_HEADROOM: usize = CTL_QUEUE_MESSAGES / 2;

    let frame = serde_json::json!({
        "t": "plugin.event",
        "plugin": plugin_id,
        "event": event,
        "payload": payload,
        "at": Timestamp::now().to_rfc3339(),
    });
    let json = match serde_json::to_string(&frame) {
        Ok(json) => json,
        Err(err) => {
            tracing::error!(
                plugin = %plugin_id, %event, error = %err,
                "sync: cannot serialize a plugin event"
            );
            return 0;
        }
    };

    let hub = SyncHub::get(state);
    let targets: Vec<Arc<Outbox>> = {
        let conns = hub.conns.lock().expect("sync connection registry poisoned");
        conns
            .values()
            .filter(|entry| user_id.is_none_or(|target| entry.user_id == target))
            .map(|entry| Arc::clone(&entry.outbox))
            .collect()
    };

    let mut queued = 0usize;
    let mut dropped = 0usize;
    for outbox in &targets {
        let accepted = {
            let mut outbox_state = outbox.lock();
            if outbox_state.closing.is_some() || outbox_state.ctl.len() >= PLUGIN_EVENT_HEADROOM {
                false
            } else {
                outbox_state.ctl.push_back(Message::text(json.clone()));
                true
            }
        };
        if accepted {
            outbox.wake.notify_one();
            queued += 1;
        } else {
            dropped += 1;
        }
    }

    if dropped > 0 {
        metrics::counter!(names::WS_BACKPRESSURE_DROPS, "queue" => "plugin").increment(1);
        tracing::debug!(
            plugin = %plugin_id, %event, dropped,
            "sync: plugin event dropped on sockets that are not keeping up"
        );
    }
    tracing::debug!(
        plugin = %plugin_id, %event, sockets = queued, target = ?user_id,
        "sync: plugin event queued"
    );
    queued
}

pub fn publish_plugins_changed(state: &AppState, version: &str) -> usize {
    const CHANGED_HEADROOM: usize = CTL_QUEUE_MESSAGES / 2;
    let frame = serde_json::json!({
        "t": "plugins.changed",
        "version": version,
    });
    let json = frame.to_string();
    let hub = SyncHub::get(state);
    let targets: Vec<Arc<Outbox>> = {
        let conns = hub.conns.lock().expect("sync connection registry poisoned");
        conns
            .values()
            .map(|entry| Arc::clone(&entry.outbox))
            .collect()
    };
    let mut queued = 0usize;
    for outbox in &targets {
        let accepted = {
            let mut outbox_state = outbox.lock();
            if outbox_state.closing.is_some() || outbox_state.ctl.len() >= CHANGED_HEADROOM {
                false
            } else {
                outbox_state.ctl.push_back(Message::text(json.clone()));
                true
            }
        };
        if accepted {
            outbox.wake.notify_one();
            queued += 1;
        }
    }
    queued
}

pub fn document_subscribers(state: &AppState, id: &str) -> usize {
    let hub = SyncHub::get(state);
    let docs = hub.docs.lock().expect("sync doc map poisoned");
    docs.get(id).map_or(0, broadcast::Sender::receiver_count)
}

struct FeedItem {
    json: String,
    safe_seq: i64,
}

struct DocItem {
    id: Id,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct OutboxState {
    ctl: VecDeque<Message>,
    feed: VecDeque<FeedItem>,
    feed_bytes: usize,
    docs: VecDeque<DocItem>,
    doc_bytes: usize,
    prefer_feed: bool,
    flushed_safe_seq: i64,
    overflows: VecDeque<Instant>,
    closing: Option<(u16, String)>,
    finished: bool,
}

struct Outbox {
    inner: StdMutex<OutboxState>,
    wake: Notify,
    closing: Notify,
}

impl Outbox {
    fn new(initial_safe_seq: i64) -> Arc<Self> {
        Arc::new(Self {
            inner: StdMutex::new(OutboxState {
                flushed_safe_seq: initial_safe_seq,
                ..OutboxState::default()
            }),
            wake: Notify::new(),
            closing: Notify::new(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, OutboxState> {
        self.inner.lock().expect("outbox poisoned")
    }

    fn push_ctl(&self, message: Message) {
        let flooding = {
            let mut state = self.lock();
            if state.closing.is_some() {
                return;
            }
            if state.ctl.len() >= CTL_QUEUE_MESSAGES {
                state.request_close(close::FLOOD, "control queue is not being drained");
                true
            } else {
                state.ctl.push_back(message);
                false
            }
        };
        if flooding {
            self.closing.notify_waiters();
        }
        self.wake.notify_one();
    }

    fn push_json(&self, value: &serde_json::Value) {
        match serde_json::to_string(value) {
            Ok(json) => self.push_ctl(Message::text(json)),
            Err(err) => tracing::error!(error = %err, "sync: cannot serialize control message"),
        }
    }

    #[must_use]
    fn push_feed(&self, json: String, safe_seq: i64) -> bool {
        let (resync_from, flooding) = {
            let mut state = self.lock();
            if state.closing.is_some() {
                return false;
            }
            let bytes = json.len();
            if state.feed.len() >= FEED_QUEUE_MESSAGES
                || state.feed_bytes.saturating_add(bytes) > QUEUE_MAX_BYTES
            {
                state.feed.clear();
                state.feed_bytes = 0;
                let from = state.flushed_safe_seq;
                let flooding = state.record_overflow();
                if flooding {
                    state.request_close(close::FLOOD, "send queue overflowed repeatedly");
                }
                (Some(from), flooding)
            } else {
                state.feed_bytes += bytes;
                state.feed.push_back(FeedItem { json, safe_seq });
                (None, false)
            }
        };
        let accepted = resync_from.is_none();
        if let Some(from_seq) = resync_from {
            metrics::counter!(names::WS_BACKPRESSURE_DROPS, "queue" => "feed").increment(1);
            tracing::debug!(
                from_seq,
                "sync: feed queue overflowed; instructing a resubscribe"
            );
            self.push_json(&serde_json::json!({
                "t": "feed.resync",
                "reason": "backpressure",
                "from_seq": from_seq,
            }));
        }
        if flooding {
            self.closing.notify_waiters();
        }
        self.wake.notify_one();
        accepted
    }

    fn push_doc(&self, id: &str, bytes: Vec<u8>) {
        let (overflowed, flooding) = {
            let mut state = self.lock();
            if state.closing.is_some() {
                return;
            }
            let len = bytes.len();
            if state.docs.len() >= DOC_QUEUE_FRAMES
                || state.doc_bytes.saturating_add(len) > QUEUE_MAX_BYTES
            {
                state.drop_doc_frames(id);
                let flooding = state.record_overflow();
                if flooding {
                    state.request_close(close::FLOOD, "send queue overflowed repeatedly");
                }
                (true, flooding)
            } else {
                state.doc_bytes += len;
                state.docs.push_back(DocItem {
                    id: id.to_string(),
                    bytes,
                });
                (false, false)
            }
        };
        if overflowed {
            metrics::counter!(names::WS_BACKPRESSURE_DROPS, "queue" => "doc").increment(1);
            tracing::debug!(document = %id, "sync: document queue overflowed; instructing a resync");
            self.push_json(&serde_json::json!({
                "t": "doc.resync",
                "id": id,
                "reason": "backpressure",
            }));
        }
        if flooding {
            self.closing.notify_waiters();
        }
        self.wake.notify_one();
    }

    fn drop_doc(&self, id: &str) {
        let mut state = self.lock();
        state.drop_doc_frames(id);
    }

    fn request_close(&self, code: u16, reason: &str) {
        {
            let mut state = self.lock();
            state.request_close(code, reason);
        }
        self.wake.notify_one();
        self.closing.notify_waiters();
    }

    fn finish(&self) {
        {
            let mut state = self.lock();
            state.finished = true;
        }
        self.wake.notify_one();
    }

    fn is_closing(&self) -> bool {
        self.lock().closing.is_some()
    }

    fn pop(&self) -> Option<Message> {
        let mut state = self.lock();
        if let Some(message) = state.ctl.pop_front() {
            return Some(message);
        }
        if state.closing.is_some() {
            return None;
        }
        for _ in 0..2 {
            state.prefer_feed = !state.prefer_feed;
            if state.prefer_feed {
                if let Some(item) = state.feed.pop_front() {
                    state.feed_bytes = state.feed_bytes.saturating_sub(item.json.len());
                    state.flushed_safe_seq = state.flushed_safe_seq.max(item.safe_seq);
                    return Some(Message::text(item.json));
                }
            } else if let Some(item) = state.docs.pop_front() {
                state.doc_bytes = state.doc_bytes.saturating_sub(item.bytes.len());
                return Some(Message::binary(item.bytes));
            }
        }
        None
    }

    fn take_close(&self) -> Option<(u16, String)> {
        self.lock().closing.clone()
    }
}

impl OutboxState {
    fn drop_doc_frames(&mut self, id: &str) {
        let mut kept = VecDeque::with_capacity(self.docs.len());
        let mut bytes = 0;
        for item in self.docs.drain(..) {
            if item.id == id {
                continue;
            }
            bytes += item.bytes.len();
            kept.push_back(item);
        }
        self.docs = kept;
        self.doc_bytes = bytes;
    }

    fn record_overflow(&mut self) -> bool {
        let now = Instant::now();
        while let Some(first) = self.overflows.front() {
            if now.duration_since(*first) > OVERFLOW_WINDOW {
                self.overflows.pop_front();
            } else {
                break;
            }
        }
        self.overflows.push_back(now);
        self.overflows.len() > OVERFLOW_BUDGET
    }

    fn request_close(&mut self, code: u16, reason: &str) {
        if self.closing.is_none() {
            self.closing = Some((code, reason.to_string()));
        }
    }
}

struct RateBucket {
    tokens: f64,
    capacity: f64,
    refill_per_sec: f64,
    last: Instant,
}

impl RateBucket {
    fn new(per_sec: f64, burst: f64) -> Self {
        Self {
            tokens: burst,
            capacity: burst,
            refill_per_sec: per_sec,
            last: Instant::now(),
        }
    }

    fn allow(&mut self, cost: f64) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        if self.tokens >= cost {
            self.tokens -= cost;
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
enum ClientMessage {
    #[serde(rename = "feed.subscribe")]
    FeedSubscribe {
        #[serde(default)]
        since_seq: i64,
        #[serde(default = "default_true")]
        include_content: bool,
        #[serde(default)]
        batch_max_rows: Option<u32>,
    },
    #[serde(rename = "feed.unsubscribe")]
    FeedUnsubscribe,
    #[serde(rename = "doc.subscribe")]
    DocSubscribe {
        id: String,
        #[serde(default)]
        sv: Option<String>,
    },
    #[serde(rename = "doc.unsubscribe")]
    DocUnsubscribe { id: String },
    #[serde(rename = "ping")]
    Ping {
        #[serde(default)]
        ts: i64,
    },
}

fn default_true() -> bool {
    true
}

struct Connection {
    state: AppState,
    hub: Arc<SyncHub>,
    outbox: Arc<Outbox>,
    conn_id: ConnId,
    user_id: Id,
    session_id: String,
    inbound_seen: Arc<AtomicBool>,
}

async fn serve(state: AppState, user: AuthUser, socket: WebSocket) {
    let hub = SyncHub::get(&state);
    hub.watch_signals();

    let (mut sink, mut stream) = socket.split();

    let Some(slot) = hub.acquire_socket(&user.session.id, user.id()) else {
        let _ = sink
            .send(Message::Close(Some(CloseFrame {
                code: close::TOO_MANY_SOCKETS,
                reason: "too many concurrent sockets for this session"
                    .to_string()
                    .into(),
            })))
            .await;
        return;
    };

    let conn_id = hub.next_conn.fetch_add(1, Ordering::Relaxed);
    let outbox = Outbox::new(0);
    let inbound_seen = Arc::new(AtomicBool::new(true));

    let conn = Arc::new(Connection {
        state: state.clone(),
        hub: Arc::clone(&hub),
        outbox: Arc::clone(&outbox),
        conn_id,
        user_id: user.id().to_string(),
        session_id: user.session.id.clone(),
        inbound_seen: Arc::clone(&inbound_seen),
    });

    hub.register(
        conn_id,
        ConnEntry {
            session_id: conn.session_id.clone(),
            user_id: conn.user_id.clone(),
            outbox: Arc::clone(&outbox),
        },
    );

    outbox.push_json(&welcome(&state, &user));

    let writer = tokio::spawn(writer_loop(sink, Arc::clone(&outbox), inbound_seen));
    let revalidator = tokio::spawn(revalidate_loop(Arc::clone(&conn)));
    let shutdown_watch = tokio::spawn(shutdown_loop(Arc::clone(&conn), hub.subscribe_shutdown()));
    if hub.shutting_down.load(Ordering::SeqCst) {
        outbox.request_close(close::SHUTTING_DOWN, "server shutting down");
    }

    tracing::debug!(conn_id, user = %conn.user_id, "sync socket open");
    let mut session = ConnectionSession::new(Arc::clone(&conn));
    session.read_loop(&mut stream).await;
    session.teardown();

    outbox.finish();
    hub.unregister(conn_id);
    revalidator.abort();
    shutdown_watch.abort();
    if tokio::time::timeout(WRITER_DRAIN_TIMEOUT, writer)
        .await
        .is_err()
    {
        tracing::debug!(conn_id, "sync: writer did not drain; dropping the socket");
    }
    drop(slot);
    tracing::debug!(conn_id, "sync socket closed");
}

fn welcome(state: &AppState, user: &AuthUser) -> serde_json::Value {
    serde_json::json!({
        "t": "welcome",
        "protocol": PROTOCOL_VERSION,
        "server_time": Timestamp::now().to_rfc3339(),
        "session": {
            "user_id": user.id(),
            "is_admin": user.is_admin(),
            "via": match user.via { AuthVia::Cookie => "cookie", AuthVia::Bearer => "bearer" },
            "expires_at": Timestamp::from(user.session.expires_at).to_rfc3339(),
        },
        "feed": {
            "head_seq": state.feed.head_seq(),
            "safe_seq": state.feed.safe_seq(),
            "floor_seq": FLOOR_SEQ,
        },
        "limits": {
            "max_frame_bytes": MAX_FRAME_BYTES,
            "max_subscriptions": MAX_SUBSCRIPTIONS,
            "feed_catchup_max_rows": FEED_CATCHUP_MAX_ROWS,
            "inbound_frames_per_sec": INBOUND_FRAMES_PER_SEC,
            "inbound_bytes_per_sec": INBOUND_BYTES_PER_SEC,
            "heartbeat_secs": HEARTBEAT_SECS,
        },
        "core_semantics_version": ddd_core::CORE_SEMANTICS_VERSION,
        "plugins_version": crate::plugins::registry(&state.config).plugins_version(),
    })
}

struct ConnectionSession {
    conn: Arc<Connection>,
    feed_task: Option<tokio::task::JoinHandle<()>>,
    doc_tasks: HashMap<Id, tokio::task::JoinHandle<()>>,
    subscribed: HashSet<Id>,
    frames: RateBucket,
    bytes: RateBucket,
    subscribes: RateBucket,
    malformed_updates: u32,
}

impl ConnectionSession {
    fn new(conn: Arc<Connection>) -> Self {
        Self {
            conn,
            feed_task: None,
            doc_tasks: HashMap::new(),
            subscribed: HashSet::new(),
            frames: RateBucket::new(
                f64::from(INBOUND_FRAMES_PER_SEC),
                f64::from(INBOUND_FRAMES_PER_SEC) * 2.0,
            ),
            bytes: RateBucket::new(
                INBOUND_BYTES_PER_SEC as f64,
                INBOUND_BYTES_PER_SEC as f64 * 2.0,
            ),
            subscribes: RateBucket::new(FEED_SUBSCRIBES_PER_SEC, FEED_SUBSCRIBE_BURST),
            malformed_updates: 0,
        }
    }

    async fn read_loop(&mut self, stream: &mut futures::stream::SplitStream<WebSocket>) {
        let outbox = Arc::clone(&self.conn.outbox);
        loop {
            let closing = outbox.closing.notified();
            tokio::pin!(closing);
            if outbox.is_closing() {
                break;
            }

            let message = tokio::select! {
                message = stream.next() => message,
                () = &mut closing => break,
            };
            let Some(message) = message else { break };
            let message = match message {
                Ok(message) => message,
                Err(err) => {
                    tracing::debug!(error = %err, conn_id = self.conn.conn_id, "sync socket read error");
                    break;
                }
            };

            self.conn.inbound_seen.store(true, Ordering::Relaxed);

            let len = match &message {
                Message::Text(text) => text.len(),
                Message::Binary(bytes) => bytes.len(),
                _ => 0,
            };
            if len > MAX_FRAME_BYTES {
                self.conn
                    .outbox
                    .request_close(close::FRAME_TOO_LARGE, "frame above 4 MiB");
                break;
            }
            if !self.frames.allow(1.0) || !self.bytes.allow(len as f64) {
                self.conn
                    .outbox
                    .request_close(close::FLOOD, "inbound rate cap exceeded");
                break;
            }

            match message {
                Message::Text(text) => {
                    if !self.handle_control(text.as_str()).await {
                        break;
                    }
                }
                Message::Binary(bytes) => {
                    if !self.handle_binary(&bytes).await {
                        break;
                    }
                }
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) => {}
            }

            if self.conn.outbox.is_closing() {
                break;
            }
        }
    }

    async fn handle_control(&mut self, text: &str) -> bool {
        let message: ClientMessage = match serde_json::from_str(text) {
            Ok(message) => message,
            Err(err) => {
                tracing::debug!(error = %err, "sync: unparseable control message");
                self.conn.outbox.request_close(
                    close::PROTOCOL_ERROR,
                    "unknown or malformed control message",
                );
                return false;
            }
        };

        match message {
            ClientMessage::FeedSubscribe {
                since_seq,
                include_content,
                batch_max_rows,
            } => {
                if since_seq < 0 {
                    self.conn
                        .outbox
                        .request_close(close::PROTOCOL_ERROR, "since_seq must be >= 0");
                    return false;
                }
                if !self.subscribes.allow(1.0) {
                    self.conn
                        .outbox
                        .request_close(close::FLOOD, "feed.subscribe rate cap exceeded");
                    return false;
                }
                self.stop_feed();
                let rows = batch_max_rows
                    .unwrap_or(FEED_BATCH_DEFAULT_ROWS)
                    .clamp(1, FEED_BATCH_MAX_ROWS);
                self.feed_task = Some(tokio::spawn(feed_loop(
                    Arc::clone(&self.conn),
                    since_seq,
                    include_content,
                    rows,
                )));
            }
            ClientMessage::FeedUnsubscribe => self.stop_feed(),
            ClientMessage::DocSubscribe { id, sv } => self.subscribe_doc(id, sv).await,
            ClientMessage::DocUnsubscribe { id } => self.unsubscribe_doc(&id),
            ClientMessage::Ping { ts } => {
                self.conn.outbox.push_json(&serde_json::json!({
                    "t": "pong",
                    "ts": ts,
                    "server_time": Timestamp::now().to_rfc3339(),
                }));
            }
        }
        true
    }

    async fn handle_binary(&mut self, bytes: &[u8]) -> bool {
        let Some(parsed) = parse_frame(bytes) else {
            self.conn
                .outbox
                .request_close(close::PROTOCOL_ERROR, "malformed binary envelope");
            return false;
        };

        if parsed.kind >= frame::RESERVED_FLOOR {
            return true;
        }

        if !self.subscribed.contains(&parsed.id) {
            tracing::debug!(
                document = %parsed.id,
                kind = parsed.kind,
                "sync: dropping a frame for a document this socket has not subscribed to"
            );
            return true;
        }

        match parsed.kind {
            frame::SYNC_STEP1 => self.send_step2(&parsed.id, parsed.payload).await,
            frame::UPDATE => {
                if !self
                    .apply_update(&parsed.id, parsed.payload, EditTiming::Live)
                    .await
                {
                    return false;
                }
            }
            frame::SYNC_STEP2 => {
                if !self
                    .apply_update(
                        &parsed.id,
                        parsed.payload,
                        EditTiming::Offline { made_at_ms: None },
                    )
                    .await
                {
                    return false;
                }
            }
            frame::HISTORY => {
                let Some((made_at, update)) = decode_history(parsed.payload) else {
                    self.doc_error(
                        &parsed.id,
                        "malformed_update",
                        "HISTORY frame too short",
                        false,
                    );
                    return true;
                };
                if !self
                    .apply_update(
                        &parsed.id,
                        update,
                        EditTiming::Offline {
                            made_at_ms: Some(made_at),
                        },
                    )
                    .await
                {
                    return false;
                }
            }
            frame::AWARENESS => {
                self.conn.hub.publish(
                    &parsed.id,
                    DocEvent {
                        origin: self.conn.conn_id,
                        kind: frame::AWARENESS,
                        bytes: Arc::new(parsed.payload.to_vec()),
                    },
                );
            }
            frame::AWARENESS_QUERY => {}
            _ => {
                self.conn
                    .outbox
                    .request_close(close::PROTOCOL_ERROR, "unknown binary frame type");
                return false;
            }
        }
        true
    }

    async fn subscribe_doc(&mut self, id: Id, sv: Option<String>) {
        if !is_valid_id(&id) {
            self.doc_error(&id, "invalid_id", "not a ULID", false);
            return;
        }
        if self.subscribed.contains(&id) {
            self.unsubscribe_doc(&id);
        }
        if self.subscribed.len() >= MAX_SUBSCRIPTIONS {
            self.doc_error(
                &id,
                "too_many_subscriptions",
                "subscription limit reached",
                false,
            );
            return;
        }

        let row = match self.conn.state.docs.get_stale(&id).await {
            Ok(row) => row,
            Err(DocStoreError::NotFound(_)) => {
                match self.conn.state.docs.is_graveyarded(&id).await {
                    Ok(true) => self.doc_error(&id, "gone", "permanently deleted", false),
                    Ok(false) => self.doc_error(&id, "not_found", "no such document", false),
                    Err(err) => {
                        tracing::warn!(error = %err, document = %id, "sync: graveyard check failed");
                        self.doc_error(&id, "internal", "graveyard check failed", true);
                    }
                }
                return;
            }
            Err(DocStoreError::InvalidId(_)) => {
                self.doc_error(&id, "invalid_id", "not a ULID", false);
                return;
            }
            Err(err) => {
                tracing::warn!(error = %err, document = %id, "sync: subscribe read failed");
                self.doc_error(&id, "internal", "cannot read document", true);
                return;
            }
        };

        let crdt = match self.conn.state.docs.crdt_state(&id).await {
            Ok(crdt) => crdt,
            Err(err) => {
                tracing::warn!(error = %err, document = %id, "sync: crdt read failed");
                self.doc_error(&id, "internal", "cannot read CRDT state", true);
                return;
            }
        };

        let sender = self.conn.hub.doc_channel(&id);
        let receiver = sender.subscribe();
        let task = tokio::spawn(relay_loop(Arc::clone(&self.conn), id.clone(), receiver));
        self.doc_tasks.insert(id.clone(), task);
        self.subscribed.insert(id.clone());
        self.conn.hub.subscriptions.fetch_add(1, Ordering::Relaxed);
        metrics::gauge!(names::WS_SUBSCRIBED_DOCS)
            .set(self.conn.hub.subscriptions.load(Ordering::Relaxed) as f64);

        self.conn.outbox.push_json(&serde_json::json!({
            "t": "doc.subscribed",
            "id": id,
            "materialized_version": row.materialized_version,
            "updated_at": Timestamp::from(row.updated_at).to_rfc3339(),
            "deleted": row.deleted_at.is_some(),
        }));
        self.conn.outbox.push_doc(
            &id,
            encode_frame(frame::SYNC_STEP1, &id, &crdt.state_vector),
        );

        if let Some(sv) = sv {
            match decode_state_vector(&sv) {
                Some(sv) => self.send_step2(&id, &sv).await,
                None => self.doc_error(&id, "invalid_id", "sv is not valid base64", false),
            }
        }
    }

    fn unsubscribe_doc(&mut self, id: &str) {
        if let Some(task) = self.doc_tasks.remove(id) {
            task.abort();
        }
        if self.subscribed.remove(id) {
            self.conn.hub.subscriptions.fetch_sub(1, Ordering::Relaxed);
            metrics::gauge!(names::WS_SUBSCRIBED_DOCS)
                .set(self.conn.hub.subscriptions.load(Ordering::Relaxed) as f64);
        }
        self.conn.outbox.drop_doc(id);
        self.conn.hub.prune(id);
    }

    async fn send_step2(&mut self, id: &str, state_vector: &[u8]) {
        match self.conn.state.docs.diff(id, state_vector).await {
            Ok(diff) if diff.is_empty() => {}
            Ok(diff) => {
                let payload = encode_frame(frame::SYNC_STEP2, id, &diff);
                if payload.len() > MAX_FRAME_BYTES {
                    self.doc_error_hinted(id, "too_large", "hydrate over REST", "rest");
                    return;
                }
                self.conn.outbox.push_doc(id, payload);
            }
            Err(DocStoreError::NotFound(_)) => {
                self.doc_error(id, "not_found", "no such document", false)
            }
            Err(DocStoreError::MalformedUpdate(_)) => {
                self.doc_error(
                    id,
                    "malformed_update",
                    "state vector is not decodable",
                    false,
                );
            }
            Err(err) => {
                tracing::warn!(error = %err, document = %id, "sync: diff failed");
                self.doc_error(id, "internal", "cannot compute diff", true);
            }
        }
    }

    async fn apply_update(&mut self, id: &str, payload: &[u8], timing: EditTiming) -> bool {
        let actor = crate::domain::Actor::User(self.conn.user_id.clone());
        match self
            .conn
            .state
            .docs
            .apply_update_as(id, payload, &actor, timing)
            .await
        {
            Ok(outcome) => {
                if !outcome.update.is_empty() {
                    self.conn.hub.publish(
                        id,
                        DocEvent {
                            origin: self.conn.conn_id,
                            kind: frame::UPDATE,
                            bytes: Arc::new(outcome.update),
                        },
                    );
                }
                true
            }
            Err(DocStoreError::MalformedUpdate(message)) => {
                self.malformed_updates += 1;
                self.doc_error(id, "malformed_update", &message, false);
                if self.malformed_updates >= MALFORMED_UPDATE_BUDGET {
                    self.conn
                        .outbox
                        .request_close(close::PROTOCOL_ERROR, "repeated malformed updates");
                    return false;
                }
                true
            }
            Err(DocStoreError::NotFound(_)) => {
                self.doc_error(id, "not_found", "no such document", false);
                true
            }
            Err(DocStoreError::InvalidId(_)) => {
                self.doc_error(id, "invalid_id", "not a ULID", false);
                true
            }
            Err(DocStoreError::Contended(_)) => {
                self.doc_error(id, "contended", "write lost its race; retry", true);
                true
            }
            Err(DocStoreError::TooLarge { len, limit }) => {
                self.doc_error(
                    id,
                    "too_large",
                    &format!("document text would be {len} bytes, limit is {limit}"),
                    false,
                );
                true
            }
            Err(err) => {
                tracing::warn!(error = %err, document = %id, "sync: apply_update failed");
                self.doc_error(id, "internal", "cannot apply update", true);
                true
            }
        }
    }

    fn doc_error(&self, id: &str, code: &str, message: &str, retryable: bool) {
        self.conn.outbox.push_json(&serde_json::json!({
            "t": "doc.error",
            "id": id,
            "code": code,
            "message": message,
            "retryable": retryable,
        }));
    }

    fn doc_error_hinted(&self, id: &str, code: &str, message: &str, hint: &str) {
        self.conn.outbox.push_json(&serde_json::json!({
            "t": "doc.error",
            "id": id,
            "code": code,
            "message": message,
            "retryable": false,
            "hint": hint,
        }));
    }

    fn stop_feed(&mut self) {
        if let Some(task) = self.feed_task.take() {
            task.abort();
        }
    }

    fn teardown(&mut self) {
        self.stop_feed();
        for (id, task) in self.doc_tasks.drain() {
            task.abort();
            self.conn.hub.prune(&id);
        }
        let released = self.subscribed.len();
        self.subscribed.clear();
        if released > 0 {
            self.conn
                .hub
                .subscriptions
                .fetch_sub(released, Ordering::Relaxed);
            metrics::gauge!(names::WS_SUBSCRIBED_DOCS)
                .set(self.conn.hub.subscriptions.load(Ordering::Relaxed) as f64);
        }
    }
}

async fn relay_loop(conn: Arc<Connection>, id: Id, mut receiver: broadcast::Receiver<DocEvent>) {
    loop {
        match receiver.recv().await {
            Ok(event) => {
                if event.origin == conn.conn_id {
                    continue;
                }
                conn.outbox
                    .push_doc(&id, encode_frame(event.kind, &id, &event.bytes));
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                tracing::debug!(document = %id, skipped, "sync: fan-out lagged");
                conn.outbox.push_json(&serde_json::json!({
                    "t": "doc.resync",
                    "id": id,
                    "reason": "backpressure",
                }));
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

async fn feed_loop(conn: Arc<Connection>, since_seq: i64, include_content: bool, batch_rows: u32) {
    let feed = Arc::clone(&conn.state.feed);
    let mut notices = feed.subscribe();

    let pending_bound = feed.head_seq().saturating_sub(since_seq).max(0) as u64;
    let needs_count = pending_bound > FEED_CATCHUP_MAX_ROWS;
    match if needs_count {
        feed.count_since(since_seq).await
    } else {
        Ok(pending_bound)
    } {
        Ok(pending) if pending > FEED_CATCHUP_MAX_ROWS => {
            conn.outbox.push_json(&serde_json::json!({
                "t": "feed.reset",
                "reason": "bootstrap_required",
                "floor_seq": FLOOR_SEQ,
                "head_seq": feed.head_seq(),
                "pending_rows": pending,
            }));
            return;
        }
        Ok(_) => {}
        Err(err) => {
            tracing::warn!(error = %err, "sync: feed count failed");
            conn.outbox.push_json(&serde_json::json!({
                "t": "error",
                "code": "internal",
                "message": "feed catch-up failed",
                "fatal": false,
            }));
            return;
        }
    }

    let mut cursor = since_seq;
    let mut caught_up = false;

    loop {
        let page = match feed.rows_since(cursor, batch_rows, include_content).await {
            Ok(page) => page,
            Err(crate::feed::FeedError::SeqAhead { since, head }) => {
                conn.outbox.push_json(&serde_json::json!({
                    "t": "feed.reset",
                    "reason": "seq_ahead",
                    "floor_seq": FLOOR_SEQ,
                    "head_seq": head,
                    "since_seq": since,
                }));
                return;
            }
            Err(err) => {
                tracing::warn!(error = %err, "sync: feed read failed");
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };

        let complete = !caught_up && page.complete;
        if !page.rows.is_empty() || complete {
            let mode = if caught_up { "live" } else { "catchup" };
            match split_batches(&page, mode, complete) {
                Ok(batches) => {
                    for batch in batches {
                        if !conn.outbox.push_feed(batch.json, batch.safe_seq) {
                            tracing::debug!("sync: feed producer stopping after a dropped batch");
                            return;
                        }
                    }
                }
                Err(oversize) => {
                    tracing::warn!(
                        document = %oversize.id,
                        bytes = oversize.bytes,
                        "sync: feed row exceeds the frame ceiling; sending clients to bootstrap"
                    );
                    conn.outbox.push_json(&serde_json::json!({
                        "t": "feed.reset",
                        "reason": "bootstrap_required",
                        "floor_seq": FLOOR_SEQ,
                        "head_seq": page.head_seq,
                        "pending_rows": page.rows.len(),
                    }));
                    return;
                }
            }
        }
        cursor = cursor.max(page.safe_seq);
        if complete {
            caught_up = true;
        }

        if !page.complete {
            continue;
        }

        if feed.head_seq() > cursor {
            tokio::time::sleep(Duration::from_millis(TAIL_COALESCE_MS)).await;
            continue;
        }

        match notices.recv().await {
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(_)) => {}
            Err(broadcast::error::RecvError::Closed) => return,
        }
        tokio::time::sleep(Duration::from_millis(TAIL_COALESCE_MS)).await;
        while notices.try_recv().is_ok() {}
    }
}

#[derive(Debug)]
struct FeedBatchJson {
    json: String,
    safe_seq: i64,
}

#[derive(Debug)]
struct OversizeRow {
    id: Id,
    bytes: usize,
}

fn split_batches(
    page: &crate::feed::FeedPage,
    mode: &str,
    complete: bool,
) -> Result<Vec<FeedBatchJson>, OversizeRow> {
    const ENVELOPE_BYTES: usize = 256;

    let mut rows: Vec<(i64, String)> = Vec::with_capacity(page.rows.len());
    for row in &page.rows {
        let json = serde_json::to_string(row).unwrap_or_else(|err| {
            tracing::error!(error = %err, document = %row.id, "sync: cannot serialize a feed row");
            "{}".to_string()
        });
        if json.len() + ENVELOPE_BYTES > MAX_FRAME_BYTES {
            return Err(OversizeRow {
                id: row.id.clone(),
                bytes: json.len(),
            });
        }
        rows.push((row.seq, json));
    }

    if rows.is_empty() {
        return Ok(vec![FeedBatchJson {
            json: batch_json(mode, &[], page.safe_seq, page.head_seq, complete),
            safe_seq: page.safe_seq,
        }]);
    }

    let mut batches = Vec::new();
    let mut chunk: Vec<&str> = Vec::new();
    let mut chunk_bytes = ENVELOPE_BYTES;
    let mut chunk_last_seq = page.safe_seq;

    for (index, (seq, json)) in rows.iter().enumerate() {
        if !chunk.is_empty() && chunk_bytes + json.len() + 1 > FEED_BATCH_MAX_BYTES {
            batches.push(FeedBatchJson {
                json: batch_json(mode, &chunk, chunk_last_seq, page.head_seq, false),
                safe_seq: chunk_last_seq,
            });
            chunk.clear();
            chunk_bytes = ENVELOPE_BYTES;
        }
        chunk_bytes += json.len() + 1;
        chunk.push(json.as_str());
        chunk_last_seq = *seq;
        let last = index + 1 == rows.len();
        if last {
            batches.push(FeedBatchJson {
                json: batch_json(mode, &chunk, page.safe_seq, page.head_seq, complete),
                safe_seq: page.safe_seq,
            });
        }
    }

    Ok(batches)
}

fn batch_json(mode: &str, rows: &[&str], safe_seq: i64, head_seq: i64, complete: bool) -> String {
    let payload = rows.iter().map(|row| row.len() + 1).sum::<usize>();
    let mut json = String::with_capacity(payload + 128);
    json.push_str("{\"t\":\"feed.batch\",\"mode\":\"");
    json.push_str(mode);
    json.push_str("\",\"rows\":[");
    for (index, row) in rows.iter().enumerate() {
        if index > 0 {
            json.push(',');
        }
        json.push_str(row);
    }
    json.push_str("],\"safe_seq\":");
    json.push_str(&safe_seq.to_string());
    json.push_str(",\"head_seq\":");
    json.push_str(&head_seq.to_string());
    json.push_str(",\"complete\":");
    json.push_str(if complete { "true" } else { "false" });
    json.push('}');
    json
}

async fn writer_loop(
    mut sink: futures::stream::SplitSink<WebSocket, Message>,
    outbox: Arc<Outbox>,
    inbound_seen: Arc<AtomicBool>,
) {
    let mut ping = tokio::time::interval(Duration::from_secs(SERVER_PING_SECS));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await;
    let mut missed_pings = 0u32;

    loop {
        while let Some(message) = outbox.pop() {
            if sink.send(message).await.is_err() {
                return;
            }
        }

        if let Some((code, reason)) = outbox.take_close() {
            let _ = sink
                .send(Message::Close(Some(CloseFrame {
                    code,
                    reason: reason.into(),
                })))
                .await;
            let _ = sink.flush().await;
            return;
        }

        if outbox.lock().finished {
            let _ = sink.flush().await;
            return;
        }

        tokio::select! {
            () = outbox.wake.notified() => {}
            _ = ping.tick() => {
                if inbound_seen.swap(false, Ordering::Relaxed) {
                    missed_pings = 0;
                } else {
                    missed_pings += 1;
                    if missed_pings >= MISSED_PINGS_BEFORE_CLOSE {
                        tracing::debug!("sync: no client traffic for two ping periods; closing");
                        return;
                    }
                }
                if sink.send(Message::Ping(bytes::Bytes::new())).await.is_err() {
                    return;
                }
            }
        }
    }
}

async fn revalidate_loop(conn: Arc<Connection>) {
    loop {
        tokio::time::sleep(revalidate_delay()).await;
        match session_still_valid(&conn).await {
            Ok(true) => {}
            Ok(false) => {
                conn.outbox
                    .request_close(close::UNAUTHENTICATED, "session is no longer valid");
                return;
            }
            Err(err) => tracing::warn!(error = %err, "sync: session revalidation failed"),
        }
    }
}

fn revalidate_delay() -> Duration {
    let jitter: u64 = rand::random_range(0..=SESSION_REVALIDATE_JITTER_SECS);
    Duration::from_secs(SESSION_REVALIDATE_SECS + jitter)
}

async fn session_still_valid(conn: &Connection) -> Result<bool, mongodb::error::Error> {
    let session = conn
        .state
        .collections
        .sessions()
        .find_one(bson::doc! { "_id": &conn.session_id })
        .await?;
    let Some(session) = session else {
        return Ok(false);
    };
    let now = bson::DateTime::now();
    if session.expires_at <= now || session.absolute_expires_at <= now {
        return Ok(false);
    }
    let user = conn
        .state
        .collections
        .users()
        .find_one(bson::doc! { "_id": &session.user_id })
        .await?;
    Ok(user.is_some_and(|user| user.is_active))
}

async fn shutdown_loop(conn: Arc<Connection>, mut shutdown: broadcast::Receiver<()>) {
    let _ = shutdown.recv().await;
    conn.outbox
        .request_close(close::SHUTTING_DOWN, "server shutting down");
}

struct ParsedFrame<'a> {
    kind: u8,
    id: Id,
    payload: &'a [u8],
}

fn parse_frame(bytes: &[u8]) -> Option<ParsedFrame<'_>> {
    let (&kind, rest) = bytes.split_first()?;
    let (&id_len, rest) = rest.split_first()?;
    if id_len == 0 || rest.len() < id_len as usize {
        return None;
    }
    let (id, payload) = rest.split_at(id_len as usize);
    let id = std::str::from_utf8(id).ok()?;
    if !is_valid_id(id) {
        return None;
    }
    Some(ParsedFrame {
        kind,
        id: id.to_string(),
        payload,
    })
}

fn encode_frame(kind: u8, id: &str, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(2 + id.len() + payload.len());
    frame.push(kind);
    frame.push(id.len() as u8);
    frame.extend_from_slice(id.as_bytes());
    frame.extend_from_slice(payload);
    frame
}

fn decode_state_vector(encoded: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Flag(bool);

impl Flag {
    pub fn is_set(self) -> bool {
        self.0
    }
}

impl<'de> Deserialize<'de> for Flag {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FlagVisitor;

        impl<'v> Visitor<'v> for FlagVisitor {
            type Value = Flag;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a boolean, or one of 1/0/true/false/yes/no")
            }

            fn visit_bool<E: de::Error>(self, value: bool) -> Result<Flag, E> {
                Ok(Flag(value))
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<Flag, E> {
                Ok(Flag(value != 0))
            }

            fn visit_i64<E: de::Error>(self, value: i64) -> Result<Flag, E> {
                Ok(Flag(value != 0))
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<Flag, E> {
                match value.trim().to_ascii_lowercase().as_str() {
                    "1" | "true" | "yes" | "on" => Ok(Flag(true)),
                    "0" | "false" | "no" | "off" | "" => Ok(Flag(false)),
                    other => Err(E::custom(format!("not a boolean: {other}"))),
                }
            }
        }

        deserializer.deserialize_any(FlagVisitor)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct BootstrapParams {
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub trash: Option<String>,
    #[serde(default)]
    pub include_content: Option<Flag>,
    #[serde(default)]
    pub probe: Option<Flag>,
}

impl BootstrapParams {
    pub fn page_limit(&self) -> u32 {
        self.limit
            .unwrap_or(BOOTSTRAP_DEFAULT_LIMIT)
            .clamp(1, BOOTSTRAP_MAX_LIMIT)
    }

    pub fn trash_filter(&self) -> AppResult<TrashFilter> {
        match self.trash.as_deref().map(str::trim) {
            None | Some("") | Some("all") => Ok(TrashFilter::All),
            Some("live") => Ok(TrashFilter::Live),
            Some("trashed") => Ok(TrashFilter::Trashed),
            Some(other) => Err(AppError::bad_request(format!(
                "trash must be live, trashed or all (got `{other}`)"
            ))),
        }
    }

    pub fn wants_content(&self) -> bool {
        self.include_content.is_none_or(Flag::is_set)
    }

    pub fn is_probe(&self) -> bool {
        self.probe.is_some_and(Flag::is_set)
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct BootstrapCursor<'a> {
    after_id: Option<&'a str>,
    pinned_safe_seq: Option<i64>,
    pinned_total: Option<u64>,
}

impl<'a> BootstrapCursor<'a> {
    fn parse(raw: Option<&'a str>) -> Self {
        let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
            return Self::default();
        };
        let mut parts = raw.split('.');
        let Some(id) = parts.next().filter(|id| !id.is_empty()) else {
            return Self::default();
        };
        let pinned_safe_seq = parts
            .next()
            .and_then(|seq| seq.parse::<i64>().ok())
            .filter(|seq| *seq >= 0);
        let pinned_total = parts.next().and_then(|total| total.parse::<u64>().ok());
        Self {
            after_id: Some(id),
            pinned_safe_seq,
            pinned_total,
        }
    }

    fn encode(after_id: &str, safe_seq: i64, total: u64) -> String {
        format!("{after_id}.{safe_seq}.{total}")
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BootstrapHeader {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub protocol: u32,
    pub safe_seq: i64,
    pub total: u64,
    pub limit: u32,
    pub cursor: Option<String>,
    pub core_semantics_version: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct BootstrapFooter {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub count: usize,
    pub next_cursor: Option<String>,
    pub complete: bool,
    pub safe_seq: i64,
}

pub async fn bootstrap(
    State(state): State<AppState>,
    user: AuthUser,
    Query(params): Query<BootstrapParams>,
) -> AppResult<Response> {
    let trash = params.trash_filter()?;
    let limit = params.page_limit();
    let include_content = params.wants_content();
    let feed = Arc::clone(&state.feed);

    let slot =
        SyncHub::get(&state)
            .acquire_bootstrap(user.id())
            .ok_or(AppError::TooManyRequests {
                retry_after_secs: 2,
            })?;

    let cursor = BootstrapCursor::parse(params.cursor.as_deref());
    let safe_seq = cursor.pinned_safe_seq.unwrap_or_else(|| feed.safe_seq());
    let total = match cursor.pinned_total {
        Some(total) => total,
        None => feed.bootstrap_total(trash).await.map_err(map_feed_error)?,
    };

    let header = BootstrapHeader {
        kind: "header",
        protocol: PROTOCOL_VERSION,
        safe_seq,
        total,
        limit,
        cursor: params.cursor.clone(),
        core_semantics_version: ddd_core::CORE_SEMANTICS_VERSION,
    };

    let rows = if params.is_probe() {
        None
    } else {
        Some(
            feed.bootstrap_cursor(cursor.after_id, limit, trash, include_content)
                .await
                .map_err(map_feed_error)?,
        )
    };

    let body = Body::from_stream(ndjson_stream(NdjsonPage {
        header,
        rows,
        limit,
        include_content,
        safe_seq,
        total,
        slot,
    }));
    let mut response = Response::new(body);
    for (name, value) in ndjson_headers() {
        response
            .headers_mut()
            .insert(name, header::HeaderValue::from_static(value));
    }
    Ok(response)
}

struct NdjsonPage {
    header: BootstrapHeader,
    rows: Option<mongodb::Cursor<crate::domain::DocumentRow>>,
    limit: u32,
    include_content: bool,
    safe_seq: i64,
    total: u64,
    #[allow(dead_code)]
    slot: BootstrapSlot,
}

fn ndjson_stream(page: NdjsonPage) -> impl futures::Stream<Item = Result<Vec<u8>, std::io::Error>> {
    use futures::TryStreamExt;

    enum Stage {
        Header,
        Rows,
        Footer,
        Done,
    }

    struct State {
        page: NdjsonPage,
        stage: Stage,
        read: u32,
        emitted: usize,
        last_id: Option<String>,
        complete: bool,
    }

    futures::stream::unfold(
        State {
            page,
            stage: Stage::Header,
            read: 0,
            emitted: 0,
            last_id: None,
            complete: true,
        },
        |mut state| async move {
            loop {
                match state.stage {
                    Stage::Header => {
                        let line = ndjson_line(&state.page.header);
                        state.stage = if state.page.rows.is_some() {
                            Stage::Rows
                        } else {
                            Stage::Done
                        };
                        return Some((line, state));
                    }
                    Stage::Rows => {
                        let Some(cursor) = state.page.rows.as_mut() else {
                            state.stage = Stage::Footer;
                            continue;
                        };
                        if state.read >= state.page.limit {
                            match cursor.try_next().await {
                                Ok(Some(_)) => state.complete = false,
                                Ok(None) => state.complete = true,
                                Err(err) => return Some((Err(mongo_io_error(&err)), state)),
                            }
                            state.stage = Stage::Footer;
                            continue;
                        }
                        match cursor.try_next().await {
                            Ok(Some(row)) => {
                                state.read += 1;
                                state.last_id = Some(row.id.clone());
                                let Some(row) = FeedRow::from_row(row, state.page.include_content)
                                else {
                                    continue;
                                };
                                state.emitted += 1;
                                let mut value = serde_json::to_value(&row).unwrap_or_default();
                                if let serde_json::Value::Object(map) = &mut value {
                                    map.insert("type".into(), serde_json::Value::from("row"));
                                }
                                let line = ndjson_line(&value);
                                return Some((line, state));
                            }
                            Ok(None) => {
                                state.complete = true;
                                state.stage = Stage::Footer;
                                continue;
                            }
                            Err(err) => return Some((Err(mongo_io_error(&err)), state)),
                        }
                    }
                    Stage::Footer => {
                        let next_cursor = (!state.complete)
                            .then_some(state.last_id.as_deref())
                            .flatten()
                            .map(|id| {
                                BootstrapCursor::encode(id, state.page.safe_seq, state.page.total)
                            });
                        let footer = BootstrapFooter {
                            kind: "footer",
                            next_cursor,
                            count: state.emitted,
                            complete: state.complete,
                            safe_seq: state.page.safe_seq,
                        };
                        let line = ndjson_line(&footer);
                        state.stage = Stage::Done;
                        return Some((line, state));
                    }
                    Stage::Done => return None,
                }
            }
        },
    )
}

fn mongo_io_error(err: &mongodb::error::Error) -> std::io::Error {
    tracing::warn!(error = %err, "sync: bootstrap stream failed mid-page");
    std::io::Error::other(format!("bootstrap read failed: {err}"))
}

fn ndjson_line<T: Serialize>(value: &T) -> Result<Vec<u8>, std::io::Error> {
    let mut line = serde_json::to_vec(value)
        .map_err(|err| std::io::Error::other(format!("ndjson serialization failed: {err}")))?;
    line.push(b'\n');
    Ok(line)
}

pub const NDJSON_CONTENT_TYPE: &str = "application/x-ndjson";

pub fn ndjson_headers() -> [(header::HeaderName, &'static str); 3] {
    [
        (header::CONTENT_TYPE, NDJSON_CONTENT_TYPE),
        (header::CACHE_CONTROL, "no-store"),
        (
            header::HeaderName::from_static("x-content-type-options"),
            "nosniff",
        ),
    ]
}

pub fn map_feed_error(error: crate::feed::FeedError) -> AppError {
    use crate::feed::FeedError;
    match error {
        FeedError::SeqAhead { since, head } => AppError::conflict(format!(
            "resume point {since} is ahead of the server head {head}; run a bootstrap pass"
        )),
        FeedError::Db(error) => AppError::Db(error),
        FeedError::Bson(message) => AppError::Internal(anyhow::anyhow!(message)),
    }
}

fn decode_history(payload: &[u8]) -> Option<(i64, &[u8])> {
    let (time, update) = payload.split_at_checked(8)?;
    let millis = u64::from_be_bytes(time.try_into().ok()?);
    Some((i64::try_from(millis).unwrap_or(i64::MAX), update))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(values: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in values {
            map.append(
                header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value).unwrap(),
            );
        }
        map
    }

    const ID: &str = "01J8ZQ0M3M4YQV0X0PTN9R2G7C";

    #[test]
    fn a_bootstrap_cursor_carries_the_pinned_watermark() {
        let first = BootstrapCursor::parse(None);
        assert_eq!(first.after_id, None);
        assert_eq!(first.pinned_safe_seq, None);
        assert_eq!(first.pinned_total, None);
        assert_eq!(BootstrapCursor::parse(Some("  ")), first);

        let encoded = BootstrapCursor::encode(ID, 48_213, 5_000);
        assert_eq!(encoded, format!("{ID}.48213.5000"));
        let next = BootstrapCursor::parse(Some(&encoded));
        assert_eq!(next.after_id, Some(ID));
        assert_eq!(
            next.pinned_safe_seq,
            Some(48_213),
            "the pin survives the round trip, so every page of a pass reports it"
        );
        assert_eq!(
            next.pinned_total,
            Some(5_000),
            "the row total is pinned too: a stable progress denominator, and one \
             workspace-wide count per pass instead of one per page"
        );

        let bare = BootstrapCursor::parse(Some(ID));
        assert_eq!(bare.after_id, Some(ID));
        assert_eq!(bare.pinned_safe_seq, None);
        assert_eq!(bare.pinned_total, None);

        let legacy = format!("{ID}.48213");
        let two = BootstrapCursor::parse(Some(&legacy));
        assert_eq!(two.pinned_safe_seq, Some(48_213));
        assert_eq!(two.pinned_total, None);

        for spec in [
            format!("{ID}.not-a-number"),
            format!("{ID}."),
            format!("{ID}.-4"),
        ] {
            let cursor = BootstrapCursor::parse(Some(&spec));
            assert_eq!(cursor.after_id, Some(ID), "{spec}");
            assert_eq!(cursor.pinned_safe_seq, None, "{spec}");
        }

        assert_eq!(
            BootstrapCursor::parse(Some(&format!("{ID}.0"))).pinned_safe_seq,
            Some(0),
            "seq 0 is a legitimate pin: an empty workspace bootstraps at the feed's start"
        );
    }

    #[test]
    fn subprotocol_offer_is_detected_in_a_list() {
        let map = headers(&[("sec-websocket-protocol", "ddd.v1, ddd.bearer.abc")]);
        assert!(offers_subprotocol(&map));
        assert_eq!(bearer_token_from_subprotocols(&map).as_deref(), Some("abc"));
    }

    #[test]
    fn a_missing_offer_is_rejected() {
        let map = headers(&[("sec-websocket-protocol", "chat")]);
        assert!(!offers_subprotocol(&map));
        assert_eq!(bearer_token_from_subprotocols(&map), None);
    }

    #[test]
    fn an_empty_bearer_subprotocol_is_not_a_token() {
        let map = headers(&[("sec-websocket-protocol", "ddd.bearer.")]);
        assert_eq!(bearer_token_from_subprotocols(&map), None);
    }

    #[test]
    fn bootstrap_limit_is_clamped() {
        let params = |limit| BootstrapParams {
            cursor: None,
            limit,
            trash: None,
            include_content: None,
            probe: None,
        };
        assert_eq!(params(None).page_limit(), BOOTSTRAP_DEFAULT_LIMIT);
        assert_eq!(params(Some(0)).page_limit(), 1);
        assert_eq!(params(Some(10_000)).page_limit(), BOOTSTRAP_MAX_LIMIT);
    }

    #[test]
    fn bootstrap_flags_accept_both_spellings() {
        let parse = |query: &str| -> BootstrapParams {
            let uri: axum::http::Uri = format!("/api/sync/bootstrap?{query}").parse().unwrap();
            Query::<BootstrapParams>::try_from_uri(&uri)
                .expect("query parses")
                .0
        };
        assert!(parse("probe=1").is_probe());
        assert!(parse("probe=true").is_probe());
        assert!(!parse("probe=0").is_probe());
        assert!(!parse("").is_probe());
        assert!(parse("").wants_content());
        assert!(!parse("include_content=false").wants_content());
        assert!(!parse("include_content=0").wants_content());
    }

    #[test]
    fn trash_selection_defaults_to_all_and_rejects_junk() {
        let params = |trash: Option<&str>| BootstrapParams {
            cursor: None,
            limit: None,
            trash: trash.map(str::to_owned),
            include_content: None,
            probe: None,
        };
        assert!(matches!(params(None).trash_filter(), Ok(TrashFilter::All)));
        assert!(matches!(
            params(Some("live")).trash_filter(),
            Ok(TrashFilter::Live)
        ));
        assert!(matches!(
            params(Some("trashed")).trash_filter(),
            Ok(TrashFilter::Trashed)
        ));
        assert!(params(Some("bin")).trash_filter().is_err());
    }

    #[test]
    fn frames_round_trip() {
        let encoded = encode_frame(frame::UPDATE, ID, &[1, 2, 3]);
        let parsed = parse_frame(&encoded).expect("parses");
        assert_eq!(parsed.kind, frame::UPDATE);
        assert_eq!(parsed.id, ID);
        assert_eq!(parsed.payload, &[1, 2, 3]);
    }

    #[test]
    fn an_empty_payload_is_a_valid_frame() {
        let encoded = encode_frame(frame::AWARENESS_QUERY, ID, &[]);
        let parsed = parse_frame(&encoded).expect("parses");
        assert!(parsed.payload.is_empty());
    }

    #[test]
    fn malformed_envelopes_are_rejected() {
        assert!(parse_frame(&[]).is_none());
        assert!(parse_frame(&[frame::UPDATE]).is_none());
        assert!(parse_frame(&[frame::UPDATE, 0]).is_none());
        assert!(parse_frame(&[frame::UPDATE, 26, b'x']).is_none());
        let mut bad = vec![frame::UPDATE, 26];
        bad.extend_from_slice(&[b'!'; 26]);
        assert!(parse_frame(&bad).is_none());
    }

    #[test]
    fn feed_overflow_drops_the_queue_and_instructs_a_resync() {
        let outbox = Outbox::new(0);
        for seq in 1..=FEED_QUEUE_MESSAGES as i64 {
            assert!(outbox.push_feed(format!("{{\"seq\":{seq}}}"), seq));
        }
        assert_eq!(outbox.lock().feed.len(), FEED_QUEUE_MESSAGES);
        assert!(
            !outbox.push_feed("{\"seq\":999}".into(), 999),
            "an overflowed push must tell the feed producer to stop"
        );
        let state = outbox.lock();
        assert!(state.feed.is_empty());
        assert_eq!(state.feed_bytes, 0);
        let ctl = state.ctl.back().expect("resync queued");
        let text = ctl.to_text().unwrap();
        assert!(text.contains("feed.resync"), "{text}");
        assert!(text.contains("\"from_seq\":0"), "{text}");
    }

    #[test]
    fn a_flushed_batch_moves_the_resync_point() {
        let outbox = Outbox::new(0);
        assert!(outbox.push_feed("{}".into(), 42));
        outbox.pop().expect("ctl or feed");
        assert_eq!(outbox.lock().flushed_safe_seq, 42);
    }

    #[test]
    fn document_overflow_only_drops_the_offending_document() {
        let outbox = Outbox::new(0);
        let other = "01J8ZQ0M3M4YQV0X0PTN9R2G7D";
        outbox.push_doc(other, vec![7; 8]);
        for _ in 0..(DOC_QUEUE_FRAMES - 1) {
            outbox.push_doc(ID, vec![1; 4]);
        }
        assert_eq!(outbox.lock().docs.len(), DOC_QUEUE_FRAMES);
        outbox.push_doc(ID, vec![1; 4]);
        let state = outbox.lock();
        assert_eq!(state.docs.len(), 1);
        assert_eq!(state.docs.front().unwrap().id, other);
        assert!(
            state
                .ctl
                .back()
                .unwrap()
                .to_text()
                .unwrap()
                .contains("doc.resync")
        );
    }

    #[test]
    fn repeated_overflow_closes_with_4408() {
        let outbox = Outbox::new(0);
        for _ in 0..(OVERFLOW_BUDGET + 1) {
            for _ in 0..=FEED_QUEUE_MESSAGES {
                let _ = outbox.push_feed("{}".into(), 1);
            }
        }
        assert_eq!(
            outbox.take_close().map(|(code, _)| code),
            Some(close::FLOOD)
        );
    }

    #[test]
    fn control_messages_outrank_data() {
        let outbox = Outbox::new(0);
        outbox.push_doc(ID, vec![1, 2]);
        let _ = outbox.push_feed("{}".into(), 1);
        outbox.push_ctl(Message::text("{\"t\":\"pong\"}"));
        let first = outbox.pop().expect("something queued");
        assert!(first.to_text().unwrap().contains("pong"));
    }

    #[test]
    fn unsubscribing_drops_that_documents_frames() {
        let outbox = Outbox::new(0);
        outbox.push_doc(ID, vec![1, 2, 3]);
        outbox.drop_doc(ID);
        let state = outbox.lock();
        assert!(state.docs.is_empty());
        assert_eq!(state.doc_bytes, 0);
    }

    fn page_of(count: usize, bytes: usize, safe_seq: i64) -> crate::feed::FeedPage {
        let rows = (0..count)
            .map(|index| {
                let mut row = FeedRow::purged(
                    index as i64 + 1,
                    format!("01J8ZQ0M3M4YQV0X0PTN9R2{index:03}"),
                    Timestamp::from_millis(0),
                    None,
                );
                row.content = Some("x".repeat(bytes));
                row
            })
            .collect();
        crate::feed::FeedPage {
            rows,
            safe_seq,
            head_seq: safe_seq,
            complete: true,
        }
    }

    #[test]
    fn a_big_page_is_split_into_frame_sized_batches() {
        let page = page_of(40, 64 * 1024, 40);
        let batches = split_batches(&page, "catchup", true).expect("no oversize row");

        assert!(
            batches.len() > 1,
            "a multi-megabyte page must not be one message"
        );
        for batch in &batches {
            assert!(
                batch.json.len() <= FEED_BATCH_MAX_BYTES + 128 * 1024,
                "batch of {} bytes is over the budget",
                batch.json.len()
            );
            assert!(batch.json.len() < MAX_FRAME_BYTES);
        }

        let mut previous = 0;
        for batch in &batches {
            assert!(batch.safe_seq > previous, "watermarks must advance");
            previous = batch.safe_seq;
        }
        assert_eq!(batches.last().unwrap().safe_seq, page.safe_seq);
        assert!(batches.last().unwrap().json.contains("\"complete\":true"));
        for batch in &batches[..batches.len() - 1] {
            assert!(batch.json.contains("\"complete\":false"));
        }

        let mut delivered = 0;
        for batch in &batches {
            let value: serde_json::Value = serde_json::from_str(&batch.json).expect("valid JSON");
            assert_eq!(value["t"], "feed.batch");
            assert_eq!(value["mode"], "catchup");
            delivered += value["rows"].as_array().expect("rows").len();
        }
        assert_eq!(delivered, page.rows.len());
    }

    #[test]
    fn an_empty_page_is_still_one_batch() {
        let page = crate::feed::FeedPage {
            rows: Vec::new(),
            safe_seq: 7,
            head_seq: 7,
            complete: true,
        };
        let batches = split_batches(&page, "live", true).expect("no rows, no oversize");
        assert_eq!(batches.len(), 1, "a `complete` batch with no rows is legal");
        assert_eq!(batches[0].safe_seq, 7);
    }

    #[test]
    fn a_row_too_big_for_a_frame_is_reported_not_sent() {
        let page = page_of(1, MAX_FRAME_BYTES + 1, 1);
        let oversize = split_batches(&page, "catchup", true).expect_err("must not be sendable");
        assert!(oversize.bytes > MAX_FRAME_BYTES);
    }

    #[test]
    fn the_rate_bucket_allows_a_burst_then_throttles() {
        let mut bucket = RateBucket::new(10.0, 20.0);
        for _ in 0..20 {
            assert!(bucket.allow(1.0));
        }
        assert!(!bucket.allow(1.0));
    }

    #[test]
    fn control_messages_parse_by_tag() {
        let parsed: ClientMessage =
            serde_json::from_str(r#"{"t":"feed.subscribe","since_seq":7}"#).unwrap();
        match parsed {
            ClientMessage::FeedSubscribe {
                since_seq,
                include_content,
                batch_max_rows,
            } => {
                assert_eq!(since_seq, 7);
                assert!(include_content);
                assert_eq!(batch_max_rows, None);
            }
            other => panic!("wrong variant: {other:?}"),
        }
        assert!(serde_json::from_str::<ClientMessage>(r#"{"t":"plugin.emit"}"#).is_err());
        assert!(serde_json::from_str::<ClientMessage>("not json").is_err());
    }

    #[test]
    fn an_origin_matching_the_host_is_same_origin() {
        let map = headers(&[("host", "notes.example.com")]);
        assert!(origin_matches_host("https://notes.example.com", &map));
        assert!(origin_matches_host("http://notes.example.com/", &map));
        assert!(!origin_matches_host("https://evil.example.com", &map));
    }
}

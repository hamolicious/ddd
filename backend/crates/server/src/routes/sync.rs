//! `/api/sync` — the WebSocket sync endpoint and the bootstrap stream.
//!
//! The wire protocol is specified in [`backend/PROTOCOL.md`](../../../../PROTOCOL.md)
//! and that document is authoritative: this module implements it, the client's
//! `web/kernel/src/sync/` implements the other half, and neither is allowed to
//! invent anything the document does not describe.
//!
//! ```text
//! GET /api/sync             -> WebSocket upgrade: change feed + per-doc CRDT sync
//! GET /api/sync/bootstrap   -> paged NDJSON projection stream (cold start)
//! ```
//!
//! Shape of the connection (SPEC §4.3):
//!
//! - **Auth at upgrade only** — cookie, `Authorization: Bearer`, or the
//!   `life-manager.bearer.<token>` subprotocol. No in-band login exists.
//! - **Origin allowlist is mandatory** and checked *before* authentication, so a
//!   hostile page learns nothing about session validity.
//! - One task per connection owns the socket. It holds: the feed cursor, the set
//!   of subscribed document ids, and two bounded send queues (feed batches,
//!   document frames). Overflow **drops and instructs a resync** — it never grows
//!   a buffer and never blocks the writer (PROTOCOL.md §6).
//! - Session revalidation every 5 minutes (jittered) → close `4401`.
//! - Rooms are the docstore's (`DocStore`); this module only subscribes and
//!   forwards. Fan-out excludes the originating socket.
//!
//! # The four tasks of one connection
//!
//! ```text
//!            ┌──────────── reader ─────────────┐
//!  socket ──▶│ rate caps, control JSON, frames │──▶ DocStore (serialized writes)
//!            └────────────┬────────────────────┘        │
//!                         │ push                        │ applied update
//!            ┌────────────▼────────────┐                ▼
//!            │  Outbox (two bounded    │◀──── per-doc broadcast (SyncHub)
//!            │  queues + ctl channel)  │◀──── feed task (catch-up + live tail)
//!            └────────────┬────────────┘◀──── revalidation / shutdown watcher
//!                         │ pop
//!                    writer task ──▶ socket
//! ```
//!
//! The [`Outbox`] is the backpressure device: producers hold its lock, push, and —
//! **when a queue is full — apply the drop policy themselves** (drain the queue,
//! enqueue the resync instruction). No producer ever awaits a slow socket, which
//! is the property PROTOCOL.md §6 is really asking for: a client that cannot keep
//! up costs bounded memory and gets told to re-derive, rather than making the
//! server buffer for it.
//!
//! # Why a process-global hub
//!
//! Fan-out between sockets needs a rendezvous, and `AppState` is a frozen
//! contract this area may not extend (`backend/CONTRACTS.md`). [`SyncHub`] is
//! therefore a process-global map keyed by **database name**, which is also what
//! makes it safe under `cargo test`: two `AppState`s in one test binary point at
//! two databases and get two hubs. SPEC §8 pins `replicas: 1`, so one process is
//! the whole fan-out domain; the v2 HA seam (Redis / change-stream fan-out)
//! replaces this type and nothing else.
//!
//! # The hooks other areas call into
//!
//! Three things reach into this module from outside, because the socket registry
//! lives here and nowhere else:
//!
//! - [`publish_update`] — a CRDT write that did **not** arrive over a socket (REST
//!   `PUT`/`PATCH`, a snapshot restore, an M4 plugin host) fans out through this.
//!   Without it the write reaches the projection feed, so doc lists and search move,
//!   while an editor with the document open keeps the old text and merges its next
//!   keystroke into it. It takes the applied diff from `WriteOutcome::update`, so no
//!   `DocStore` trait change was needed.
//! - [`close_session_sockets`] / [`close_user_sockets`] / [`close_user_sockets_except`]
//!   — the revocation hooks `auth::revoke_*` calls. A socket authenticates once, at
//!   upgrade; polling every 5 minutes is the backstop, not the mechanism
//!   (PROTOCOL.md §1.3).
//! - [`close_all_sockets`] — SPEC §8's "close sockets with `4503`", called by
//!   `main.rs` between axum's drain and the flush. The hub's own `SIGTERM` watcher
//!   is the backstop for anything that does not go through that path.
//!
//! `// INTEGRATION:` **ops** — `telemetry::init_metrics` installs the recorder
//! before setting its `OnceLock`, so two concurrent callers race and the loser
//! panics; the integration tests work around it with a lock.
//!
//! `// INTEGRATION:` **docstore** — hot rooms are evicted by *age* only
//! (`ROOM_IDLE_TIMEOUT`, 10 min), with no count cap anywhere in `docstore.rs`. This
//! module bounds how many rooms one socket can create — every CRDT frame requires a
//! subscription, and subscriptions are capped at [`MAX_SUBSCRIPTIONS`] — but the
//! process-wide room count is still only bounded by
//! `MAX_SOCKETS_TOTAL × MAX_SUBSCRIPTIONS`. A real ceiling belongs in the docstore
//! (an LRU over rooms, evicting post-flush), not here.

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

/// Protocol version — the `protocol` field of `welcome`. Bumping it is a
/// breaking change for every client (close code `4409`).
pub const PROTOCOL_VERSION: u32 = 1;

/// The subprotocol every client must offer.
pub const SUBPROTOCOL: &str = "life-manager.v1";

/// Prefix of the bearer-token subprotocol: `life-manager.bearer.<raw token>`.
/// Native shells cannot set headers on a WebSocket and have no cookies
/// (SPEC §5.2, §7). The selected-protocol response header must never echo it.
pub const BEARER_SUBPROTOCOL_PREFIX: &str = "life-manager.bearer.";

/// Hard frame ceiling, both directions (SPEC §4.3).
pub const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
/// Document subscriptions per socket (the client LRU is ~20, SPEC §4.1).
pub const MAX_SUBSCRIPTIONS: usize = 32;
/// Concurrent sockets per session (SPEC §4.3, multi-tab).
pub const MAX_SOCKETS_PER_SESSION: usize = 8;
/// Concurrent sockets per **user**, across all of that user's sessions.
///
/// `MAX_SOCKETS_PER_SESSION` alone is not a ceiling on anything: `POST
/// /api/auth/login` mints as many sessions as it is asked for, and each one is
/// worth another eight sockets. Two sessions is the honest multi-device case, eight
/// is generous; 16 sockets is well above any real use and two orders of magnitude
/// below what one scripted account could otherwise pin in RAM.
pub const MAX_SOCKETS_PER_USER: usize = 16;
/// Concurrent sync sockets this process serves at all. SPEC §8 pins
/// `replicas: 1`, so every socket's queues, feed task and room references are on
/// one heap; past this the server is protecting the workspace it already has.
pub const MAX_SOCKETS_TOTAL: usize = 512;
/// Bounded feed-batch send queue (PROTOCOL.md §6).
pub const FEED_QUEUE_MESSAGES: usize = 64;
/// Bounded per-document frame queue.
pub const DOC_QUEUE_FRAMES: usize = 256;
/// Inbound rate caps per connection.
pub const INBOUND_FRAMES_PER_SEC: u32 = 200;
pub const INBOUND_BYTES_PER_SEC: u64 = 2 * 1024 * 1024;
/// Application-level heartbeat period announced in `welcome.limits`.
pub const HEARTBEAT_SECS: u32 = 25;
/// How often the session behind a live socket is re-validated (SPEC §4.3).
pub const SESSION_REVALIDATE_SECS: u64 = 300;
/// Jitter added to the revalidation period so sockets do not stampede Mongo.
pub const SESSION_REVALIDATE_JITTER_SECS: u64 = 60;
/// Live-tail coalescing window: notifications inside it collapse into one batch.
pub const TAIL_COALESCE_MS: u64 = 50;

/// Byte ceiling on each of the two send queues (PROTOCOL.md §6).
const QUEUE_MAX_BYTES: usize = 8 * 1024 * 1024;
/// Serialized-byte budget for one `feed.batch` message.
///
/// `FEED_CATCHUP_MAX_ROWS` bounds a catch-up by *rows*, which says nothing about
/// bytes: 200 documents of 50 KB is a 10 MiB JSON string, over the frame ceiling
/// and over the queue bound that would then drop it — a permanent resync loop. A
/// batch is therefore closed as soon as it reaches this many bytes, and the rest of
/// the page follows in the next one. Well under [`MAX_FRAME_BYTES`] and an eighth
/// of [`QUEUE_MAX_BYTES`], so a slow client's queue holds several batches before
/// backpressure is the right answer.
const FEED_BATCH_MAX_BYTES: usize = 512 * 1024;
/// `feed.subscribe` rate, per connection (see `ConnectionSession::subscribes`).
const FEED_SUBSCRIBES_PER_SEC: f64 = 1.0;
const FEED_SUBSCRIBE_BURST: f64 = 5.0;
/// Concurrent bootstrap streams one user may hold open.
///
/// The endpoint reads a client-chosen page size and streams it; two passes at once
/// is already more than a client needs (one, plus a restart that has not noticed
/// the first is gone).
const BOOTSTRAP_MAX_PER_USER: usize = 2;
/// Concurrent bootstrap streams this process serves at all.
const BOOTSTRAP_MAX_TOTAL: usize = 8;
/// Ceiling on the control queue. Control messages are never dropped, so the
/// backstop is closing the connection instead (see [`Outbox::push_ctl`]).
const CTL_QUEUE_MESSAGES: usize = 1024;
/// Overflows inside [`OVERFLOW_WINDOW`] that end the connection with `4408`.
const OVERFLOW_BUDGET: usize = 10;
const OVERFLOW_WINDOW: Duration = Duration::from_secs(60);
/// WebSocket `Ping` period; two unanswered pings close the socket
/// (PROTOCOL.md §5).
const SERVER_PING_SECS: u64 = 30;
const MISSED_PINGS_BEFORE_CLOSE: u32 = 2;
/// Malformed `UPDATE`/`SYNC_STEP2` payloads tolerated before `4400`
/// (PROTOCOL.md §3.4).
const MALFORMED_UPDATE_BUDGET: u32 = 3;
/// Broadcast depth of one document's fan-out channel. A receiver that lags is
/// told to resync, so this only has to absorb a burst, not a slow client.
const DOC_BROADCAST_CAPACITY: usize = 256;
/// `floor_seq` is always 0 in M2: the feed is never truncated (PROTOCOL.md §1.4).
const FLOOR_SEQ: i64 = 0;
/// How long the close path waits for the writer to flush its last frame.
const WRITER_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Close codes (PROTOCOL.md §7). `4401` in particular means "re-authenticate" and
/// **never** "clear local data" (SPEC §5.3).
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

/// Binary frame type tags (PROTOCOL.md §3.1). The envelope is
/// `[type: u8][idLen: u8][doc id][payload]`; payloads are y-protocols' own bytes.
pub mod frame {
    pub const SYNC_STEP1: u8 = 0x01;
    pub const SYNC_STEP2: u8 = 0x02;
    pub const UPDATE: u8 = 0x03;
    pub const AWARENESS: u8 = 0x04;
    pub const AWARENESS_QUERY: u8 = 0x05;
    /// An offline edit with when it was made: 8 bytes big-endian epoch ms, then a Yjs
    /// update. Client → server, on reconnect (PROTOCOL.md §3.7).
    pub const HISTORY: u8 = 0x06;
    /// Tags from here up are reserved for M4 plugin channels.
    pub const RESERVED_FLOOR: u8 = 0x10;
}

pub fn router() -> Router<AppState> {
    Router::new()
        // `upgrade_guarded` exists only to put the `Origin` check *before* the
        // `AuthUser` extractor — see [`OriginChecked`].
        .route("/sync", get(upgrade_guarded))
        .route("/sync/bootstrap", get(bootstrap))
}

// ---------------------------------------------------------------------------
// The upgrade handler
// ---------------------------------------------------------------------------

/// The route target for `/api/sync`.
///
/// Extractors run left to right, which is the whole point of this wrapper:
/// [`OriginChecked`] rejects a refused `Origin` with **403 before** `AuthUser`
/// touches the session store. PROTOCOL.md §1.2 requires that order — with the
/// checks the other way round, an attacker's page can tell a valid session (403)
/// from an invalid one (401) and has learned something it must not.
///
/// [`upgrade`] keeps its frozen signature and remains the handler body; its own
/// origin check is then a cheap second opinion rather than the only one.
async fn upgrade_guarded(
    State(state): State<AppState>,
    headers: HeaderMap,
    _origin: OriginChecked,
    user: AuthUser,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    upgrade(State(state), headers, user, ws).await
}

/// Pre-authentication `Origin` guard (PROTOCOL.md §1.2).
///
/// The credential is only *inspected*, never validated: which carrier a request
/// uses is a header-level fact, and it is all the check needs — a cookie
/// connection with no `Origin` is exactly the shape of the CSRF this allowlist
/// exists to stop, while a bearer connection cannot be CSRF'd at all.
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

/// `GET /api/sync` — authenticate, check `Origin`, upgrade.
///
/// Everything that can fail with an HTTP status fails **before** the upgrade:
/// an upgraded-then-immediately-closed socket is much harder for a client to
/// diagnose than a 401 or a 403.
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
        // Deliberately one frame of slack above the protocol ceiling: tungstenite
        // answers a message over *its* limit by closing with `1009` itself, and
        // PROTOCOL.md §7 prescribes `4413`. With the transport limit above the
        // protocol limit, the check in `read_frame` runs first and sends the code
        // the client is documented to branch on. The transport cap is still there
        // so a hostile stream cannot be buffered without bound.
        .max_frame_size(MAX_FRAME_BYTES * 2)
        .max_message_size(MAX_FRAME_BYTES * 2)
        .protocols([SUBPROTOCOL])
        .on_upgrade(move |socket| async move { serve(state, user, socket).await }))
}

/// Origin allowlist (SPEC §4.3), evaluated before anything else touches the
/// session:
///
/// - `Origin` present → must be in `APP_ORIGIN` (`Config::origin_allowed`).
/// - `Origin` absent → allowed **only** for a bearer-authenticated connection: a
///   native shell or a script cannot be CSRF'd through a cookie it does not have,
///   while a cookie connection with no `Origin` is exactly the shape of the attack.
pub fn origin_allowed(state: &AppState, headers: &HeaderMap, via: AuthVia) -> bool {
    origin_verdict(state, headers, Some(via))
}

/// The allowlist decision, with the carrier not yet known for certain.
///
/// `via: None` means "no credential was presented at all" — nothing to CSRF, and
/// the request is about to fail authentication anyway, so it is treated like a
/// bearer connection rather than blamed for a missing `Origin`.
fn origin_verdict(state: &AppState, headers: &HeaderMap, via: Option<AuthVia>) -> bool {
    match headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        Some(origin) => {
            if state.config.origin_allowed(origin) {
                return true;
            }
            // PROTOCOL.md §1.2: with no configured allowlist, a same-origin
            // deployment still has to work — the PWA and the API are one host.
            state.config.app_origins.is_empty() && origin_matches_host(origin, headers)
        }
        None => !matches!(via, Some(AuthVia::Cookie)),
    }
}

/// `true` when `Origin`'s authority is this request's own `Host`.
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

/// `true` when the client offered [`SUBPROTOCOL`].
pub fn offers_subprotocol(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| value.trim() == SUBPROTOCOL)
}

/// The bearer-subprotocol extractor lives in [`crate::auth`] — the auth layer owns
/// "what did this request authenticate with" for every route, this one included.
/// Re-exported here so the protocol surface reads as one piece.
pub use crate::auth::bearer_from_subprotocols as bearer_token_from_subprotocols;

// ---------------------------------------------------------------------------
// The hub: fan-out, socket accounting, shutdown
// ---------------------------------------------------------------------------

/// Identifies one socket for the length of its life. Used to keep fan-out from
/// echoing an update to the connection that produced it (PROTOCOL.md §3.4).
type ConnId = u64;

/// The origin stamped on a publish that came from no socket at all — a REST write,
/// a snapshot restore, an M4 plugin host. `next_conn` starts at 1, so this can
/// never collide with a live connection and every subscriber receives the update.
const NO_CONN: ConnId = 0;

/// One document's fan-out payload. `Arc` because a 1 MiB paste is broadcast to
/// every subscriber of that document and must not be cloned per receiver.
#[derive(Debug, Clone)]
struct DocEvent {
    origin: ConnId,
    kind: u8,
    bytes: Arc<Vec<u8>>,
}

/// Process-global hubs, one per database (see the module docs).
static HUBS: LazyLock<StdMutex<HashMap<String, Arc<SyncHub>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

/// One live socket, as the hub sees it: who it belongs to, and how to close it.
///
/// The registry exists so a revocation can reach a socket *now* instead of at the
/// next 5-minute poll (PROTOCOL.md §1.3: the server closes `4401` "on any
/// revocation it learns about"), and so the socket caps can be counted per user and
/// globally rather than only per session.
struct ConnEntry {
    session_id: String,
    user_id: Id,
    outbox: Arc<Outbox>,
}

/// Live sockets' rendezvous: per-document fan-out, the socket caps, the revocation
/// hook, and the shutdown signal.
struct SyncHub {
    docs: StdMutex<HashMap<Id, broadcast::Sender<DocEvent>>>,
    sessions: StdMutex<HashMap<String, usize>>,
    /// Every live socket, so revocation and shutdown can address them.
    conns: StdMutex<HashMap<ConnId, ConnEntry>>,
    shutdown: broadcast::Sender<()>,
    shutting_down: AtomicBool,
    next_conn: AtomicU64,
    connections: AtomicUsize,
    subscriptions: AtomicUsize,
    signal_watch: AtomicBool,
    /// Bootstrap streams in flight, globally and per user (PROTOCOL.md §4).
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

    /// The hub for one `AppState`, created on first use.
    fn get(state: &AppState) -> Arc<Self> {
        let key = state.db.name().to_string();
        let mut hubs = HUBS.lock().expect("sync hub registry poisoned");
        Arc::clone(hubs.entry(key).or_insert_with(SyncHub::new))
    }

    /// Take one socket slot for this session (PROTOCOL.md §1.3).
    ///
    /// Three ceilings, all of them refusing with `4429`: per session (multi-tab,
    /// SPEC §4.3), per user (a session is free to mint, a socket is not), and per
    /// process (single replica).
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
            // Counted from the live registry rather than a second map, so it can
            // never drift from the sockets that actually exist.
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

    /// Put a socket in the registry (after its outbox exists, so it can be closed).
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

    /// Close every socket matching `predicate` with `4401` (PROTOCOL.md §1.3, §7).
    /// Returns how many were closed.
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

    /// Take a bootstrap-stream slot, or `None` when this user (or the process) is
    /// already streaming as many as it may.
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

    /// The fan-out channel for one document, created on first subscriber.
    fn doc_channel(&self, id: &str) -> broadcast::Sender<DocEvent> {
        let mut docs = self.docs.lock().expect("sync doc map poisoned");
        docs.entry(id.to_string())
            .or_insert_with(|| broadcast::channel(DOC_BROADCAST_CAPACITY).0)
            .clone()
    }

    /// Publish to every subscriber of `id`. A send error means nobody is
    /// listening any more, which is not a failure.
    fn publish(&self, id: &str, event: DocEvent) {
        let sender = {
            let docs = self.docs.lock().expect("sync doc map poisoned");
            docs.get(id).cloned()
        };
        if let Some(sender) = sender {
            let _ = sender.send(event);
        }
    }

    /// Forget channels nobody listens to. Called when a subscription ends, so the
    /// map tracks live interest rather than every document ever opened.
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

    /// Close every socket with `4503` (SPEC §8: a deploy drops all sockets).
    fn begin_shutdown(&self) {
        if !self.shutting_down.swap(true, Ordering::SeqCst) {
            let _ = self.shutdown.send(());
        }
    }

    /// Watch for `SIGTERM` once per hub.
    ///
    /// `main.rs` (ops) owns the shutdown sequence and has no hook for closing
    /// sockets, so this area listens for the same signal rather than leaving live
    /// sockets to be cut mid-frame when the process exits — an axum graceful
    /// shutdown waits for WebSocket handlers, so without this the drain would
    /// stall until the watchdog fired. `SIGINT` is deliberately **not** watched:
    /// registering a handler for it would change Ctrl-C behaviour for every test
    /// binary that links this crate. The explicit hook is
    /// [`close_all_sockets`].
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

/// One session's socket slot; released on drop so a panicking connection cannot
/// leak a slot and lock a user out of their own workspace.
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

/// One in-flight bootstrap stream; released when the response body is dropped.
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

/// Close every live sync socket with `4503`, returning how many were open.
///
/// Called from `main.rs` before the flush — the explicit form of SPEC §8's "close
/// sockets with a reconnect code". The hub's own `SIGTERM` watcher is the backstop
/// for anything that does not go through that path (tests, `SIGINT`).
pub fn close_all_sockets(state: &AppState) -> usize {
    let hub = SyncHub::get(state);
    let live = hub.connections.load(Ordering::Relaxed);
    hub.begin_shutdown();
    live
}

/// Close every socket belonging to one session with `4401` — the revocation hook
/// `auth::revoke_session` calls (PROTOCOL.md §1.3, SPEC §4.3).
///
/// Polling every 5 minutes is the backstop, not the mechanism: a stolen laptop
/// whose owner has just changed their password must not keep reading the workspace
/// (and writing to it) for another six minutes.
pub fn close_session_sockets(state: &AppState, session_id: &str) -> usize {
    let closed = SyncHub::get(state)
        .close_matching("session revoked", |entry| entry.session_id == session_id);
    if closed > 0 {
        tracing::info!(session = %session_id, sockets = closed, "sync: sockets closed after session revocation");
    }
    closed
}

/// Close every socket belonging to one user with `4401` — password change, user
/// deletion, deactivation, demotion.
pub fn close_user_sockets(state: &AppState, user_id: &str) -> usize {
    close_user_sockets_except(state, user_id, "")
}

/// As [`close_user_sockets`], but leaving one session alone: a password change keeps
/// the caller signed in (SPEC §5.1) and logs every other device out.
pub fn close_user_sockets_except(state: &AppState, user_id: &str, keep_session_id: &str) -> usize {
    let closed = SyncHub::get(state).close_matching("session revoked", |entry| {
        entry.user_id == user_id && entry.session_id != keep_session_id
    });
    if closed > 0 {
        tracing::info!(user = %user_id, sockets = closed, "sync: sockets closed after revocation");
    }
    closed
}

/// Fan a CRDT update out to every socket subscribed to `id`.
///
/// The hook for writers that are **not** a socket: `PUT`/`PATCH
/// /api/documents/:id`, a snapshot restore, and (M4) a plugin host. Without it the
/// write reaches the projection feed — so doc lists and search update — while an
/// editor that has the document open never sees the diff and silently diverges
/// from the server for the life of its subscription (PROTOCOL.md §3.4: applied
/// updates are fanned out to every other subscriber).
///
/// `update` is the applied diff from [`crate::docstore::WriteOutcome::update`], so
/// it is already normalized by the docstore and excludes anything the server
/// already had. An empty update is a no-op write and is not published.
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

/// Relay a backend plugin's `emit_client` event to connected browsers (SPEC §6.3).
///
/// **Added by the M4 scaffold; implemented by the `hooks-cron` builder.** It belongs here
/// rather than in the plugin host because `ConnEntry` — the only place a user id meets an
/// outbox — is private to this module, and growing `AppState` to expose it would break a
/// frozen contract for one function.
///
/// The frame is a JSON message the client kernel already tolerates:
///
/// ```json
/// { "t": "plugin.event", "plugin": "calendar", "event": "synced",
///   "payload": { … }, "at": "2026-09-24T06:00:01Z" }
/// ```
///
/// PROTOCOL.md §9 says a client **ignores unknown `t` values** (that clause exists for
/// exactly this), so this is additive: an M2/M3 client drops it, an M4 client turns it into
/// `kernel.events` type `plugin:<id>:<event>` with origin
/// `{ kind: "server", plugin: "<id>" }`.
///
/// `user_id` targets one user's sessions; `None` reaches every connected session. Returns
/// how many sockets it was **queued** on — not a delivery guarantee: an overflowing outbox
/// drops it, because a plugin event is ephemeral with no replay (SPEC §6.3) and buffering
/// it would trade a lost nudge for a lost document update.
pub fn publish_plugin_event(
    state: &AppState,
    plugin_id: &str,
    event: &str,
    payload: &serde_json::Value,
    user_id: Option<&str>,
) -> usize {
    /// Headroom a plugin event needs in the control queue before it is enqueued.
    ///
    /// Plugin events go on the control queue — they are small JSON messages with no
    /// document or feed semantics — but they must **not** inherit its "never dropped,
    /// close the socket on overflow" policy: a chatty plugin would then be able to
    /// disconnect every browser in the workspace. So the enqueue is conditional on the
    /// queue being well short of [`CTL_QUEUE_MESSAGES`], and past that the event is
    /// dropped. That is exactly what SPEC §6.3 asks for — ephemeral, no replay — and the
    /// reserve keeps the space a `feed.resync` or a close frame needs.
    const PLUGIN_EVENT_HEADROOM: usize = CTL_QUEUE_MESSAGES / 2;

    // Serialized once, not once per socket: a workspace-wide event on 200 sockets costs one
    // `to_string` and 200 string clones, rather than 200 serializations of the same value.
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
            // A payload the host could not re-serialize is a host bug, not a socket
            // problem: no connection is penalised for it.
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
            // No `user_id` reaches every connected session: this is a shared workspace
            // (SPEC §2), so "everyone" is a normal audience rather than a broadcast leak.
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

/// Tell every connected session the plugin load set changed (`@kernel` 3.0: an install,
/// upgrade, uninstall, approval, enable or disable). Clients answer with a reload.
///
/// ```json
/// { "t": "plugins.changed", "version": "3f9c0a1b2d4e5f60" }
/// ```
///
/// `version` is [`crate::plugins::Registry::plugins_version`], the same string `welcome`
/// carries as `plugins_version`.
///
/// On the control queue with the same headroom rule as [`publish_plugin_event`], and for the
/// same reason: a socket that is not keeping up must not be closed over it. Nothing is lost
/// by a drop — `welcome.plugins_version` carries the live version on every reconnect, and a
/// client compares it with what it booted with. Returns how many sockets it was queued on.
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

/// How many sockets currently subscribe to `id`.
///
/// Used by the snapshot-restore route to warn that other users are editing the
/// document it is about to rewrite (SPEC §3.5).
pub fn document_subscribers(state: &AppState, id: &str) -> usize {
    let hub = SyncHub::get(state);
    let docs = hub.docs.lock().expect("sync doc map poisoned");
    docs.get(id).map_or(0, broadcast::Sender::receiver_count)
}

// ---------------------------------------------------------------------------
// The outbox: two bounded queues and the drop-and-instruct policy
// ---------------------------------------------------------------------------

/// A queued feed batch, with the watermark it carries — needed because a
/// `feed.resync` has to name the last watermark that actually *reached* the
/// client, not the newest one the server knows.
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
    /// Control messages: `welcome`, `pong`, `doc.subscribed`, `doc.error`,
    /// `feed.reset`, and both resync instructions. Never dropped — dropping the
    /// message that says "re-derive" is how a client gets stuck.
    ctl: VecDeque<Message>,
    feed: VecDeque<FeedItem>,
    feed_bytes: usize,
    docs: VecDeque<DocItem>,
    doc_bytes: usize,
    /// Round-robin flag so a busy document cannot starve the feed, or vice versa.
    prefer_feed: bool,
    /// Watermark of the newest feed batch handed to the socket.
    flushed_safe_seq: i64,
    overflows: VecDeque<Instant>,
    closing: Option<(u16, String)>,
    finished: bool,
}

/// The per-connection send side. Producers push; the writer task pops.
struct Outbox {
    inner: StdMutex<OutboxState>,
    /// Woken on every push and on close.
    wake: Notify,
    /// Woken only when a close is requested, so the reader can stop too.
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

    /// Enqueue a control message. These are never *dropped* — dropping the message
    /// that says "re-derive" is how a client gets stuck — but they are not
    /// unbounded either: a peer that stops reading while still sending (pings,
    /// resubscribes) would otherwise grow this queue forever at the inbound rate
    /// cap. Past the bound the connection is simply not keeping up, which is what
    /// `4408` says (PROTOCOL.md §6).
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

    /// Serialize and enqueue a control message. A serialization failure is a bug
    /// in this module, never a client's fault, so it is logged and dropped rather
    /// than escalated to the socket.
    fn push_json(&self, value: &serde_json::Value) {
        match serde_json::to_string(value) {
            Ok(json) => self.push_ctl(Message::text(json)),
            Err(err) => tracing::error!(error = %err, "sync: cannot serialize control message"),
        }
    }

    /// Enqueue a feed batch. On overflow: drop **all** queued batches and tell the
    /// client to resubscribe from the last watermark it actually received
    /// (PROTOCOL.md §6). Dropping is safe because a resubscribe re-reads the rows
    /// from Mongo — it is a re-derivation, not a replay.
    ///
    /// Returns `false` when the batch was **not** queued (overflow, or the socket is
    /// closing). The caller — [`feed_loop`] — must then stop producing: its cursor
    /// has already advanced past the rows that were just dropped, so one more batch
    /// from it would hand the client a watermark above rows it never received, and
    /// the client persists watermarks monotonically. The resubscribe the client is
    /// about to send starts a fresh loop from the watermark that really was flushed.
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

    /// Enqueue one document frame. On overflow: drop the queued frames **for that
    /// document** and instruct a state-vector resync for it. Other documents on
    /// the same socket are untouched — one busy document must not cost the user
    /// their other editors.
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

    /// Forget queued frames for a document the client no longer wants
    /// (PROTOCOL.md §3.3: "drops any queued frames for that id").
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

    /// The reader has stopped: let the writer drain and exit.
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

    /// Next message for the socket, in priority order: control, then feed and
    /// document frames round-robin.
    fn pop(&self) -> Option<Message> {
        let mut state = self.lock();
        if let Some(message) = state.ctl.pop_front() {
            return Some(message);
        }
        if state.closing.is_some() {
            // Queued data is irrelevant once the socket is closing.
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

    /// Record an overflow and report whether the connection has used up its
    /// budget (PROTOCOL.md §6: more than 10 in 60 s ⇒ `4408`).
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

// ---------------------------------------------------------------------------
// Inbound rate limiting
// ---------------------------------------------------------------------------

/// Token bucket, per connection (PROTOCOL.md §6: 200 frames/s and 2 MiB/s
/// sustained, burst 2×).
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

// ---------------------------------------------------------------------------
// Client → server messages
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

/// Everything one connection's tasks share.
struct Connection {
    state: AppState,
    hub: Arc<SyncHub>,
    outbox: Arc<Outbox>,
    conn_id: ConnId,
    user_id: Id,
    session_id: String,
    /// Any inbound traffic proves liveness for the ping watchdog.
    inbound_seen: Arc<AtomicBool>,
}

/// Serve one connection for its whole lifetime.
///
/// The implementation owns: the `welcome` handshake, the feed subscription and its
/// live tail, document subscriptions and y-protocol relay, awareness relay,
/// heartbeats, rate limiting, backpressure, session revalidation, and the close
/// path. See PROTOCOL.md §§1–7.
async fn serve(state: AppState, user: AuthUser, socket: WebSocket) {
    let hub = SyncHub::get(&state);
    hub.watch_signals();

    let (mut sink, mut stream) = socket.split();

    // PROTOCOL.md §1.3: the 9th socket for a session is closed right after the
    // handshake, before any `welcome`, so the client can tell "another tab owns
    // the socket" from every other failure.
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

    // Registered before the first frame is served, so a revocation that lands
    // during the handshake still reaches this socket (PROTOCOL.md §1.3).
    hub.register(
        conn_id,
        ConnEntry {
            session_id: conn.session_id.clone(),
            user_id: conn.user_id.clone(),
            outbox: Arc::clone(&outbox),
        },
    );

    // `welcome` is queued before the writer starts, so it is physically the first
    // frame on the socket (PROTOCOL.md §1.4).
    outbox.push_json(&welcome(&state, &user));

    let writer = tokio::spawn(writer_loop(sink, Arc::clone(&outbox), inbound_seen));
    let revalidator = tokio::spawn(revalidate_loop(Arc::clone(&conn)));
    // Subscribe first, then re-read the flag: a broadcast receiver created after
    // the signal was sent would never see it, and a socket accepted during the
    // drain would hang until its peer gave up instead of getting `4503`.
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
    // Bounded: the writer is awaiting a `send` into a socket whose peer may never
    // read again, and an unbounded wait here would hold the connection — and
    // therefore axum's graceful shutdown (SPEC §8: exit ≤ 30 s) — open forever.
    if tokio::time::timeout(WRITER_DRAIN_TIMEOUT, writer)
        .await
        .is_err()
    {
        tracing::debug!(conn_id, "sync: writer did not drain; dropping the socket");
    }
    drop(slot);
    tracing::debug!(conn_id, "sync socket closed");
}

/// The `welcome` frame (PROTOCOL.md §1.4).
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
        "core_semantics_version": life_manager_core::CORE_SEMANTICS_VERSION,
        // A client that was offline while the plugin set changed compares this with the
        // version it booted with, exactly as if `plugins.changed` had reached it.
        "plugins_version": crate::plugins::registry(&state.config).plugins_version(),
    })
}

/// Per-connection mutable state that only the reader task touches.
struct ConnectionSession {
    conn: Arc<Connection>,
    feed_task: Option<tokio::task::JoinHandle<()>>,
    doc_tasks: HashMap<Id, tokio::task::JoinHandle<()>>,
    subscribed: HashSet<Id>,
    frames: RateBucket,
    bytes: RateBucket,
    /// `feed.subscribe` is one cheap frame that costs the server two workspace-wide
    /// `count_documents` calls plus a fresh catch-up read, so it gets its own
    /// bucket: sustained 1/s with a burst of 5. A real client subscribes once per
    /// connection and again on each `feed.resync`.
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
        // A separate handle, so the `Notified` future below borrows this local
        // rather than `self` — the message handlers need `&mut self`.
        let outbox = Arc::clone(&self.conn.outbox);
        loop {
            // The waiter is registered *before* the flag is read, which is what
            // closes the lost-wakeup race: a `request_close` from the revalidator
            // or the shutdown watcher either wakes this registered future or is
            // already visible in `is_closing`.
            let closing = outbox.closing.notified();
            tokio::pin!(closing);
            if outbox.is_closing() {
                break;
            }

            let message = tokio::select! {
                message = stream.next() => message,
                // A close requested elsewhere: stop reading so the writer can send
                // the close frame and exit.
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
                // tungstenite answers inbound pings itself; a pong is liveness,
                // already recorded above.
                Message::Ping(_) | Message::Pong(_) => {}
            }

            if self.conn.outbox.is_closing() {
                break;
            }
        }
    }

    /// Returns `false` when the connection must stop.
    async fn handle_control(&mut self, text: &str) -> bool {
        let message: ClientMessage = match serde_json::from_str(text) {
            Ok(message) => message,
            Err(err) => {
                // PROTOCOL.md §9: an unknown `t` (or unparseable JSON) is a version
                // skew, and silently dropping a client's writes is worse than a
                // reconnect.
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
                // PROTOCOL.md §6: "control-message floods count the same as data".
                // This one is the amplifier — two full-range index counts and a
                // catch-up read for a 60-byte frame that the byte bucket never
                // notices — so it has its own bucket.
                if !self.subscribes.allow(1.0) {
                    self.conn
                        .outbox
                        .request_close(close::FLOOD, "feed.subscribe rate cap exceeded");
                    return false;
                }
                // A second subscribe replaces the first (PROTOCOL.md §2.3).
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

    /// Returns `false` when the connection must stop.
    async fn handle_binary(&mut self, bytes: &[u8]) -> bool {
        let Some(parsed) = parse_frame(bytes) else {
            self.conn
                .outbox
                .request_close(close::PROTOCOL_ERROR, "malformed binary envelope");
            return false;
        };

        if parsed.kind >= frame::RESERVED_FLOOR {
            // Reserved for M4 plugin channels; ignored, never fatal.
            return true;
        }

        // Every CRDT and awareness frame requires a live subscription for that
        // document on *this* socket (PROTOCOL.md §3.3, §3.4).
        //
        // Not a formality: `SYNC_STEP1` reaches `DocStore::diff` and
        // `SYNC_STEP2`/`UPDATE` reach `apply_update`, and both load the document
        // into the process-wide hot-room registry, where it stays for
        // `ROOM_IDLE_TIMEOUT` (10 min) after the socket closes. Ungated, one
        // authenticated client could pin an entire 5 000-document workspace in RAM
        // with 28-byte frames inside the inbound rate cap — while never issuing the
        // `doc.subscribe` that `MAX_SUBSCRIPTIONS` exists to bound. Frames are
        // dropped rather than closing the socket: the honest reason for one is a
        // `doc.unsubscribe` crossing an in-flight update, and that must not cost the
        // user their other documents.
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
            // The catch-up diff of a handshake carries whatever the client made while
            // disconnected: offline edits, stamped when they arrive.
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
                // Opaque relay (SPEC §3.2): never parsed, never stored, never
                // replayed to late joiners.
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
            // Re-subscribing restarts the handshake (PROTOCOL.md §3.3).
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

        // `get_stale` on purpose: subscribing must not force a materialization
        // flush (SPEC §3.5). The CRDT state below is the authority; the
        // materialized fields are only the metadata in `doc.subscribed`.
        //
        // The graveyard is consulted only when the row is absent — that is the one
        // case where `gone` and `not_found` differ, and it keeps the common path to
        // one read instead of two.
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

        // Register for fan-out *before* answering, so an update applied between
        // the state vector below and the client's first frame is not missed.
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

    /// Answer a client state vector with everything it lacks (PROTOCOL.md §3.3).
    async fn send_step2(&mut self, id: &str, state_vector: &[u8]) {
        match self.conn.state.docs.diff(id, state_vector).await {
            Ok(diff) if diff.is_empty() => {}
            Ok(diff) => {
                let payload = encode_frame(frame::SYNC_STEP2, id, &diff);
                if payload.len() > MAX_FRAME_BYTES {
                    // PROTOCOL.md §3.5: REST has no frame limit, so that is where
                    // an oversize hydration goes. The hint is what distinguishes
                    // this from a write refused for size.
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

    /// Apply an inbound update through the docstore and fan it out.
    ///
    /// Returns `false` when the socket must close.
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
                    // Fan-out carries the *applied* diff, not the client's bytes:
                    // it is normalized and excludes anything the server already
                    // had, and the originator is skipped by `relay_loop`.
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

    /// A `doc.error` carrying the `hint` a client branches on (PROTOCOL.md §3.5).
    ///
    /// `too_large` has two causes that want opposite responses: a *diff* that does
    /// not fit in a frame (hydrate over REST — `hint: "rest"`), and a *write* whose
    /// result would exceed `MAX_DOCUMENT_BYTES` (nothing to hydrate; the edit was
    /// refused). Only the first carries the hint, so the client can tell them apart.
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

    /// Stop every task this connection owns and release its subscriptions.
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

/// Forward one document's fan-out to this socket, skipping what it sent itself.
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
            // Lagged: frames were skipped, and a skipped CRDT update is exactly
            // what a state-vector resync repairs (PROTOCOL.md §6).
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

/// The feed subscription: catch-up, then the live tail (PROTOCOL.md §2).
async fn feed_loop(conn: Arc<Connection>, since_seq: i64, include_content: bool, batch_rows: u32) {
    let feed = Arc::clone(&conn.state.feed);
    // Subscribe *before* the first read: a notice that arrives during catch-up
    // must not be lost between the last page and the live tail.
    let mut notices = feed.subscribe();

    // `head - since` is an upper bound on how many rows can be waiting (one row per
    // sequence number), so a client that is demonstrably inside the catch-up budget
    // never pays for the count at all. The count is only needed to tell "far behind
    // in numbers" from "far behind in rows" — a document edited a thousand times
    // still has exactly one row.
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
                // The database was restored from a backup and this client is from
                // the future (SPEC §8 split-brain note).
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
                        // A dropped batch means this loop's cursor is already past
                        // rows the client will not receive; the resubscribe it was
                        // just told to send starts a fresh loop from the watermark
                        // that really was flushed (PROTOCOL.md §6).
                        if !conn.outbox.push_feed(batch.json, batch.safe_seq) {
                            tracing::debug!("sync: feed producer stopping after a dropped batch");
                            return;
                        }
                    }
                }
                Err(oversize) => {
                    // One row alone does not fit in a frame. Bootstrap streams the
                    // same row over NDJSON, which has no frame limit — the same
                    // escape hatch §3.5 uses for an oversize document diff.
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
            // More history waiting: next page immediately.
            continue;
        }

        // Caught up to the watermark. If `head > cursor` a write is mid-flight
        // below the head, and its notice has already been consumed (or was never
        // sent, because the allocation is still open) — poll briefly instead of
        // waiting for an event that may not come.
        if feed.head_seq() > cursor {
            tokio::time::sleep(Duration::from_millis(TAIL_COALESCE_MS)).await;
            continue;
        }

        match notices.recv().await {
            Ok(_) => {}
            // Lagged notices cost nothing: the next read is from the cursor.
            Err(broadcast::error::RecvError::Lagged(_)) => {}
            Err(broadcast::error::RecvError::Closed) => return,
        }
        // Coalesce the burst (PROTOCOL.md §2.4) — one batch per ~50 ms, and one
        // row per document in it, because `documents` holds exactly one row per id.
        tokio::time::sleep(Duration::from_millis(TAIL_COALESCE_MS)).await;
        while notices.try_recv().is_ok() {}
    }
}

/// One serialized `feed.batch`, with the watermark it carries.
#[derive(Debug)]
struct FeedBatchJson {
    json: String,
    safe_seq: i64,
}

/// A single row whose serialized form cannot be put on the wire at all.
#[derive(Debug)]
struct OversizeRow {
    id: Id,
    bytes: usize,
}

/// Split one [`crate::feed::FeedPage`] into `feed.batch` messages that each fit
/// [`FEED_BATCH_MAX_BYTES`] (PROTOCOL.md §2.4, §6).
///
/// Row count is not a size bound. `FEED_CATCHUP_MAX_ROWS` allows 500 rows and a row
/// carries the whole document text (up to `MAX_DOCUMENT_BYTES`), so one page can
/// serialize to hundreds of megabytes — a string built in full before the queue's
/// 8 MiB bound is even consulted, then dropped, then rebuilt identically by the
/// resubscribe the drop instructs. That loop never terminates. Splitting by bytes
/// is what makes the queue bound the backpressure device it is documented to be.
///
/// The watermark of a partial batch is its **last row's** `seq`: the page is
/// gapless and ascending, so a prefix ending at `seq` really has delivered
/// everything at or below `seq`. Only the final batch carries the page's own
/// watermark and the `complete` flag.
fn split_batches(
    page: &crate::feed::FeedPage,
    mode: &str,
    complete: bool,
) -> Result<Vec<FeedBatchJson>, OversizeRow> {
    /// Envelope overhead of `{"t":"feed.batch",…}` around the rows, generously.
    const ENVELOPE_BYTES: usize = 256;

    let mut rows: Vec<(i64, String)> = Vec::with_capacity(page.rows.len());
    for row in &page.rows {
        let json = serde_json::to_string(row).unwrap_or_else(|err| {
            // `FeedRow` is plain data; a failure here is a bug in this crate, and an
            // empty object keeps the batch parseable while the log names it.
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
        // `+ 1` for the comma that joins it to the previous row.
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

/// Assemble a `feed.batch` from already-serialized rows.
///
/// String concatenation rather than `serde_json::json!`: the rows were serialized
/// once to measure them, and re-serializing the whole batch would double both the
/// CPU and the peak allocation this split exists to avoid.
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

/// Write queued messages to the socket, and keep the WebSocket-level heartbeat.
async fn writer_loop(
    mut sink: futures::stream::SplitSink<WebSocket, Message>,
    outbox: Arc<Outbox>,
    inbound_seen: Arc<AtomicBool>,
) {
    let mut ping = tokio::time::interval(Duration::from_secs(SERVER_PING_SECS));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // The first tick is immediate; a ping before the first `welcome` is pointless.
    ping.tick().await;
    let mut missed_pings = 0u32;

    loop {
        // Drain everything queued right now. `Notify` stores one permit, so a push
        // that lands during this drain still wakes the next wait.
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

/// Re-validate the session behind a live socket every 5 min ± jitter
/// (SPEC §4.3). Expired, revoked, or a deactivated user ⇒ close `4401`.
async fn revalidate_loop(conn: Arc<Connection>) {
    loop {
        tokio::time::sleep(revalidate_delay()).await;
        match session_still_valid(&conn).await {
            Ok(true) => {}
            Ok(false) => {
                // `4401` means *re-authenticate* and nothing else — the client
                // keeps its local data (SPEC §5.3).
                conn.outbox
                    .request_close(close::UNAUTHENTICATED, "session is no longer valid");
                return;
            }
            // A Mongo hiccup must not log every open socket out.
            Err(err) => tracing::warn!(error = %err, "sync: session revalidation failed"),
        }
    }
}

/// The revalidation period with jitter, so 10 000 sockets do not hit Mongo in the
/// same tick (PROTOCOL.md §1.3).
fn revalidate_delay() -> Duration {
    let jitter: u64 = rand::random_range(0..=SESSION_REVALIDATE_JITTER_SECS);
    Duration::from_secs(SESSION_REVALIDATE_SECS + jitter)
}

/// Is the session still usable?
///
/// Read-only on purpose: the raw token is never kept in memory after the upgrade
/// (only its hash, which is the session `_id`), so this checks the stored row and
/// the account rather than re-running `auth::load_session`.
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

/// Close this socket with `4503` when the process starts shutting down
/// (SPEC §8: a deploy drops every socket; clients reconnect quickly with jitter).
async fn shutdown_loop(conn: Arc<Connection>, mut shutdown: broadcast::Receiver<()>) {
    let _ = shutdown.recv().await;
    conn.outbox
        .request_close(close::SHUTTING_DOWN, "server shutting down");
}

// ---------------------------------------------------------------------------
// Binary framing (PROTOCOL.md §3.1)
// ---------------------------------------------------------------------------

/// A parsed binary frame: `[type][idLen][id][payload]`.
struct ParsedFrame<'a> {
    kind: u8,
    id: Id,
    payload: &'a [u8],
}

/// Parse the envelope. `None` ⇒ protocol error (close `4400`).
fn parse_frame(bytes: &[u8]) -> Option<ParsedFrame<'_>> {
    let (&kind, rest) = bytes.split_first()?;
    let (&id_len, rest) = rest.split_first()?;
    if id_len == 0 || rest.len() < id_len as usize {
        return None;
    }
    let (id, payload) = rest.split_at(id_len as usize);
    let id = std::str::from_utf8(id).ok()?;
    // Unknown-but-reserved types still have to parse, so the id is validated for
    // every type: PROTOCOL.md §3.1 calls a non-ULID id a protocol error.
    if !is_valid_id(id) {
        return None;
    }
    Some(ParsedFrame {
        kind,
        id: id.to_string(),
        payload,
    })
}

/// Build a binary frame for the wire.
fn encode_frame(kind: u8, id: &str, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(2 + id.len() + payload.len());
    frame.push(kind);
    frame.push(id.len() as u8);
    frame.extend_from_slice(id.as_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// Decode a base64 state vector from `doc.subscribe` (standard alphabet, padded).
fn decode_state_vector(encoded: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/// A query-string flag.
///
/// `?probe=1` is the documented spelling (PROTOCOL.md §4) and
/// `include_content=false` is the other one, so the parameter has to accept both
/// `1`/`0` and `true`/`false`. `serde_urlencoded` hands every value over as a
/// string and its `bool` path only accepts `true`/`false`, which would answer the
/// documented URL with a 400.
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

/// Query parameters of `GET /api/sync/bootstrap` (PROTOCOL.md §4).
#[derive(Debug, Clone, Deserialize)]
pub struct BootstrapParams {
    /// Last `_id` of the previous page.
    #[serde(default)]
    pub cursor: Option<String>,
    /// Rows per page, 1..=[`BOOTSTRAP_MAX_LIMIT`].
    #[serde(default)]
    pub limit: Option<u32>,
    /// `live` | `trashed` | `all`. Default **`all`** — the client's Trash view
    /// has to work offline (SPEC §6.5).
    #[serde(default)]
    pub trash: Option<String>,
    /// `false` omits `content` (metadata-only clients).
    #[serde(default)]
    pub include_content: Option<Flag>,
    /// `probe=1` returns the header line only: "how far behind am I?".
    #[serde(default)]
    pub probe: Option<Flag>,
}

impl BootstrapParams {
    /// Clamp `limit` into range.
    pub fn page_limit(&self) -> u32 {
        self.limit
            .unwrap_or(BOOTSTRAP_DEFAULT_LIMIT)
            .clamp(1, BOOTSTRAP_MAX_LIMIT)
    }

    /// Which rows the pass covers. Default `all`.
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

/// An opaque bootstrap cursor: where the last page stopped, plus the `safe_seq`
/// the pass is pinned to.
///
/// PROTOCOL.md §4 requires `safe_seq` "captured on the first page and echoed
/// unchanged on every page", and a stateless paged endpoint has exactly one place
/// to keep that: the token the client hands back. The client treats
/// `next_cursor` as opaque and copies it verbatim, so carrying a second component
/// costs it nothing.
///
/// Wire form `"<ulid>.<safe_seq>[.<total>]"`. A bare ULID is still accepted — it is
/// what a client hand-writing a cursor (or one written against the pre-pin server)
/// sends, and it simply means "no pin, use the current watermark". ULIDs are
/// Crockford base32, so `.` cannot occur inside one and the split is unambiguous.
///
/// `total` rides along for the same reason `safe_seq` does, plus one of its own: it
/// is the progress screen's denominator, so it should not wobble between pages —
/// and computing it per page means a full `count_documents` over `documents` on
/// every request of the pass.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct BootstrapCursor<'a> {
    /// Page after this `_id`; `None` on the first page.
    after_id: Option<&'a str>,
    /// The pass's pinned watermark, when the cursor carries one.
    pinned_safe_seq: Option<i64>,
    /// The pass's pinned row total, when the cursor carries one.
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
        // A pin that will not parse is dropped rather than rejected: the fallback
        // (re-read the value) is the old behaviour, which is conservative in the
        // same direction the client is.
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

/// The first NDJSON line of a bootstrap response.
#[derive(Debug, Clone, Serialize)]
pub struct BootstrapHeader {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub protocol: u32,
    /// The watermark this pass is pinned to: the client resumes the feed here.
    pub safe_seq: i64,
    pub total: u64,
    pub limit: u32,
    pub cursor: Option<String>,
    pub core_semantics_version: u32,
}

/// The last NDJSON line of a bootstrap response.
#[derive(Debug, Clone, Serialize)]
pub struct BootstrapFooter {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub count: usize,
    pub next_cursor: Option<String>,
    pub complete: bool,
    pub safe_seq: i64,
}

/// `GET /api/sync/bootstrap` — one page of the projection as NDJSON
/// (`header`, then `row`s, then `footer`).
///
/// Streamed, never buffered: 5 000 rows of up to 1 MiB each is not a `Vec` you
/// build in memory (SPEC §4.1 target: 5 000 docs < 30 s on LAN).
///
/// One **page** per request, as PROTOCOL.md §4's `next_cursor` / `complete` pair
/// implies; the rows of that page are serialized one at a time into the response
/// stream, so the whole page is never resident as JSON.
///
/// **`safe_seq` is pinned for the whole pass, not re-read per page.** HTTP
/// requests are independent, so the pin travels in the cursor (see
/// [`BootstrapCursor`]) — the one token the client already copies from one page's
/// `next_cursor` into the next page's request.
///
/// Re-reading the watermark per page would make the header's value *grow* during
/// a pass. PROTOCOL.md §4 tells the client to keep the first page's value, which
/// papers over it — until the client exercises the other thing §4 permits:
/// "cancel mid-stream and restart from the last `next_cursor`". That restart's
/// first page would report a *newer* watermark, the client would adopt it, and
/// every document that changed between the original start and the restart would
/// be silently missing — rows the feed would never re-deliver because the client
/// asked to resume past them. Pinning server-side removes the hole instead of
/// documenting an obligation a client can forget.
pub async fn bootstrap(
    State(state): State<AppState>,
    user: AuthUser,
    Query(params): Query<BootstrapParams>,
) -> AppResult<Response> {
    let trash = params.trash_filter()?;
    let limit = params.page_limit();
    let include_content = params.wants_content();
    let feed = Arc::clone(&state.feed);

    // One page is a `limit`-row read the caller chooses the size of, so the endpoint
    // needs a ceiling on how many of them one account can have in flight. Without
    // it, ten parallel `limit=1000&include_content=true` requests are ten
    // simultaneous reads of the whole workspace on a single-replica server (SPEC §8).
    let slot =
        SyncHub::get(&state)
            .acquire_bootstrap(user.id())
            .ok_or(AppError::TooManyRequests {
                retry_after_secs: 2,
            })?;

    // Pinned before the rows are read: a document that changes *during* the pass
    // is re-delivered by the feed, and a duplicate row is harmless (LWW by `seq`)
    // where a missing one would not be.
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
        core_semantics_version: life_manager_core::CORE_SEMANTICS_VERSION,
    };

    // PROTOCOL.md §4: a probe is "a single header line only". A footer on a
    // zero-row response would be harmless to parse but it would make the probe
    // response two lines when the document says one, and a client entitled to
    // read exactly one line would then leave a line in its buffer.
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

/// Everything one bootstrap response streams from.
struct NdjsonPage {
    header: BootstrapHeader,
    /// `None` for a probe: the header is the whole response.
    rows: Option<mongodb::Cursor<crate::domain::DocumentRow>>,
    limit: u32,
    include_content: bool,
    safe_seq: i64,
    total: u64,
    /// Released when the response body is dropped, however it ends — a completed
    /// page, a client that hung up mid-stream, or a Mongo error. Never read; the
    /// `Drop` impl is the whole point.
    #[allow(dead_code)]
    slot: BootstrapSlot,
}

/// The NDJSON lines of one bootstrap page, pulled **one row at a time** from the
/// Mongo cursor.
///
/// Nothing here holds more than a single row. That is not a micro-optimization:
/// `limit` is client-chosen up to 1 000 and a row carries the document text (up to
/// `MAX_DOCUMENT_BYTES`), so collecting a page first is a gigabyte of resident
/// memory per request on a server SPEC §8 pins to one replica — which is exactly
/// what PROTOCOL.md §4's "streamed" is there to prevent.
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
        /// Rows *read* from the cursor; `limit` bounds this, not the emitted count,
        /// so a row with no `feed_seq` still advances the page (and the cursor).
        read: u32,
        emitted: usize,
        /// `_id` of the last row read — the next page's cursor.
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
                            // The cursor was opened with `limit + 1` rows: one more
                            // waiting means a next page exists, and the `_id` that
                            // page resumes after is the last one *this* page read.
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
                                    // Pre-feed row awaiting the backfill migration:
                                    // skipped, but it still counts as read.
                                    continue;
                                };
                                state.emitted += 1;
                                // Rows are tagged in the stream but not in `FeedRow`
                                // itself (the socket carries the same shape
                                // untagged), so the discriminator is added here.
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
                    // The `BootstrapSlot` inside the state is released here, when the
                    // body is dropped — including when a client hangs up mid-stream.
                    Stage::Done => return None,
                }
            }
        },
    )
}

/// A Mongo failure part-way through a streamed body: the response has already
/// started, so the only honest signal left is an aborted stream.
fn mongo_io_error(err: &mongodb::error::Error) -> std::io::Error {
    tracing::warn!(error = %err, "sync: bootstrap stream failed mid-page");
    std::io::Error::other(format!("bootstrap read failed: {err}"))
}

/// One NDJSON line. A serialization failure becomes an error line rather than a
/// truncated stream, so a client sees something it can report.
fn ndjson_line<T: Serialize>(value: &T) -> Result<Vec<u8>, std::io::Error> {
    let mut line = serde_json::to_vec(value)
        .map_err(|err| std::io::Error::other(format!("ndjson serialization failed: {err}")))?;
    line.push(b'\n');
    Ok(line)
}

/// The NDJSON content type, and the header that keeps a proxy from sniffing it.
pub const NDJSON_CONTENT_TYPE: &str = "application/x-ndjson";

/// Response headers every bootstrap page carries.
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

/// Map a feed error to the HTTP envelope. `SeqAhead` is the restored-from-backup
/// case (SPEC §8): the client must bootstrap, not retry.
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

/// A `HISTORY` payload: when the edit was made (8 bytes, big-endian epoch ms), then the
/// update. `None` when it is too short to hold the time.
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
        // First page: no cursor, so no pin — the caller reads the live watermark.
        let first = BootstrapCursor::parse(None);
        assert_eq!(first.after_id, None);
        assert_eq!(first.pinned_safe_seq, None);
        assert_eq!(first.pinned_total, None);
        assert_eq!(BootstrapCursor::parse(Some("  ")), first);

        // What the server hands out, and what comes back unchanged.
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

        // A bare ULID stays a valid cursor: hand-written, or from before the pin
        // existed. No pin means "re-read the watermark", the old behaviour.
        let bare = BootstrapCursor::parse(Some(ID));
        assert_eq!(bare.after_id, Some(ID));
        assert_eq!(bare.pinned_safe_seq, None);
        assert_eq!(bare.pinned_total, None);

        // A two-component cursor from the previous server version still works: the
        // watermark pin is honoured and only the total is re-counted.
        let legacy = format!("{ID}.48213");
        let two = BootstrapCursor::parse(Some(&legacy));
        assert_eq!(two.pinned_safe_seq, Some(48_213));
        assert_eq!(two.pinned_total, None);

        // Garbage in the pin is ignored, not fatal: paging still works, and the
        // fallback errs in the same direction the client does.
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
        let map = headers(&[(
            "sec-websocket-protocol",
            "life-manager.v1, life-manager.bearer.abc",
        )]);
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
        let map = headers(&[("sec-websocket-protocol", "life-manager.bearer.")]);
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
        // Through axum's own extractor, so the test exercises the deserializer the
        // route actually uses (`serde_urlencoded`, which hands values over as
        // strings — that is why `Flag` exists).
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
        // idLen 0 is illegal (PROTOCOL.md §3.1).
        assert!(parse_frame(&[frame::UPDATE, 0]).is_none());
        // idLen runs past the end.
        assert!(parse_frame(&[frame::UPDATE, 26, b'x']).is_none());
        // Not a ULID.
        let mut bad = vec![frame::UPDATE, 26];
        bad.extend_from_slice(&[b'!'; 26]);
        assert!(parse_frame(&bad).is_none());
    }

    #[test]
    fn feed_overflow_drops_the_queue_and_instructs_a_resync() {
        let outbox = Outbox::new(0);
        // Fill the queue; each batch reports a watermark.
        for seq in 1..=FEED_QUEUE_MESSAGES as i64 {
            assert!(outbox.push_feed(format!("{{\"seq\":{seq}}}"), seq));
        }
        assert_eq!(outbox.lock().feed.len(), FEED_QUEUE_MESSAGES);
        // One more overflows: every queued batch goes, and a resync is queued from
        // the last watermark actually flushed (nothing yet → 0). The `false` is
        // what stops the producer: its cursor is past rows this client will not
        // receive, so one more batch from it would strand them (PROTOCOL.md §6).
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
        // Popping is what "reached the client" means.
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
        // The overflow drops only `ID`'s frames.
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

    /// A page of `count` rows, each carrying `bytes` of `content`.
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
        // 40 rows × 64 KiB ≈ 2.5 MiB: one batch under the old code, over both the
        // per-batch budget and (with a couple more rows) the queue bound.
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

        // Watermarks are monotonic, each one is a real row boundary, and only the
        // last batch carries the page's own watermark and `complete`.
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

        // Every row is delivered exactly once, and each batch is valid JSON of the
        // shape PROTOCOL.md §2.4 specifies.
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
                // The PWA always wants content (PROTOCOL.md §2.3).
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

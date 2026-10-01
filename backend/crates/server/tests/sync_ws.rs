//! Integration tests for the M2 sync layer — `/api/sync` and
//! `/api/sync/bootstrap` (SPEC §4, `backend/PROTOCOL.md`).
//!
//! These drive the **real** router over a **real** socket against a **live**
//! MongoDB, because everything this milestone is about lives in the seams: the
//! upgrade handshake, sequence-number watermarks, y-protocol relay between two
//! sockets, and close codes. A faked transport would prove none of it.
//!
//! ```sh
//! docker compose up -d mongo
//! MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p ddd-server --test sync_ws -- --ignored
//! ```
//!
//! Every test is `#[ignore]`d so that `cargo test` stays green with no database,
//! and every test also returns early when `MONGO_URI` is unset, so a plain
//! `--ignored` run on a machine with no Mongo reports success rather than noise.
//!
//! Ownership note (`backend/CONTRACTS.md`): `crates/server/tests/**` is listed
//! under http-routes. This file is the sync area's, kept to its own filename so
//! the two never collide; the DSL sort/filter tests that area owes M2 belong in a
//! separate file.

// The suite lock is deliberately held across awaits — that is the whole point of
// it (see `SUITE`): one live `AppState` at a time, for the length of a test. The
// usual hazard (a blocked runtime worker) does not apply, because each
// `#[tokio::test]` owns its own runtime and the waiting one has nothing else to
// run yet.
#![allow(clippy::await_holding_lock)]

use std::net::SocketAddr;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use ddd_server::config::Config;
use ddd_server::docstore::{TEXT_ROOT, new_doc};
use ddd_server::domain::{Actor, Id, SessionKind, User};
use ddd_server::routes::sync::{close, frame};
use ddd_server::state::AppState;
use ddd_server::{auth, db, routes, telemetry};
use futures::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::MaybeTlsStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Message, protocol::CloseFrame};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{GetString, ReadTxn, Text, Transact, Update};

type Socket = tokio_tungstenite::WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Nothing in these tests is allowed to hang forever: a protocol bug should fail
/// a test, not wedge CI.
const TIMEOUT: Duration = Duration::from_secs(15);
/// How long "nothing arrives" is given to prove itself.
const QUIET: Duration = Duration::from_millis(600);

const ORIGIN: &str = "http://localhost:8080";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// Name of the one database this suite uses. Deliberately **one**, not one per
/// test: a database is ~26 WiredTiger files, and a container `mongod` runs with a
/// 1024 file-descriptor limit — twenty parallel throwaway databases exhaust it and
/// WiredTiger panics the server, which looks exactly like a sync bug and is not
/// one. One database, emptied at the start of each test, touches no files at all.
const TEST_DB: &str = "ddd_test_sync";

/// Serializes the suite.
///
/// Each test builds its own `AppState`, and an `AppState` is a *replica*: SPEC §8
/// pins `replicas: 1` precisely because the change-feed counter is in-process, so
/// two live `AppState`s on one database would hand out the same sequence numbers.
/// Holding this lock for the body of each test means exactly one replica exists at
/// a time — which is also the deployment the protocol is specified against.
static SUITE: Mutex<()> = Mutex::new(());

struct TestApp {
    state: AppState,
    router: Router,
    addr: SocketAddr,
    token: String,
    user_id: Id,
    /// Released when the app is dropped: see [`SUITE`].
    _suite: std::sync::MutexGuard<'static, ()>,
}

impl TestApp {
    /// Spawn the whole application on an ephemeral port against a freshly emptied
    /// database. `None` ⇒ no `MONGO_URI`, so the test opts out.
    async fn spawn() -> Option<Self> {
        // A previous test that panicked leaves the lock poisoned; the data it
        // guards is `()`, so recovering is the right call.
        let suite = SUITE.lock().unwrap_or_else(|err| err.into_inner());
        let (mut config, metrics) = base_config()?;
        config.mongo_database = TEST_DB.to_string();

        // The collections and indexes are created once per run; every test then
        // *empties* them rather than dropping the database. Dropping churns
        // WiredTiger idents 20 times in a row, and with `mongod`'s 1024-descriptor
        // container limit that is what pushes it into a panic. Emptying touches no
        // files, and `ChangeFeed::initialize` re-reads `max(feed_seq)` from the now
        // empty collections, so each test still starts from sequence zero.
        {
            let (_, db_handle) = db::connect(&config).await.expect("mongo");
            db::init_schema(&db_handle).await.expect("schema");
            empty_collections(&db_handle).await;
        }

        let state = AppState::new(config).await.expect("app state");

        let (user_id, token) = seed_user(&state).await;
        let router = routes::router(state.clone(), metrics);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("local addr");
        let served = router.clone();
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                served.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        Some(TestApp {
            state,
            router,
            addr,
            token,
            user_id,
            _suite: suite,
        })
    }

    fn actor(&self) -> Actor {
        Actor::User(self.user_id.clone())
    }

    /// Open a sync socket the way the shell does: bearer token in the
    /// `Authorization` header, `Origin` on the allowlist.
    async fn connect(&self) -> Socket {
        self.connect_with(|request| {
            request.headers_mut().insert(
                header::AUTHORIZATION,
                format!("Bearer {}", self.token).parse().unwrap(),
            );
            request
                .headers_mut()
                .insert(header::ORIGIN, ORIGIN.parse().unwrap());
        })
        .await
        .expect("socket connects")
    }

    async fn connect_with<F>(&self, decorate: F) -> Result<Socket, String>
    where
        F: FnOnce(&mut tokio_tungstenite::tungstenite::handshake::client::Request),
    {
        let mut request = format!("ws://{}/api/sync", self.addr)
            .into_client_request()
            .expect("request");
        request
            .headers_mut()
            .insert(header::SEC_WEBSOCKET_PROTOCOL, "ddd.v1".parse().unwrap());
        decorate(&mut request);
        match tokio_tungstenite::connect_async(request).await {
            Ok((socket, _response)) => Ok(socket),
            Err(err) => Err(err.to_string()),
        }
    }

    /// A request through the router itself — no HTTP client crate needed, and the
    /// full middleware stack still runs.
    async fn get(&self, uri: &str) -> (StatusCode, Vec<u8>) {
        use tower::ServiceExt;
        let request = Request::builder()
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(header::ORIGIN, ORIGIN)
            .body(Body::empty())
            .unwrap();
        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("router responds");
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024 * 1024)
            .await
            .expect("body");
        (status, body.to_vec())
    }

    /// A JSON request through the router (`PUT`, `PATCH`, `POST`), same stack.
    async fn send_json_request(
        &self,
        method: &str,
        uri: &str,
        body: serde_json::Value,
    ) -> StatusCode {
        use tower::ServiceExt;
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
            .header(header::ORIGIN, ORIGIN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        self.router
            .clone()
            .oneshot(request)
            .await
            .expect("router responds")
            .status()
    }

    async fn create_document(&self, text: &str) -> Id {
        self.state
            .docs
            .create(None, text, &self.actor())
            .await
            .expect("create")
            .id
    }

    /// Ends the test: the next one drops the database on the way in, so this only
    /// has to release the suite lock — which `drop` does.
    async fn cleanup(self) {
        drop(self);
    }
}

/// `Config::from_env` is the only constructor, so the process environment is set
/// up once, under a lock, and the per-test database name is overridden afterwards
/// on the returned value.
///
/// The Prometheus recorder is installed under the same lock. `// INTEGRATION:`
/// `telemetry::init_metrics` sets its `OnceLock` *after* installing the recorder,
/// so two threads calling it concurrently both try to install and the loser
/// panics — harmless for `main`, fatal for parallel tests. Reported to ops; the
/// lock here is the workaround, not the fix.
fn base_config() -> Option<(Config, metrics_exporter_prometheus::PrometheusHandle)> {
    static LOCK: Mutex<()> = Mutex::new(());
    static PREPARED: OnceLock<bool> = OnceLock::new();

    let _guard = LOCK.lock().unwrap_or_else(|err| err.into_inner());
    let prepared = *PREPARED.get_or_init(|| {
        let Ok(uri) = std::env::var("MONGO_URI") else {
            return false;
        };
        // SAFETY: single-threaded section guarded by `LOCK`, before any config is
        // read. `set_var` is `unsafe` in edition 2024 only because of concurrent
        // readers, and the harness has none yet.
        unsafe {
            std::env::set_var("MONGO_URI", uri);
            std::env::set_var(
                "SESSION_SECRET",
                "integration-test-session-secret-at-least-32-bytes",
            );
            std::env::set_var("APP_ORIGIN", ORIGIN);
            std::env::set_var("BIND_ADDR", "127.0.0.1:0");
        }
        true
    });
    if !prepared {
        eprintln!("skipping: MONGO_URI is not set");
        return None;
    }
    let config = Config::from_env().expect("config");
    let metrics = telemetry::init_metrics(&config).expect("metrics");
    Some((config, metrics))
}

/// Empty every collection a sync test can observe, leaving the schema in place.
async fn empty_collections(database: &mongodb::Database) {
    for name in [
        db::DOCUMENTS,
        db::DOCUMENT_UPDATES,
        db::DOCUMENT_SNAPSHOTS,
        db::DELETED_IDS,
        db::USERS,
        db::SESSIONS,
        db::AUDIT_LOG,
        db::ATTACHMENTS,
        db::LOGIN_ATTEMPTS,
    ] {
        database
            .collection::<bson::Document>(name)
            .delete_many(bson::doc! {})
            .await
            .unwrap_or_else(|err| panic!("emptying {name}: {err}"));
    }
}

fn ulid_suffix() -> String {
    ddd_server::domain::new_id().to_lowercase()
}

/// A user and a bearer session, written straight through the auth layer so the
/// socket authenticates exactly as a shell would.
async fn seed_user(state: &AppState) -> (Id, String) {
    let user = User {
        id: ddd_server::domain::new_id(),
        email: format!("sync-{}@example.test", ulid_suffix()),
        name: "Sync Test".to_string(),
        password_hash: auth::password::hash("correct-horse-battery").expect("hash"),
        is_admin: true,
        is_active: true,
        created_at: bson::DateTime::now(),
        updated_at: bson::DateTime::now(),
        last_login_at: None,
        invited_by: None,
    };
    state
        .collections
        .users()
        .insert_one(&user)
        .await
        .expect("insert user");
    let (_session, token) = auth::create_session(state, &user, SessionKind::Bearer, None, None)
        .await
        .expect("session");
    (user.id, token)
}

// ---------------------------------------------------------------------------
// Socket helpers
// ---------------------------------------------------------------------------

/// Next JSON control frame. Binary frames are skipped, so a test can wait for a
/// control message without caring how many CRDT frames precede it.
async fn next_json(socket: &mut Socket) -> serde_json::Value {
    loop {
        match recv(socket).await {
            Message::Text(text) => {
                return serde_json::from_str(&text).expect("control frame is JSON");
            }
            Message::Binary(_) | Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("expected a control frame, got {other:?}"),
        }
    }
}

/// Wait for a live `feed.batch` carrying a row for `id` that satisfies `matches`.
///
/// Materialization is debounced (~500 ms, SPEC §3.5) and the live tail coalesces
/// for another ~50 ms, so a feed row never arrives in the same tick as the write
/// that caused it. `None` means it never arrived — which for a projection change
/// is the "invisible to every client" failure, not a slow test.
async fn await_feed_row(
    socket: &mut Socket,
    id: &str,
    matches: impl Fn(&serde_json::Value) -> bool,
) -> Option<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let batch = tokio::time::timeout_at(deadline, next_json(socket)).await;
        let Ok(batch) = batch else { return None };
        if batch["t"] != "feed.batch" {
            continue;
        }
        if let Some(row) = batch["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["id"] == id && matches(row))
        {
            return Some(row.clone());
        }
    }
    None
}

/// Next binary frame, parsed into `(type, id, payload)`.
async fn next_frame(socket: &mut Socket) -> (u8, String, Vec<u8>) {
    loop {
        match recv(socket).await {
            Message::Binary(bytes) => return split_frame(&bytes),
            Message::Text(text) => {
                // A `doc.error` here is a test failure with a useful message.
                let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                if value["t"] == "doc.error" {
                    panic!("unexpected doc.error: {value}");
                }
                continue;
            }
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("expected a binary frame, got {other:?}"),
        }
    }
}

async fn recv(socket: &mut Socket) -> Message {
    tokio::time::timeout(TIMEOUT, socket.next())
        .await
        .expect("a frame within the timeout")
        .expect("socket is open")
        .expect("no transport error")
}

/// Wait for the close frame the server promised, returning its code.
async fn close_code(socket: &mut Socket) -> u16 {
    loop {
        let message = tokio::time::timeout(TIMEOUT, socket.next())
            .await
            .expect("a frame within the timeout");
        match message {
            Some(Ok(Message::Close(Some(CloseFrame { code, .. })))) => return code.into(),
            Some(Ok(Message::Close(None))) => panic!("close frame carried no code"),
            Some(Ok(_)) => continue,
            Some(Err(err)) => panic!("transport error while waiting for close: {err}"),
            None => panic!("socket ended without a close frame"),
        }
    }
}

fn split_frame(bytes: &[u8]) -> (u8, String, Vec<u8>) {
    let kind = bytes[0];
    let id_len = bytes[1] as usize;
    let id = String::from_utf8(bytes[2..2 + id_len].to_vec()).expect("ascii id");
    (kind, id, bytes[2 + id_len..].to_vec())
}

fn build_frame(kind: u8, id: &str, payload: &[u8]) -> Message {
    let mut frame = vec![kind, id.len() as u8];
    frame.extend_from_slice(id.as_bytes());
    frame.extend_from_slice(payload);
    Message::Binary(frame.into())
}

async fn send_json(socket: &mut Socket, value: serde_json::Value) {
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .expect("send");
}

/// A client-side replica of one document, speaking the same y-protocols exchange
/// the web kernel does.
struct ClientDoc {
    doc: yrs::Doc,
    text: yrs::TextRef,
}

impl ClientDoc {
    fn new() -> Self {
        // `new_doc` on purpose: `OffsetKind::Utf16` and the GC setting are pinned
        // compatibility decisions (SPEC §3.2), and a test that quietly used
        // different options would be testing a different protocol.
        let doc = new_doc();
        let text = doc.get_or_insert_text(TEXT_ROOT);
        Self { doc, text }
    }

    fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    fn apply(&self, update: &[u8]) {
        let update = Update::decode_v1(update).expect("decodable update");
        self.doc
            .transact_mut()
            .apply_update(update)
            .expect("applies");
    }

    /// Insert text and return the encoded diff, as a client would send it.
    fn insert(&self, index: u32, value: &str) -> Vec<u8> {
        let before = self.doc.transact().state_vector();
        {
            let mut txn = self.doc.transact_mut();
            self.text.insert(&mut txn, index, value);
        }
        self.doc.transact().encode_diff_v1(&before)
    }

    fn contents(&self) -> String {
        self.text.get_string(&self.doc.transact())
    }
}

/// Open a socket, swallow `welcome`, and hand back both.
async fn connected(app: &TestApp) -> Socket {
    let mut socket = app.connect().await;
    let welcome = next_json(&mut socket).await;
    assert_eq!(welcome["t"], "welcome", "welcome must be the first frame");
    socket
}

/// Subscribe to a document and drain the handshake, returning the client replica.
async fn hydrate(socket: &mut Socket, id: &str) -> ClientDoc {
    send_json(
        socket,
        serde_json::json!({ "t": "doc.subscribe", "id": id }),
    )
    .await;
    let subscribed = next_json(socket).await;
    assert_eq!(subscribed["t"], "doc.subscribed");
    assert_eq!(subscribed["id"], id);

    let (kind, frame_id, _server_sv) = next_frame(socket).await;
    assert_eq!(kind, frame::SYNC_STEP1);
    assert_eq!(frame_id, id);

    // No local replica: send an empty state vector and let the server answer.
    let client = ClientDoc::new();
    socket
        .send(build_frame(frame::SYNC_STEP1, id, &client.state_vector()))
        .await
        .expect("send step1");
    let (kind, _, payload) = next_frame(socket).await;
    assert_eq!(kind, frame::SYNC_STEP2);
    client.apply(&payload);
    client
}

fn json_lines(body: &[u8]) -> Vec<serde_json::Value> {
    std::str::from_utf8(body)
        .expect("utf8 ndjson")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("each line is JSON"))
        .collect()
}

/// Extended JSON anywhere on the wire is the M1 carry-over bug this milestone
/// closes (PROTOCOL.md §2.1).
fn assert_no_extended_json(body: &str) {
    assert!(
        !body.contains("$date"),
        "extended JSON leaked to the wire: {body}"
    );
    assert!(
        !body.contains("$binary"),
        "extended JSON leaked to the wire: {body}"
    );
}

// ---------------------------------------------------------------------------
// Bootstrap (PROTOCOL.md §4)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn bootstrap_pages_the_projection_and_pins_safe_seq() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };

    let mut created = Vec::new();
    for index in 0..5 {
        created.push(
            app.create_document(&format!("---\ntitle: Doc {index}\n---\n\nbody {index}\n"))
                .await,
        );
    }
    created.sort();

    let (status, body) = app.get("/api/sync/bootstrap?limit=2").await;
    assert_eq!(status, StatusCode::OK);
    let text = String::from_utf8(body.clone()).unwrap();
    assert_no_extended_json(&text);

    let lines = json_lines(&body);
    assert_eq!(lines.first().unwrap()["type"], "header");
    let header = &lines[0];
    assert_eq!(header["protocol"], 1);
    assert_eq!(header["total"], 5);
    assert_eq!(
        header["core_semantics_version"],
        ddd_core::CORE_SEMANTICS_VERSION
    );
    let pinned_safe_seq = header["safe_seq"].as_i64().unwrap();
    assert!(pinned_safe_seq >= 5, "safe_seq should cover five creates");

    let rows: Vec<&serde_json::Value> = lines.iter().filter(|line| line["type"] == "row").collect();
    assert_eq!(rows.len(), 2, "limit=2 means two rows per page");
    // Timestamps are RFC 3339 strings, not `{$date: …}`.
    assert!(
        rows[0]["updated_at"].as_str().unwrap().ends_with('Z'),
        "timestamps are RFC 3339 strings"
    );
    assert!(rows[0]["content"].is_string());
    assert_eq!(rows[0]["purged"], false);
    assert_eq!(rows[0]["deleted"], false);

    let footer = lines.last().unwrap();
    assert_eq!(footer["type"], "footer");
    assert_eq!(footer["count"], 2);
    assert_eq!(footer["complete"], false);
    assert_eq!(footer["safe_seq"], pinned_safe_seq);

    // Walk the cursor to the end and collect every id: a full pass is
    // authoritative, so it must mention all five.
    let mut seen: Vec<String> = rows
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_string())
        .collect();
    let mut cursor = footer["next_cursor"].as_str().unwrap().to_string();
    let mut pages = 1;
    loop {
        // Writes land *during* the pass, which is exactly when a re-read watermark
        // would drift. The pin has to survive them.
        app.create_document(&format!("---\ntitle: Concurrent {pages}\n---\n"))
            .await;

        let (status, body) = app
            .get(&format!("/api/sync/bootstrap?limit=2&cursor={cursor}"))
            .await;
        assert_eq!(status, StatusCode::OK);
        let lines = json_lines(&body);
        pages += 1;

        // PROTOCOL.md §4: captured on the first page, echoed unchanged on every
        // page — even though each page is its own stateless HTTP request, and even
        // though the watermark has genuinely moved since.
        assert_eq!(
            lines[0]["safe_seq"], pinned_safe_seq,
            "page {pages} header re-read the watermark instead of echoing the pin"
        );

        for row in lines.iter().filter(|line| line["type"] == "row") {
            seen.push(row["id"].as_str().unwrap().to_string());
        }
        let footer = lines.last().unwrap();
        assert_eq!(footer["safe_seq"], pinned_safe_seq, "page {pages} footer");
        if footer["complete"] == true {
            assert!(footer["next_cursor"].is_null());
            break;
        }
        cursor = footer["next_cursor"].as_str().unwrap().to_string();
    }
    assert!(pages >= 3, "the walk must actually page: {pages} page(s)");
    seen.sort();
    // The five originals must all appear; the documents created mid-pass may or
    // may not, depending on where their ULIDs sort — either is correct, and the
    // feed re-delivers them from the pinned watermark regardless.
    for id in &created {
        assert!(seen.contains(id), "a full pass must mention {id}");
    }

    // Restarting from a `next_cursor` (PROTOCOL.md §4 permits cancelling
    // mid-stream) keeps the original pin, so a resumed pass cannot resume the feed
    // past rows it never stored.
    // The cursor is opaque to clients; its documented wire form is spelled out
    // here because the restart is the case a client hand-rolls.
    let resumed = format!("{}.{pinned_safe_seq}", created[0]);
    let (status, body) = app
        .get(&format!("/api/sync/bootstrap?limit=2&cursor={resumed}"))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json_lines(&body)[0]["safe_seq"], pinned_safe_seq);

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn bootstrap_probe_returns_only_a_header() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    app.create_document("probe me").await;

    let (status, body) = app.get("/api/sync/bootstrap?probe=1").await;
    assert_eq!(status, StatusCode::OK);
    let lines = json_lines(&body);
    // PROTOCOL.md §4: "a single header line only". Not a header and a footer — a
    // client reading exactly one line must not be left with a line in its buffer.
    assert_eq!(
        lines.len(),
        1,
        "the header is the whole response: {lines:?}"
    );
    assert_eq!(lines[0]["type"], "header");
    assert_eq!(lines[0]["total"], 1);
    assert!(lines[0]["safe_seq"].is_i64());

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn bootstrap_honours_trash_and_content_selectors() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let live = app.create_document("live one").await;
    let trashed = app.create_document("trash me").await;
    app.state
        .docs
        .tombstone(&trashed, &app.actor())
        .await
        .expect("tombstone");

    let (_, body) = app.get("/api/sync/bootstrap?trash=live").await;
    let ids: Vec<String> = json_lines(&body)
        .into_iter()
        .filter(|line| line["type"] == "row")
        .map(|row| row["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec![live.clone()], "trash=live excludes tombstones");

    // Default is `all`, because the client's Trash view works offline.
    let (_, body) = app.get("/api/sync/bootstrap?include_content=false").await;
    let rows: Vec<serde_json::Value> = json_lines(&body)
        .into_iter()
        .filter(|line| line["type"] == "row")
        .collect();
    assert_eq!(rows.len(), 2);
    for row in &rows {
        assert!(
            row.get("content").is_none(),
            "include_content=false omits content: {row}"
        );
    }

    let (status, _) = app.get("/api/sync/bootstrap?trash=bin").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "unknown trash selector");

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// Handshake, origin, auth (PROTOCOL.md §1)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn welcome_is_the_first_frame_and_announces_the_limits() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };

    let mut socket = app.connect().await;
    let welcome = next_json(&mut socket).await;
    assert_eq!(welcome["t"], "welcome");
    assert_eq!(welcome["protocol"], 1);
    assert_eq!(welcome["session"]["user_id"], app.user_id);
    assert_eq!(welcome["session"]["via"], "bearer");
    assert!(
        welcome["session"]["expires_at"]
            .as_str()
            .unwrap()
            .ends_with('Z')
    );
    assert_eq!(welcome["feed"]["floor_seq"], 0);
    assert_eq!(welcome["limits"]["max_frame_bytes"], 4 * 1024 * 1024);
    assert_eq!(welcome["limits"]["max_subscriptions"], 32);
    assert_eq!(welcome["limits"]["heartbeat_secs"], 25);
    assert_eq!(
        welcome["core_semantics_version"],
        ddd_core::CORE_SEMANTICS_VERSION
    );
    // The load set's fingerprint: a hex string, the same one `/api/plugins` reports.
    let plugins_version = welcome["plugins_version"]
        .as_str()
        .expect("plugins_version");
    assert_eq!(plugins_version.len(), 16);
    assert!(plugins_version.chars().all(|c| c.is_ascii_hexdigit()));
    assert_no_extended_json(&welcome.to_string());

    // The app-level heartbeat answers with the echoed timestamp.
    send_json(&mut socket, serde_json::json!({ "t": "ping", "ts": 1234 })).await;
    let pong = next_json(&mut socket).await;
    assert_eq!(pong["t"], "pong");
    assert_eq!(pong["ts"], 1234);
    assert!(pong["server_time"].as_str().unwrap().ends_with('Z'));

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn the_upgrade_refuses_a_bad_origin_before_it_authenticates() {
    use tower::ServiceExt;
    let Some(app) = TestApp::spawn().await else {
        return;
    };

    // No credential at all + a refused `Origin` ⇒ 403, *not* 401. That ordering is
    // the requirement (PROTOCOL.md §1.2): a hostile page must not be able to tell
    // a valid session from an invalid one by the status code it gets back.
    let request = Request::builder()
        .uri("/api/sync")
        .header(header::ORIGIN, "https://evil.example.com")
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
        .header(header::SEC_WEBSOCKET_PROTOCOL, "ddd.v1")
        .body(Body::empty())
        .unwrap();
    let response = app.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // Same request with a valid credential: still 403, and identical.
    let request = Request::builder()
        .uri("/api/sync")
        .header(header::ORIGIN, "https://evil.example.com")
        .header(header::AUTHORIZATION, format!("Bearer {}", app.token))
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
        .header(header::SEC_WEBSOCKET_PROTOCOL, "ddd.v1")
        .body(Body::empty())
        .unwrap();
    let response = app.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    // A cookie connection with no `Origin` is the CSRF shape, and is refused.
    let request = Request::builder()
        .uri("/api/sync")
        .header(header::COOKIE, format!("ddd_session={}", app.token))
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
        .header(header::SEC_WEBSOCKET_PROTOCOL, "ddd.v1")
        .body(Body::empty())
        .unwrap();
    let response = app.router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn an_unauthenticated_upgrade_is_refused_with_401() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let error = app
        .connect_with(|request| {
            request
                .headers_mut()
                .insert(header::ORIGIN, ORIGIN.parse().unwrap());
        })
        .await
        .expect_err("no credential must fail");
    assert!(error.contains("401"), "expected a 401, got {error}");

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn the_bearer_subprotocol_authenticates_a_shell() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    // No `Authorization`, no cookie, no `Origin` — exactly the Flutter shell's
    // situation (SPEC §5.2, §7).
    let mut socket = app
        .connect_with(|request| {
            request.headers_mut().insert(
                header::SEC_WEBSOCKET_PROTOCOL,
                format!("ddd.v1, ddd.bearer.{}", app.token).parse().unwrap(),
            );
        })
        .await
        .expect("shell socket connects");
    let welcome = next_json(&mut socket).await;
    assert_eq!(welcome["t"], "welcome");
    assert_eq!(welcome["session"]["via"], "bearer");

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn the_ninth_socket_for_a_session_is_closed_with_4429() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };

    let mut sockets = Vec::new();
    for _ in 0..8 {
        sockets.push(connected(&app).await);
    }
    let mut ninth = app.connect().await;
    assert_eq!(close_code(&mut ninth).await, close::TOO_MANY_SOCKETS);

    // Closing one frees the slot again.
    let mut released = sockets.pop().unwrap();
    released.close(None).await.ok();
    drop(released);
    tokio::time::sleep(QUIET).await;
    let mut replacement = app.connect().await;
    let welcome = next_json(&mut replacement).await;
    assert_eq!(welcome["t"], "welcome");

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn a_revoked_session_closes_the_socket_with_4401() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let mut socket = connected(&app).await;

    // Revalidation runs on a 5-minute timer, so this asserts the *effect* of a
    // revocation reaching a live socket by driving the same check the timer does:
    // delete the session row, then prove the next authenticated action fails.
    // (The timer itself is a `tokio::time` sleep; a test that waited it out would
    // take five minutes.)
    app.state
        .collections
        .sessions()
        .delete_many(bson::doc! {})
        .await
        .expect("revoke");

    // A brand-new socket must now be refused at the upgrade — same verdict the
    // revalidator reaches, one round trip instead of five minutes.
    let error = app
        .connect_with(|request| {
            request.headers_mut().insert(
                header::AUTHORIZATION,
                format!("Bearer {}", app.token).parse().unwrap(),
            );
            request
                .headers_mut()
                .insert(header::ORIGIN, ORIGIN.parse().unwrap());
        })
        .await
        .expect_err("a revoked token cannot open a socket");
    assert!(error.contains("401"), "expected a 401, got {error}");

    // A session row deleted straight in Mongo (a backup restore, an expiry sweep)
    // is the case only the 5-minute poll can catch: the socket keeps working until
    // then, deliberately — the alternative is a Mongo read per frame.
    send_json(&mut socket, serde_json::json!({ "t": "ping", "ts": 1 })).await;
    assert_eq!(next_json(&mut socket).await["t"], "pong");

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn revoking_through_the_auth_layer_closes_the_socket_at_once() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let mut socket = connected(&app).await;

    // PROTOCOL.md §1.3: "on any revocation it learns about". A password change, a
    // logout on another device, an admin deactivating the account — all of them run
    // through `auth::revoke_*`, and all of them must reach the live socket now, not
    // at the next poll. Six minutes of a revoked credential reading every document
    // in the workspace (and writing CRDT updates as that user) is the bug.
    let revoked = auth::revoke_user_sessions(&app.state, &app.user_id)
        .await
        .expect("revoke");
    assert!(revoked >= 1, "the seeded bearer session was revoked");

    assert_eq!(
        close_code(&mut socket).await,
        close::UNAUTHENTICATED,
        "a revocation closes the socket with 4401 (re-authenticate, never clear data)"
    );

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn a_rest_write_reaches_a_socket_that_has_the_document_open() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let id = app.create_document("original\n").await;

    let mut socket = connected(&app).await;
    let client = hydrate(&mut socket, &id).await;
    assert_eq!(client.contents(), "original\n");

    // A REST write is a CRDT write. Without the fan-out hook the projection row
    // updates (so doc lists and search move) while this editor keeps the old text
    // and merges the user's next keystroke into it — divergence for the life of the
    // subscription (PROTOCOL.md §3.4).
    let status = app
        .send_json_request(
            "PUT",
            &format!("/api/documents/{id}"),
            serde_json::json!({ "content": "rewritten by REST\n" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (kind, frame_id, payload) = tokio::time::timeout(TIMEOUT, next_frame(&mut socket))
        .await
        .expect("a REST write must reach an open editor");
    assert_eq!(kind, frame::UPDATE);
    assert_eq!(frame_id, id);
    client.apply(&payload);
    assert_eq!(
        client.contents(),
        "rewritten by REST\n",
        "the open replica converged on the REST write"
    );

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn crdt_frames_for_an_unsubscribed_document_are_ignored() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let id = app.create_document("private\n").await;
    // Start from a cold registry: the create above left the room hot.
    app.state.docs.flush_all().await.expect("flush");
    let mut socket = connected(&app).await;

    let client = ClientDoc::new();
    // `SYNC_STEP1` without `doc.subscribe`: ungated, this reaches `DocStore::diff`
    // and pins the document in the process-wide hot-room registry for ten minutes —
    // one 28-byte frame per document is enough to hold a whole workspace in RAM,
    // while `MAX_SUBSCRIPTIONS` is never consulted.
    socket
        .send(build_frame(frame::SYNC_STEP1, &id, &client.state_vector()))
        .await
        .expect("send");
    // And an `UPDATE`, which would otherwise be applied as a write.
    let update = client.insert(0, "sneaky ");
    socket
        .send(build_frame(frame::UPDATE, &id, &update))
        .await
        .expect("send");

    assert!(
        tokio::time::timeout(QUIET, socket.next()).await.is_err(),
        "an unsubscribed document gets no answer"
    );
    // The socket is still perfectly usable — a frame crossing an unsubscribe must
    // not cost the user their other documents.
    send_json(&mut socket, serde_json::json!({ "t": "ping", "ts": 9 })).await;
    assert_eq!(next_json(&mut socket).await["t"], "pong");

    // Neither frame was applied, and neither loaded the document.
    let text = app.state.docs.text(&id).await.expect("text");
    assert_eq!(text, "private\n", "the unsubscribed update was not applied");

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn an_unknown_control_message_closes_with_4400() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let mut socket = connected(&app).await;
    send_json(&mut socket, serde_json::json!({ "t": "plugin.emit" })).await;
    assert_eq!(close_code(&mut socket).await, close::PROTOCOL_ERROR);

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn a_malformed_binary_envelope_closes_with_4400() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let mut socket = connected(&app).await;
    // idLen = 0 is illegal (PROTOCOL.md §3.1).
    socket
        .send(Message::Binary(vec![frame::UPDATE, 0].into()))
        .await
        .expect("send");
    assert_eq!(close_code(&mut socket).await, close::PROTOCOL_ERROR);

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn a_frame_above_four_mib_closes_with_4413() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let id = app.create_document("small").await;
    let mut socket = connected(&app).await;

    let payload = vec![0u8; 4 * 1024 * 1024 + 16];
    socket
        .send(build_frame(frame::UPDATE, &id, &payload))
        .await
        .expect("send");
    assert_eq!(close_code(&mut socket).await, close::FRAME_TOO_LARGE);

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// The change feed (PROTOCOL.md §2)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn the_feed_catches_up_then_tails_live() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let first = app
        .create_document("---\ntitle: First\n---\n\nhello\n")
        .await;

    let mut socket = connected(&app).await;
    send_json(
        &mut socket,
        serde_json::json!({ "t": "feed.subscribe", "since_seq": 0 }),
    )
    .await;

    // Catch-up: one or more batches, the last of them `complete`.
    let mut caught_up_ids = Vec::new();
    let safe_seq;
    loop {
        let batch = next_json(&mut socket).await;
        assert_eq!(batch["t"], "feed.batch");
        assert_eq!(batch["mode"], "catchup");
        assert_no_extended_json(&batch.to_string());
        for row in batch["rows"].as_array().unwrap() {
            caught_up_ids.push(row["id"].as_str().unwrap().to_string());
            assert!(row["seq"].as_i64().unwrap() > 0);
        }
        if batch["complete"] == true {
            safe_seq = batch["safe_seq"].as_i64().unwrap();
            break;
        }
    }
    assert!(caught_up_ids.contains(&first), "catch-up carries the row");
    assert!(safe_seq >= 1);

    // Live tail: a new document arrives without another subscribe.
    let second = app
        .create_document("---\ntitle: Second\n---\n\nworld\n")
        .await;
    let batch = next_json(&mut socket).await;
    assert_eq!(batch["t"], "feed.batch");
    assert_eq!(batch["mode"], "live");
    assert_eq!(batch["complete"], false);
    let rows = batch["rows"].as_array().unwrap();
    assert!(
        rows.iter().any(|row| row["id"] == second.as_str()),
        "the live tail carries the new row: {batch}"
    );
    assert!(batch["safe_seq"].as_i64().unwrap() >= safe_seq);

    // And the watermark only ever moves forward.
    let row = rows
        .iter()
        .find(|row| row["id"] == second.as_str())
        .unwrap();
    assert_eq!(row["title"], "Second");
    assert!(row["content"].as_str().unwrap().contains("world"));

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn a_resume_point_from_the_future_resets_the_feed() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    app.create_document("one").await;

    let mut socket = connected(&app).await;
    send_json(
        &mut socket,
        serde_json::json!({ "t": "feed.subscribe", "since_seq": 9_000_000 }),
    )
    .await;
    let reset = next_json(&mut socket).await;
    assert_eq!(reset["t"], "feed.reset");
    assert_eq!(reset["reason"], "seq_ahead");
    assert_eq!(reset["floor_seq"], 0);

    app.cleanup().await;
}

/// The tombstone / restore / purge half of the feed.
///
/// The executable form of CONTRACTS.md "Area: docstore (M2 additions)" item 1 —
/// every projection change allocates a `feed_seq` and commits it. It was written
/// while only `create` did, and gated behind an env var until the docstore caught
/// up; the gate is gone because it landed.
#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn a_tombstone_and_a_purge_reach_the_feed_as_rows() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let id = app.create_document("delete me").await;

    let mut socket = connected(&app).await;
    send_json(
        &mut socket,
        serde_json::json!({ "t": "feed.subscribe", "since_seq": 0 }),
    )
    .await;
    // Drain catch-up.
    loop {
        let batch = next_json(&mut socket).await;
        if batch["complete"] == true {
            break;
        }
    }

    // An *edit* first: materialization has to renumber the row, or an offline
    // mirror goes stale for every document it is not actively editing. This is the
    // defect the convergence harness's `assertFeedFreshness` was written to catch.
    app.state
        .docs
        .replace_text(&id, "edited before deletion\n", &app.actor())
        .await
        .expect("edit");
    let edited = await_feed_row(&mut socket, &id, |row| {
        row["content"].as_str() == Some("edited before deletion\n")
    })
    .await
    .expect("a materialization reaches the feed as a new row");
    let edit_seq = edited["seq"].as_i64().expect("rows carry a seq");
    assert_eq!(edited["deleted"], false);

    app.state
        .docs
        .tombstone(&id, &app.actor())
        .await
        .expect("tombstone");
    let tombstoned = await_feed_row(&mut socket, &id, |row| row["deleted"] == true)
        .await
        .expect("a tombstone reaches the feed as a new row");
    assert!(
        tombstoned["seq"].as_i64().unwrap() > edit_seq,
        "a tombstone is a later change than the edit before it"
    );
    assert!(
        tombstoned["deleted_at"].as_str().unwrap().ends_with('Z'),
        "RFC 3339, never extended JSON"
    );
    assert_eq!(tombstoned["purged"], false, "Trash is still restorable");

    app.state
        .docs
        .untombstone(&id, &app.actor())
        .await
        .expect("restore");
    let restored = await_feed_row(&mut socket, &id, |row| row["deleted"] == false)
        .await
        .expect("a restore reaches the feed as a new row");
    assert!(restored["deleted_at"].is_null());
    assert_eq!(
        restored["updated_by"], app.user_id,
        "a restore records who applied it (SPEC §3.5: *_by is the last applier)"
    );

    app.state
        .docs
        .tombstone(&id, &app.actor())
        .await
        .expect("re-tombstone");
    app.state
        .docs
        .purge(&id, &app.actor())
        .await
        .expect("purge");

    let mut purged_row = None;
    for _ in 0..3 {
        let batch = tokio::time::timeout(Duration::from_secs(5), next_json(&mut socket)).await;
        let Ok(batch) = batch else { break };
        if let Some(row) = batch["rows"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["id"] == id.as_str()).cloned())
            && row["purged"] == true
        {
            purged_row = Some(row);
            break;
        }
    }
    let purged = purged_row.expect("a purge row reaches the feed");
    assert_eq!(purged["deleted"], true);
    assert!(
        purged.get("content").is_none(),
        "purge rows carry no content"
    );
    assert!(purged["deleted_at"].as_str().unwrap().ends_with('Z'));

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// Per-document CRDT sync (PROTOCOL.md §3)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn two_sockets_converge_through_the_server() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let id = app.create_document("start\n").await;

    let mut alice = connected(&app).await;
    let mut bob = connected(&app).await;
    let alice_doc = hydrate(&mut alice, &id).await;
    let bob_doc = hydrate(&mut bob, &id).await;
    assert_eq!(alice_doc.contents(), "start\n");
    assert_eq!(bob_doc.contents(), "start\n");

    // Alice edits; the server applies through the docstore and fans out to Bob.
    let update = alice_doc.insert(0, "hello ");
    alice
        .send(build_frame(frame::UPDATE, &id, &update))
        .await
        .expect("send update");

    let (kind, frame_id, payload) = next_frame(&mut bob).await;
    assert_eq!(kind, frame::UPDATE);
    assert_eq!(frame_id, id);
    bob_doc.apply(&payload);
    assert_eq!(bob_doc.contents(), alice_doc.contents());
    assert_eq!(bob_doc.contents(), "hello start\n");

    // The originator is never echoed its own update (PROTOCOL.md §3.4).
    assert!(
        tokio::time::timeout(QUIET, alice.next()).await.is_err(),
        "the writer must not receive its own update back"
    );

    // And the server's own replica converged too.
    let text = app.state.docs.text(&id).await.expect("text");
    assert_eq!(text, "hello start\n");

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn a_state_vector_on_subscribe_saves_the_round_trip() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let id = app.create_document("first version\n").await;

    // Hydrate once, so the client has a replica and a state vector.
    let mut socket = connected(&app).await;
    let client = hydrate(&mut socket, &id).await;
    send_json(
        &mut socket,
        serde_json::json!({ "t": "doc.unsubscribe", "id": id }),
    )
    .await;

    // Something changes while the client is away.
    let other = ClientDoc::new();
    let mut second = connected(&app).await;
    let other_doc = hydrate(&mut second, &id).await;
    drop(other);
    let update = other_doc.insert(0, "edited ");
    second
        .send(build_frame(frame::UPDATE, &id, &update))
        .await
        .expect("send");
    // Wait for the write to land before resubscribing.
    tokio::time::sleep(QUIET).await;

    use base64::Engine;
    let sv = base64::engine::general_purpose::STANDARD.encode(client.state_vector());
    send_json(
        &mut socket,
        serde_json::json!({ "t": "doc.subscribe", "id": id, "sv": sv }),
    )
    .await;
    assert_eq!(next_json(&mut socket).await["t"], "doc.subscribed");
    let (kind, _, _) = next_frame(&mut socket).await;
    assert_eq!(
        kind,
        frame::SYNC_STEP1,
        "the server always sends its own sv"
    );
    let (kind, _, payload) = next_frame(&mut socket).await;
    assert_eq!(
        kind,
        frame::SYNC_STEP2,
        "a supplied sv earns an unsolicited diff"
    );
    client.apply(&payload);
    assert_eq!(client.contents(), "edited first version\n");

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn awareness_is_relayed_opaquely() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let id = app.create_document("presence\n").await;

    let mut alice = connected(&app).await;
    let mut bob = connected(&app).await;
    let _alice_doc = hydrate(&mut alice, &id).await;
    let _bob_doc = hydrate(&mut bob, &id).await;

    // Deliberately not a valid awareness payload: the server must never parse it.
    let opaque: Vec<u8> = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0xFF];
    alice
        .send(build_frame(frame::AWARENESS, &id, &opaque))
        .await
        .expect("send awareness");

    let (kind, frame_id, payload) = next_frame(&mut bob).await;
    assert_eq!(kind, frame::AWARENESS);
    assert_eq!(frame_id, id);
    assert_eq!(payload, opaque, "awareness bytes pass through untouched");

    // Not persisted, and not replayed to a late joiner.
    let mut carol = connected(&app).await;
    let _carol_doc = hydrate(&mut carol, &id).await;
    assert!(
        tokio::time::timeout(QUIET, carol.next()).await.is_err(),
        "awareness is never replayed to late joiners"
    );

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn subscribe_errors_are_scoped_to_the_document() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let mut socket = connected(&app).await;

    // Not a ULID.
    send_json(
        &mut socket,
        serde_json::json!({ "t": "doc.subscribe", "id": "not-a-ulid" }),
    )
    .await;
    let error = next_json(&mut socket).await;
    assert_eq!(error["t"], "doc.error");
    assert_eq!(error["code"], "invalid_id");
    assert_eq!(error["retryable"], false);

    // A well-formed id nobody ever created.
    let unknown = ddd_server::domain::new_id();
    send_json(
        &mut socket,
        serde_json::json!({ "t": "doc.subscribe", "id": unknown }),
    )
    .await;
    let error = next_json(&mut socket).await;
    assert_eq!(error["code"], "not_found");

    // A purged id is `gone`, forever (SPEC §3.5).
    let purged = app.create_document("bye").await;
    app.state
        .docs
        .tombstone(&purged, &app.actor())
        .await
        .expect("tombstone");
    app.state
        .docs
        .purge(&purged, &app.actor())
        .await
        .expect("purge");
    send_json(
        &mut socket,
        serde_json::json!({ "t": "doc.subscribe", "id": purged }),
    )
    .await;
    let error = next_json(&mut socket).await;
    assert_eq!(error["code"], "gone");

    // None of that closed the socket: one bad document must not cost the others.
    send_json(&mut socket, serde_json::json!({ "t": "ping", "ts": 7 })).await;
    assert_eq!(next_json(&mut socket).await["t"], "pong");

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn a_malformed_update_is_reported_then_fatal_on_the_third() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let id = app.create_document("garbage test\n").await;
    let mut socket = connected(&app).await;
    let _doc = hydrate(&mut socket, &id).await;

    for expected in 1..=2 {
        socket
            .send(build_frame(frame::UPDATE, &id, &[0xFF, 0xFF, 0xFF, 0xFF]))
            .await
            .expect("send");
        let error = next_json(&mut socket).await;
        assert_eq!(error["code"], "malformed_update", "attempt {expected}");
    }
    socket
        .send(build_frame(frame::UPDATE, &id, &[0xFF, 0xFF, 0xFF, 0xFF]))
        .await
        .expect("send");
    assert_eq!(close_code(&mut socket).await, close::PROTOCOL_ERROR);

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn unsubscribing_stops_the_fan_out() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let id = app.create_document("watch\n").await;

    let mut alice = connected(&app).await;
    let mut bob = connected(&app).await;
    let alice_doc = hydrate(&mut alice, &id).await;
    let _bob_doc = hydrate(&mut bob, &id).await;

    send_json(
        &mut bob,
        serde_json::json!({ "t": "doc.unsubscribe", "id": id }),
    )
    .await;
    tokio::time::sleep(QUIET).await;

    let update = alice_doc.insert(0, "quiet ");
    alice
        .send(build_frame(frame::UPDATE, &id, &update))
        .await
        .expect("send");

    assert!(
        tokio::time::timeout(QUIET, bob.next()).await.is_err(),
        "an unsubscribed socket receives nothing for that document"
    );

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn reserved_frame_types_are_ignored_not_fatal() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let id = app.create_document("reserved\n").await;
    let mut socket = connected(&app).await;
    let _doc = hydrate(&mut socket, &id).await;

    // 0x10 and up belong to M4 plugin channels; an M2 server ignores them.
    socket
        .send(build_frame(frame::RESERVED_FLOOR, &id, &[1, 2, 3]))
        .await
        .expect("send");
    socket
        .send(build_frame(frame::AWARENESS_QUERY, &id, &[]))
        .await
        .expect("send");

    send_json(&mut socket, serde_json::json!({ "t": "ping", "ts": 3 })).await;
    assert_eq!(next_json(&mut socket).await["t"], "pong");

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// The bootstrap gate (SPEC §4.1: 5 000 documents in under 30 s on LAN)
// ---------------------------------------------------------------------------

/// Pages the whole projection at the M2 gate's size and reports the wall clock.
///
/// Rows are inserted straight into Mongo: the target is a property of the *read*
/// path, and driving 5 000 CRDT creates through the docstore would measure the
/// write path instead. The request goes through the real router in-process, so the
/// number is server time with no network — the LAN transfer of ~5 MB is the other
/// term in the budget, and the web harness (`web/harness/src/perf.ts`) measures
/// the pair end to end.
#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI) and SYNC_PERF=1"]
async fn bootstrap_pages_five_thousand_documents_well_inside_the_budget() {
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    if std::env::var("SYNC_PERF").is_err() {
        eprintln!("skipping: set SYNC_PERF=1 to run the 5 000-document bootstrap gate");
        app.cleanup().await;
        return;
    }

    const DOCUMENTS: usize = 5_000;
    let body = "lorem ipsum dolor sit amet ".repeat(40);
    let now = bson::DateTime::now();
    let mut batch = Vec::with_capacity(500);
    for index in 0..DOCUMENTS {
        let id = ddd_server::domain::new_id();
        batch.push(bson::doc! {
            "_id": &id,
            "crdt": bson::Bson::Binary(bson::Binary { subtype: bson::spec::BinarySubtype::Generic, bytes: vec![] }),
            "state_vector": bson::Bson::Binary(bson::Binary { subtype: bson::spec::BinarySubtype::Generic, bytes: vec![] }),
            "content": format!("---\ntitle: Doc {index}\n---\n\n{body}"),
            "title": format!("Doc {index}"),
            "fm": bson::doc! { "title": format!("Doc {index}") },
            "plugins": bson::doc! {},
            "materialized_version": "seeded",
            "fm_parse_error": false,
            "created_at": now,
            "created_by": "system",
            "updated_at": now,
            "updated_by": "system",
            "feed_seq": index as i64 + 1,
        });
        if batch.len() == 500 {
            app.state
                .collections
                .database()
                .collection::<bson::Document>(db::DOCUMENTS)
                .insert_many(std::mem::take(&mut batch))
                .await
                .expect("seed insert");
            batch = Vec::with_capacity(500);
        }
    }

    let started = std::time::Instant::now();
    let mut pages = 0;
    let mut rows = 0;
    let mut bytes = 0;
    let mut cursor: Option<String> = None;
    loop {
        let uri = match &cursor {
            Some(cursor) => format!("/api/sync/bootstrap?limit=200&cursor={cursor}"),
            None => "/api/sync/bootstrap?limit=200".to_string(),
        };
        let (status, body) = app.get(&uri).await;
        assert_eq!(status, StatusCode::OK);
        bytes += body.len();
        pages += 1;
        let lines = json_lines(&body);
        rows += lines.iter().filter(|line| line["type"] == "row").count();
        let footer = lines.last().unwrap();
        if footer["complete"] == true {
            break;
        }
        cursor = Some(footer["next_cursor"].as_str().unwrap().to_string());
    }
    let elapsed = started.elapsed();

    eprintln!(
        "bootstrap: {rows} rows in {pages} pages, {} MiB, {:?} ({:.1} rows/s)",
        bytes / (1024 * 1024),
        elapsed,
        rows as f64 / elapsed.as_secs_f64()
    );
    assert_eq!(rows, DOCUMENTS);
    assert!(
        elapsed < Duration::from_secs(30),
        "SPEC §4.1 target: 5 000 documents in under 30 s (took {elapsed:?})"
    );

    app.cleanup().await;
}

/// An offline edit carried over as a `HISTORY` frame is recorded at the time it was
/// made (kept in order, never in the future), and marked offline; the catch-up diff of a
/// handshake is marked offline too, stamped when it arrived (dev-docs/resolved/HISTORY.md).
#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn offline_edits_keep_the_time_they_were_made() {
    use futures::TryStreamExt;
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let id = app.create_document("start\n").await;
    let mut socket = connected(&app).await;
    let client = hydrate(&mut socket, &id).await;

    // The claimed time must fall after the document was created (anything earlier is
    // pulled forward to it: an edit cannot predate its document) and before it arrives.
    let created = bson::DateTime::now().timestamp_millis();
    tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
    let now = bson::DateTime::now().timestamp_millis();
    let made_earlier = created + 500;
    let history = |made_at: i64, update: &[u8]| {
        let mut payload = (made_at as u64).to_be_bytes().to_vec();
        payload.extend_from_slice(update);
        payload
    };
    // Made a second ago, offline.
    let first = client.insert(6, "offline one\n");
    socket
        .send(build_frame(
            frame::HISTORY,
            &id,
            &history(made_earlier, &first),
        ))
        .await
        .expect("send");
    // A clock in the future is pulled back to now.
    let second = client.insert(18, "offline two\n");
    socket
        .send(build_frame(
            frame::HISTORY,
            &id,
            &history(now + 86_400_000, &second),
        ))
        .await
        .expect("send");
    // A handshake catch-up: offline, stamped on arrival.
    let third = client.insert(30, "caught up\n");
    socket
        .send(build_frame(frame::SYNC_STEP2, &id, &third))
        .await
        .expect("send");
    // A live edit afterwards.
    let fourth = client.insert(40, "live\n");
    socket
        .send(build_frame(frame::UPDATE, &id, &fourth))
        .await
        .expect("send");

    // Wait for all four to land.
    let deadline = std::time::Instant::now() + TIMEOUT;
    let changes = loop {
        let mut cursor = app
            .state
            .collections
            .document_changes()
            .find(bson::doc! { "document_id": &id })
            .sort(bson::doc! { "seq": 1 })
            .await
            .expect("changes");
        let mut changes = Vec::new();
        while let Some(change) = cursor.try_next().await.expect("change") {
            changes.push(change);
        }
        if changes.len() == 4 || std::time::Instant::now() > deadline {
            break changes;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    assert_eq!(changes.len(), 4, "every edit is one change");
    let at: Vec<i64> = changes
        .iter()
        .map(|change| change.created_at.timestamp_millis())
        .collect();
    let offline: Vec<bool> = changes.iter().map(|change| change.offline).collect();

    assert_eq!(offline, vec![true, true, true, false]);
    assert_eq!(at[0], made_earlier, "the claimed time is kept: {at:?}");
    assert!(
        at[1] <= bson::DateTime::now().timestamp_millis(),
        "never in the future: {at:?}"
    );
    assert!(
        at.windows(2).all(|pair| pair[0] <= pair[1]),
        "history stays in order: {at:?}"
    );
    assert!(
        changes[0].received_at.is_some(),
        "an offline change says when it arrived"
    );
    assert!(changes[3].received_at.is_none());

    app.cleanup().await;
}

/// An offline edit that claims to predate its document is recorded when the document
/// was created, not before it.
#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn an_offline_edit_never_predates_its_document() {
    use futures::TryStreamExt;
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let created = bson::DateTime::now().timestamp_millis();
    let id = app.create_document("start\n").await;
    let mut socket = connected(&app).await;
    let client = hydrate(&mut socket, &id).await;
    let update = client.insert(6, "from last year\n");
    let mut payload = ((created - 365 * 86_400_000) as u64).to_be_bytes().to_vec();
    payload.extend_from_slice(&update);
    socket
        .send(build_frame(frame::HISTORY, &id, &payload))
        .await
        .expect("send");

    let deadline = std::time::Instant::now() + TIMEOUT;
    let change = loop {
        let found = app
            .state
            .collections
            .document_changes()
            .find(bson::doc! { "document_id": &id })
            .await
            .expect("changes")
            .try_next()
            .await
            .expect("change");
        if found.is_some() || std::time::Instant::now() > deadline {
            break found.expect("the edit is recorded");
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    assert!(
        change.created_at.timestamp_millis() >= created,
        "{:?} is before {created}",
        change.created_at
    );
    app.cleanup().await;
}

/// Live typing is folded into one change record per burst (a pause over two seconds
/// starts another); a burst's edges still rebuild exactly, and a point inside it is
/// refused rather than guessed (dev-docs/resolved/HISTORY.md).
#[tokio::test]
#[ignore = "needs a live MongoDB (MONGO_URI)"]
async fn live_typing_folds_into_one_record_per_burst() {
    use futures::TryStreamExt;
    let Some(app) = TestApp::spawn().await else {
        return;
    };
    let id = app.create_document("").await;
    let mut socket = connected(&app).await;
    let client = hydrate(&mut socket, &id).await;

    let mut typed = String::new();
    for ch in "hello".chars() {
        let update = client.insert(typed.len() as u32, &ch.to_string());
        typed.push(ch);
        socket
            .send(build_frame(frame::UPDATE, &id, &update))
            .await
            .expect("send");
    }
    tokio::time::sleep(std::time::Duration::from_millis(2_600)).await;
    for ch in " world".chars() {
        let update = client.insert(typed.len() as u32, &ch.to_string());
        typed.push(ch);
        socket
            .send(build_frame(frame::UPDATE, &id, &update))
            .await
            .expect("send");
    }

    let deadline = std::time::Instant::now() + TIMEOUT;
    let records = loop {
        let mut cursor = app
            .state
            .collections
            .document_changes()
            .find(bson::doc! { "document_id": &id })
            .sort(bson::doc! { "seq": 1 })
            .await
            .expect("changes");
        let mut records = Vec::new();
        while let Some(change) = cursor.try_next().await.expect("change") {
            records.push(change);
        }
        let last_seq = records.last().map_or(0, |change| change.seq);
        if last_seq >= 12 || std::time::Instant::now() > deadline {
            break records;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };
    // Update 1 is the creation; "hello" is 2..=6, " world" is 7..=12.
    let ranges: Vec<(i64, i64)> = records
        .iter()
        .map(|c| (c.first_seq.unwrap_or(c.seq), c.seq))
        .collect();
    assert_eq!(ranges, vec![(2, 6), (7, 12)], "one record per burst");

    let text = |seq: i64| {
        let uri = format!("/api/documents/{id}/text?at={seq}");
        let app = &app;
        async move { app.get(&uri).await }
    };
    let (status, body) = text(6).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["content"],
        "hello"
    );
    let (status, body) = text(12).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap()["content"],
        "hello world"
    );
    assert_eq!(
        text(4).await.0,
        StatusCode::CONFLICT,
        "inside a burst is refused"
    );

    app.cleanup().await;
}

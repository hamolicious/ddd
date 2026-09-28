//! The wiring store (PLUGIN-PROTOCOLS §9 step 2): every install-flow change writes a
//! wiring version, `unplugged` mirrors `PluginState`, the plugin list carries the live
//! wiring, and every connected socket hears `wiring.applied`.
//!
//! And its admin surface (§9 step 7, `routes/wiring.rs`): `GET /api/wiring` reads the live
//! version and the history, `POST /api/wiring/apply` writes a draft as version N+1 and
//! moves the plugin records its `unplugged` list implies, and a stale base is a 409 that
//! changes nothing.
//!
//! Mongo-backed like the other plugin suites, so `#[ignore]`d and skipped without
//! `MONGO_URI`:
//!
//! ```text
//! MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p life-manager-server \
//!   --test wiring_store -- --ignored
//! ```

mod common;

use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::http::{StatusCode, header};
use futures::{SinkExt, StreamExt};
use life_manager_core::wiring::Wiring;
use life_manager_server::auth;
use life_manager_server::domain::{Actor, SessionKind, User, new_id};
use life_manager_server::state::AppState;
use life_manager_server::wiring::{self, Commit, WiringError};
use life_manager_server::{plugininstall, routes, telemetry};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

const ORIGIN: &str = "http://localhost:5173";

struct Harness {
    state: AppState,
    addr: SocketAddr,
    token: String,
    user: String,
    dir: PathBuf,
}

impl Harness {
    async fn start(name: &str) -> Option<Harness> {
        let uri = common::mongo_uri()?;
        let dir =
            Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("wiring-{name}-{}", new_id()));
        fs::create_dir_all(dir.join("served")).ok()?;
        let mut config = common::test_config(uri, format!("lm_wiring_test_{}", new_id()));
        config.plugins_dir = dir.join("served");
        config.plugin_staging_dir = dir.join("staging");
        for id in ["alpha", "beta"] {
            let root = dir.join("served").join(id).join("1.0.0");
            fs::create_dir_all(root.join("frontend")).ok()?;
            fs::write(
                root.join("manifest.json"),
                format!(
                    r#"{{"id":"{id}","version":"1.0.0","kernel":"^2.0","frontend":{{"module":"frontend/index.mjs"}}}}"#
                ),
            )
            .ok()?;
            fs::write(
                root.join("frontend/index.mjs"),
                "export default function activate() {}\n",
            )
            .ok()?;
        }

        let state = AppState::new(config.clone()).await.ok()?;
        state.init_schema().await.ok()?;
        plugininstall::adopt_installed_directory(&state)
            .await
            .ok()?;
        wiring::load(&state).await;

        let user = User {
            id: new_id(),
            email: format!("wiring-{}@example.test", new_id().to_lowercase()),
            name: "Wiring Test".to_string(),
            password_hash: auth::password::hash("correct-horse-battery").ok()?,
            is_admin: true,
            is_active: true,
            created_at: bson::DateTime::now(),
            updated_at: bson::DateTime::now(),
            last_login_at: None,
            invited_by: None,
        };
        state.collections.users().insert_one(&user).await.ok()?;
        let (_session, token) =
            auth::create_session(&state, &user, SessionKind::Bearer, None, None)
                .await
                .ok()?;

        let metrics = telemetry::init_metrics(&config).ok()?;
        let router = routes::router(state.clone(), metrics);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.ok()?;
        let addr = listener.local_addr().ok()?;
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        Some(Harness {
            state,
            addr,
            token,
            user: user.id,
            dir,
        })
    }

    fn actor(&self) -> Actor {
        Actor::User(self.user.clone())
    }

    async fn connect(&self) -> Socket {
        let mut request = format!("ws://{}/api/sync", self.addr)
            .into_client_request()
            .expect("request");
        let headers = request.headers_mut();
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            "life-manager.v1".parse().unwrap(),
        );
        headers.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", self.token).parse().unwrap(),
        );
        headers.insert(header::ORIGIN, ORIGIN.parse().unwrap());
        tokio_tungstenite::connect_async(request)
            .await
            .expect("socket connects")
            .0
    }

    /// A second, non-admin session on the same server.
    async fn non_admin_token(&self) -> String {
        let user = User {
            id: new_id(),
            email: format!("member-{}@example.test", new_id().to_lowercase()),
            name: "Wiring Member".to_string(),
            password_hash: auth::password::hash("correct-horse-battery").expect("hash"),
            is_admin: false,
            is_active: true,
            created_at: bson::DateTime::now(),
            updated_at: bson::DateTime::now(),
            last_login_at: None,
            invited_by: None,
        };
        self.state
            .collections
            .users()
            .insert_one(&user)
            .await
            .expect("member");
        auth::create_session(&self.state, &user, SessionKind::Bearer, None, None)
            .await
            .expect("session")
            .1
    }

    async fn get(&self, path: &str, token: &str) -> (StatusCode, serde_json::Value) {
        let response = reqwest::Client::new()
            .get(format!("http://{}{path}", self.addr))
            .bearer_auth(token)
            .send()
            .await
            .expect("request");
        let status = StatusCode::from_u16(response.status().as_u16()).expect("status");
        let body = response.bytes().await.expect("body");
        assert!(
            !String::from_utf8_lossy(&body).contains("$date"),
            "extended JSON on the wire: {}",
            String::from_utf8_lossy(&body)
        );
        (status, serde_json::from_slice(&body).expect("json"))
    }

    async fn post_json(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let response = reqwest::Client::new()
            .post(format!("http://{}{path}", self.addr))
            .bearer_auth(&self.token)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send()
            .await
            .expect("request");
        let status = StatusCode::from_u16(response.status().as_u16()).expect("status");
        let body = response.bytes().await.expect("body");
        // A body axum's `Json` extractor refused is plain text, not the error envelope.
        let json = serde_json::from_slice(&body)
            .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(&body).into()));
        (status, json)
    }

    /// `GET /api/admin/plugins`, as `{ id: view }`.
    async fn admin_plugins(&self) -> serde_json::Map<String, serde_json::Value> {
        let (status, body) = self.get("/api/admin/plugins", &self.token).await;
        assert_eq!(status, StatusCode::OK);
        body["plugins"]
            .as_array()
            .expect("plugins")
            .iter()
            .map(|view| (view["id"].as_str().expect("id").to_string(), view.clone()))
            .collect()
    }

    async fn plugin_list(&self) -> serde_json::Value {
        let url = format!("http://{}/api/plugins", self.addr);
        let body = reqwest::Client::new()
            .get(url)
            .bearer_auth(&self.token)
            .send()
            .await
            .expect("plugin list")
            .bytes()
            .await
            .expect("body");
        serde_json::from_slice(&body).expect("json")
    }

    async fn cleanup(self) {
        let _ = self.state.db.drop().await;
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// The next JSON frame whose `t` is `kind`, skipping everything else (feed batches).
async fn next_of(socket: &mut Socket, kind: &str) -> serde_json::Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let message = tokio::time::timeout_at(deadline, socket.next())
            .await
            .unwrap_or_else(|_| panic!("no `{kind}` frame within 5 s"))
            .expect("socket open")
            .expect("frame");
        if let Message::Text(text) = message {
            let value: serde_json::Value = serde_json::from_str(&text).expect("json");
            if value["t"] == kind {
                return value;
            }
        }
    }
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn disabling_a_plugin_writes_a_version_every_socket_hears() {
    let Some(harness) = Harness::start("disable").await else {
        return;
    };

    let mut first = harness.connect().await;
    let mut second = harness.connect().await;
    for socket in [&mut first, &mut second] {
        let welcome = next_of(socket, "welcome").await;
        assert_eq!(
            welcome["wiring_version"], 0,
            "a fresh workspace is at version 0"
        );
    }

    plugininstall::disable(&harness.state, "alpha", "admin", &harness.actor())
        .await
        .expect("disables");

    for socket in [&mut first, &mut second] {
        let frame = next_of(socket, "wiring.applied").await;
        assert_eq!(frame["version"], 1);
        assert_eq!(frame["action"], "disable");
    }

    let list = harness.plugin_list().await;
    assert_eq!(list["wiring"]["version"], 1);
    assert_eq!(list["wiring"]["unplugged"], serde_json::json!(["alpha"]));

    // Plugging it back in is a version too, and `unplugged` follows the record.
    plugininstall::enable(&harness.state, "alpha", &harness.actor())
        .await
        .expect("enables");
    let frame = next_of(&mut first, "wiring.applied").await;
    assert_eq!(frame["version"], 2);
    assert_eq!(frame["action"], "enable");
    assert_eq!(
        wiring::current(&harness.state).wiring.unplugged,
        Vec::<String>::new()
    );

    // A reconnecting client learns the live version from `welcome`.
    let mut third = harness.connect().await;
    assert_eq!(next_of(&mut third, "welcome").await["wiring_version"], 2);

    // The history and the audit trail both have it.
    let history = wiring::history(&harness.state, 10).await.expect("history");
    let actions: Vec<&str> = history.iter().map(|entry| entry.action.as_str()).collect();
    assert_eq!(actions, vec!["enable", "disable"]);
    let audited = harness
        .state
        .collections
        .audit_log()
        .count_documents(bson::doc! { "action": { "$in": ["wiring.disable", "wiring.enable"] } })
        .await
        .expect("audit");
    assert_eq!(audited, 2);

    let _ = first.close(None).await;
    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_draft_based_on_an_old_version_is_refused() {
    let Some(harness) = Harness::start("conflict").await else {
        return;
    };
    let actor = harness.actor();
    let applied = wiring::commit(
        &harness.state,
        Commit {
            base: Some(0),
            wiring: Wiring {
                cut: vec!["alpha:pill -> beta:items".into()],
                ..Wiring::default()
            },
            action: "apply",
            actor: &actor,
            subject: None,
        },
    )
    .await
    .expect("applies on top of version 0");
    assert_eq!(applied.version, 1);

    let stale = wiring::commit(
        &harness.state,
        Commit {
            base: Some(0),
            wiring: Wiring::default(),
            action: "apply",
            actor: &actor,
            subject: None,
        },
    )
    .await;
    assert!(matches!(
        stale,
        Err(WiringError::Conflict { base: 0, live: 1 })
    ));

    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn uninstall_forgets_the_plugin_and_the_cache_survives_mongo() {
    let Some(harness) = Harness::start("uninstall").await else {
        return;
    };
    let actor = harness.actor();
    wiring::commit(
        &harness.state,
        Commit {
            base: Some(0),
            wiring: Wiring {
                add: vec!["beta:panel -> alpha:sidebar".into()],
                order: [("alpha:sidebar".to_string(), vec!["beta:panel".to_string()])].into(),
                ..Wiring::default()
            },
            action: "apply",
            actor: &actor,
            subject: None,
        },
    )
    .await
    .expect("applies");

    plugininstall::uninstall(&harness.state, "beta", false, &actor)
        .await
        .expect("uninstalls");
    let live = wiring::current(&harness.state);
    assert_eq!(live.version, 2);
    assert!(live.wiring.add.is_empty());
    assert!(live.wiring.order.is_empty());

    // The disk cache is what the plugin list falls back to when Mongo is gone.
    let cached: serde_json::Value = serde_json::from_slice(
        &fs::read(
            harness
                .state
                .config
                .plugin_staging_dir
                .join(wiring::CACHE_FILE),
        )
        .expect("cache file"),
    )
    .expect("json");
    assert_eq!(cached["version"], 2);

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// The admin routes (step 7)
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn the_wiring_routes_are_admin_only_and_read_the_live_version() {
    let Some(harness) = Harness::start("routes-read").await else {
        return;
    };
    let member = harness.non_admin_token().await;

    let (status, body) = harness.get("/api/wiring", &member).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "forbidden");
    let (status, _) = harness.get("/api/wiring/versions/1", &member).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Fresh workspace: version 0, nothing stored yet.
    let (status, body) = harness.get("/api/wiring", &harness.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["live"]["version"], 0);
    assert_eq!(body["live"]["unplugged"], serde_json::json!([]));
    assert_eq!(body["history"], serde_json::json!([]));

    // Three versions through the store, then the history is newest first and capped.
    let actor = harness.actor();
    for n in 1..=3 {
        wiring::commit(
            &harness.state,
            Commit {
                base: Some(n - 1),
                wiring: Wiring {
                    cut: vec![format!("alpha:pill{n} -> beta:items")],
                    ..Wiring::default()
                },
                action: "apply",
                actor: &actor,
                subject: None,
            },
        )
        .await
        .expect("commits");
    }
    let (status, body) = harness.get("/api/wiring", &harness.token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["live"]["version"], 3);
    assert_eq!(
        body["live"]["cut"],
        serde_json::json!(["alpha:pill3 -> beta:items"])
    );
    let versions: Vec<i64> = body["history"]
        .as_array()
        .expect("history")
        .iter()
        .map(|entry| entry["version"].as_i64().expect("version"))
        .collect();
    assert_eq!(versions, vec![3, 2, 1]);
    assert_eq!(body["history"][0]["action"], "apply");
    assert_eq!(body["history"][0]["actor"], actor.as_stored());
    assert!(body["history"][0]["at"].is_string());
    assert!(
        body["history"][0].get("wiring").is_none(),
        "history carries no wirings"
    );

    let (_, body) = harness.get("/api/wiring?limit=2", &harness.token).await;
    assert_eq!(body["history"].as_array().expect("history").len(), 2);

    // One version, with its wiring; an unknown one is 404.
    let (status, body) = harness.get("/api/wiring/versions/2", &harness.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["version"], 2);
    assert_eq!(body["action"], "apply");
    assert_eq!(
        body["wiring"]["cut"],
        serde_json::json!(["alpha:pill2 -> beta:items"])
    );
    assert!(body["at"].is_string());
    let (status, body) = harness.get("/api/wiring/versions/99", &harness.token).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found");

    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn apply_writes_a_version_and_moves_the_records_it_unplugs() {
    let Some(harness) = Harness::start("routes-apply").await else {
        return;
    };
    let mut socket = harness.connect().await;
    assert_eq!(next_of(&mut socket, "welcome").await["wiring_version"], 0);

    // Unplug alpha (and pin a plugin that is not installed) on top of version 0.
    let (status, body) = harness
        .post_json(
            "/api/wiring/apply",
            serde_json::json!({
                "base": 0,
                "wiring": { "unplugged": ["ghost", "alpha"], "cut": ["alpha:pill -> beta:items"] },
                "action": "apply"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["live"]["version"], 1);
    assert_eq!(
        body["live"]["unplugged"],
        serde_json::json!(["alpha", "ghost"])
    );
    let frame = next_of(&mut socket, "wiring.applied").await;
    assert_eq!(frame["version"], 1);
    assert_eq!(frame["action"], "apply");

    let plugins = harness.admin_plugins().await;
    assert_eq!(plugins["alpha"]["state"], "disabled");
    assert_eq!(plugins["alpha"]["breaker"]["by_admin"], true);
    assert_eq!(plugins["beta"]["state"], "enabled");
    let record = plugininstall::record(&harness.state, "alpha")
        .await
        .expect("reads")
        .expect("alpha");
    assert_eq!(record.disabled_reason.as_deref(), Some("admin"));

    // Exactly one version was written: the apply is the version, the record move is not
    // a second one.
    let history = wiring::history(&harness.state, 10).await.expect("history");
    assert_eq!(history.len(), 1);
    assert_eq!(wiring::current(&harness.state).version, 1);

    // Plug it back in.
    let (status, body) = harness
        .post_json(
            "/api/wiring/apply",
            serde_json::json!({
                "base": 1,
                "wiring": { "unplugged": ["ghost"], "cut": ["alpha:pill -> beta:items"] },
                "action": "apply"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["live"]["version"], 2);
    assert_eq!(next_of(&mut socket, "wiring.applied").await["version"], 2);
    let plugins = harness.admin_plugins().await;
    assert_eq!(plugins["alpha"]["state"], "enabled");
    assert_eq!(plugins["alpha"]["breaker"]["by_admin"], false);
    assert_eq!(
        wiring::history(&harness.state, 10)
            .await
            .expect("history")
            .len(),
        2
    );

    // A stale base is refused and changes nothing.
    let (status, body) = harness
        .post_json(
            "/api/wiring/apply",
            serde_json::json!({
                "base": 0,
                "wiring": { "unplugged": ["beta"] },
                "action": "apply"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "conflict");
    assert_eq!(wiring::current(&harness.state).version, 2);
    assert_eq!(harness.admin_plugins().await["beta"]["state"], "enabled");

    // An unknown action is a bad request, before anything is written.
    let (status, body) = harness
        .post_json(
            "/api/wiring/apply",
            serde_json::json!({ "base": 2, "wiring": {}, "action": "install" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "bad_request");
    assert_eq!(wiring::current(&harness.state).version, 2);

    // Rollback: version 1's wiring applied again, recorded as `rollback`, and alpha is
    // unplugged again by it.
    let (_, version_one) = harness.get("/api/wiring/versions/1", &harness.token).await;
    let (status, body) = harness
        .post_json(
            "/api/wiring/apply",
            serde_json::json!({
                "base": 2,
                "wiring": version_one["wiring"],
                "action": "rollback"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["live"]["version"], 3);
    assert_eq!(
        body["live"]["unplugged"],
        serde_json::json!(["alpha", "ghost"])
    );
    let frame = next_of(&mut socket, "wiring.applied").await;
    assert_eq!(frame["version"], 3);
    assert_eq!(frame["action"], "rollback");
    assert_eq!(harness.admin_plugins().await["alpha"]["state"], "disabled");

    let (status, body) = harness.get("/api/wiring/versions/3", &harness.token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["action"], "rollback");
    assert_eq!(body["actor"], harness.actor().as_stored());
    assert_eq!(body["wiring"], version_one["wiring"]);

    let (_, body) = harness.get("/api/wiring", &harness.token).await;
    let actions: Vec<&str> = body["history"]
        .as_array()
        .expect("history")
        .iter()
        .map(|entry| entry["action"].as_str().expect("action"))
        .collect();
    assert_eq!(actions, vec!["rollback", "apply", "apply"]);

    // The audit trail is the store's, once per version.
    let audited = harness
        .state
        .collections
        .audit_log()
        .count_documents(bson::doc! { "action": { "$in": ["wiring.apply", "wiring.rollback"] } })
        .await
        .expect("audit");
    assert_eq!(audited, 3);

    let _ = socket.close(None).await;
    harness.cleanup().await;
}

/// Keeps `SinkExt` in use for the close above on toolchains that lint unused imports in
/// test binaries differently.
#[allow(dead_code)]
async fn close(socket: &mut Socket) {
    let _ = socket.send(Message::Close(None)).await;
}

//! The wiring store (PLUGIN-PROTOCOLS §9 step 2): every install-flow change writes a
//! wiring version, `unplugged` mirrors `PluginState`, the plugin list carries the live
//! wiring, and every connected socket hears `wiring.applied`.
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

use axum::http::header;
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
                    r#"{{"id":"{id}","version":"1.0.0","kernel":"^1.0","frontend":{{"module":"frontend/index.mjs"}}}}"#
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

/// Keeps `SinkExt` in use for the close above on toolchains that lint unused imports in
/// test binaries differently.
#[allow(dead_code)]
async fn close(socket: &mut Socket) {
    let _ = socket.send(Message::Close(None)).await;
}

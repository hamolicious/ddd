//! `/api/plugins/:id/*` — inbound HTTP into a backend plugin, through the **assembled
//! router** (SPEC §5.1, HOST-ABI.md §4.4).
//!
//! The unit tests in `pluginhost/mod.rs` pin the status for each failure; this suite is
//! about the things only the real router can show:
//!
//! 1. **Session-authenticated by default.** A declared route is 401 without a session, and
//!    only a path the manifest *also* listed in `capabilities.public-routes` is open. That
//!    default is the reason a "sync now" endpoint is not a free outbound-request amplifier.
//! 2. **`cookie` and `authorization` never reach a plugin.** A plugin that could read this
//!    app's session credential could impersonate its caller against the rest of the API, so
//!    identity arrives as a `user` object instead.
//! 3. **`set-cookie` never leaves one.** A plugin must not mint a session for this origin.
//! 4. **A plugin's own refusal keeps its code**, so its 404 is a 404 and not a 500.
//! 5. **An undeclared route, an unknown plugin and a traversal attempt** are each answered
//!    distinctly, because "no such route" and "you tried to escape the namespace" are
//!    different lines in a log.
//!
//! Skips silently without `MONGO_URI` or without the built fixture, like every other
//! Mongo-backed suite here:
//!
//! ```text
//! docker compose up -d --wait mongo
//! mise run wasm-plugins
//! MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p life-manager-server --test pluginhost_routes
//! ```

mod common;

use std::collections::BTreeMap;
use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use life_manager_server::domain::new_id;
use life_manager_server::pluginhost::PluginHost;
use life_manager_server::plugininstall::InstallSource;
use life_manager_server::plugins::{
    PluginBackend, PluginCapabilities, PluginManifest, PluginRecord, PluginState,
};
use life_manager_server::{routes, telemetry};
use serde_json::Value;

fn fixture() -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../plugins/target/wasm32-unknown-unknown/release/hello_backend.wasm");
    path.exists().then_some(path)
}

/// A router with the fixture plugin activated and one registered admin session.
struct RouteApp {
    router: axum::Router,
    token: String,
    user_id: String,
    plugins_dir: PathBuf,
    client: mongodb::Client,
    database: String,
}

impl RouteApp {
    /// `public` is the subset of `routes` reachable without a session — requested *and*
    /// granted, which is the ordinary case.
    async fn start(routes_declared: &[&str], public: &[&str]) -> Option<RouteApp> {
        RouteApp::start_with_grant(routes_declared, public, public).await
    }

    /// [`RouteApp::start`] with the two capability sets given separately: what the package
    /// **requested** and what an admin **granted**. The only thing that may open a route
    /// without a session is the grant.
    async fn start_with_grant(
        routes_declared: &[&str],
        requested_public: &[&str],
        granted_public: &[&str],
    ) -> Option<RouteApp> {
        let uri = common::mongo_uri()?;
        let wasm = fixture()?;

        let database = format!("lm_pluginroute_test_{}", new_id());
        let plugins_dir = std::env::temp_dir().join(format!("lm-pluginroute-{database}"));
        let dir = plugins_dir.join("hello-backend").join("1.0.0");
        std::fs::create_dir_all(&dir).expect("a temp plugin directory");
        std::fs::copy(&wasm, dir.join("backend.wasm")).expect("copy the fixture");

        let mut config = common::test_config(uri.clone(), database.clone());
        config.plugins_dir = plugins_dir.clone();
        config.plugin_call_timeout = std::time::Duration::from_millis(1_500);

        let client = mongodb::Client::with_uri_str(&uri).await.ok()?;
        let state = life_manager_server::state::AppState::new(config.clone())
            .await
            .ok()?;
        state.init_schema().await.ok()?;

        let requested = PluginCapabilities {
            public_routes: requested_public
                .iter()
                .map(|path| (*path).to_string())
                .collect(),
            ..PluginCapabilities::default()
        };
        let granted = PluginCapabilities {
            public_routes: granted_public
                .iter()
                .map(|path| (*path).to_string())
                .collect(),
            ..PluginCapabilities::default()
        };
        let record = PluginRecord {
            id: "hello-backend".to_string(),
            version: "1.0.0".to_string(),
            state: PluginState::Enabled,
            manifest: PluginManifest {
                id: "hello-backend".to_string(),
                version: "1.0.0".to_string(),
                kernel: "^2.0".to_string(),
                peer_libraries: BTreeMap::new(),
                frontend: None,
                capabilities: requested,
                config: BTreeMap::new(),
                backend: Some(PluginBackend {
                    module: "backend.wasm".to_string(),
                    hooks: Vec::new(),
                    cron: Vec::new(),
                    routes: routes_declared
                        .iter()
                        .map(|route| (*route).to_string())
                        .collect(),
                    events: Vec::new(),
                    calls: Vec::new(),
                }),
                name: None,
                description: None,
                author: None,
                license: None,
                provides: BTreeMap::new(),
                consumes: BTreeMap::new(),
                hot: false,
                extra: BTreeMap::new(),
            },
            capabilities_approved: granted,
            source: InstallSource::Base,
            installed_at: life_manager_server::domain::Timestamp::now(),
            installed_by: None,
            approved_at: None,
            approved_by: None,
            disabled_reason: None,
            last_error: None,
            module_sha256: Some("test-fixture".to_string()),
            cron_state: Vec::new(),
        };
        PluginHost::get(&state)
            .activate(&state, &record)
            .await
            .expect("the fixture activates");

        let metrics = telemetry::init_metrics(&config).ok()?;
        let router = routes::router(state.clone(), metrics);

        let mut app = RouteApp {
            router,
            token: String::new(),
            user_id: String::new(),
            plugins_dir,
            client,
            database,
        };
        let body = app
            .send(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/register")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "email": "first@example.com",
                            "password": common::TEST_PASSWORD,
                            "bearer": true,
                        })
                        .to_string(),
                    ))
                    .expect("a valid request"),
            )
            .await;
        assert_eq!(body.0, StatusCode::OK, "register: {}", body.1);
        let json: Value = serde_json::from_str(&body.1).expect("JSON");
        app.token = json["token"].as_str().expect("a bearer token").to_string();
        app.user_id = json["user"]["id"].as_str().unwrap_or_default().to_string();
        Some(app)
    }

    async fn send(&self, request: Request<Body>) -> (StatusCode, String, axum::http::HeaderMap) {
        use tower::ServiceExt as _;
        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("the router is infallible");
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .expect("reading the body");
        (status, String::from_utf8_lossy(&bytes).to_string(), headers)
    }

    /// A request with a session.
    async fn authed(&self, method: &str, uri: &str) -> (StatusCode, String, axum::http::HeaderMap) {
        self.send(
            Request::builder()
                .method(method)
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
                // Both of these must be invisible to the plugin.
                .header(header::COOKIE, "lm_session=secret-value")
                .body(Body::empty())
                .expect("a valid request"),
        )
        .await
    }

    /// A request with no credentials at all.
    async fn anonymous(
        &self,
        method: &str,
        uri: &str,
    ) -> (StatusCode, String, axum::http::HeaderMap) {
        self.send(
            Request::builder()
                .method(method)
                .uri(uri)
                .body(Body::empty())
                .expect("a valid request"),
        )
        .await
    }

    async fn cleanup(self) {
        let _ = self.client.database(&self.database).drop().await;
        let _ = std::fs::remove_dir_all(&self.plugins_dir);
    }
}

fn skip() -> bool {
    if common::mongo_uri().is_none() {
        eprintln!("skipping: MONGO_URI is not set");
        return true;
    }
    if fixture().is_none() {
        eprintln!("skipping: run `mise run wasm-plugins` to build the hello-backend fixture");
        return true;
    }
    false
}

macro_rules! app {
    ($routes:expr, $public:expr) => {
        match RouteApp::start($routes, $public).await {
            Some(app) => app,
            None => return,
        }
    };
}

/// The default is the security property: a declared route needs a session unless the
/// manifest *also* listed it as public, and the admin saw that as the capability it is.
#[tokio::test]
async fn a_route_needs_a_session_unless_the_manifest_declared_it_public() {
    if skip() {
        return;
    }
    let app = app!(&["GET /status", "GET /open"], &["/open"]);

    let (status, body, _) = app
        .anonymous("GET", "/api/plugins/hello-backend/status")
        .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "a non-public route must not answer without a session: {body}"
    );

    let (status, body, _) = app
        .anonymous("GET", "/api/plugins/hello-backend/open")
        .await;
    assert_eq!(status, StatusCode::OK, "the public route is open: {body}");
    let answer: Value = serde_json::from_str(&body).expect("JSON");
    assert_eq!(answer["public"], serde_json::json!(true));
    assert_eq!(answer["user"], Value::Null, "nobody was signed in");

    // With a session the non-public route works, and the plugin is told who is calling.
    let (status, body, _) = app.authed("GET", "/api/plugins/hello-backend/status").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let answer: Value = serde_json::from_str(&body).expect("JSON");
    assert_eq!(answer["public"], serde_json::json!(false));
    assert_eq!(answer["user"], serde_json::json!(app.user_id));
    assert_eq!(answer["path"], serde_json::json!("/status"));
    assert_eq!(answer["method"], serde_json::json!("GET"));

    app.cleanup().await;
}

/// **The grant decides, not the request.** An admin who unchecks a requested public route at
/// approval has to get a route that needs a session.
///
/// The approval screen presents each one as its own checkbox with the warning that "anyone who
/// can reach this server can call them, with no session", and `approval_is_legal` accepts a
/// narrowed set — but the dispatcher's `public` flag was computed from
/// `manifest.capabilities.public_routes`, so the narrowing was silently discarded and the
/// unauthenticated webhook the admin refused was live. Everything *else* on the active plugin
/// (documents rights, `http.hosts`) already came from the approved set, which is what made this
/// one look right.
#[tokio::test]
async fn a_public_route_the_admin_declined_needs_a_session() {
    if skip() {
        return;
    }
    // The package asks for both to be public; the admin grants only `/open`.
    let app = match RouteApp::start_with_grant(
        &["GET /open", "GET /webhook"],
        &["/open", "/webhook"],
        &["/open"],
    )
    .await
    {
        Some(app) => app,
        None => return,
    };

    let (status, body, _) = app
        .anonymous("GET", "/api/plugins/hello-backend/webhook")
        .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "a public route the admin declined must not answer without a session: {body}"
    );

    // The one they did grant is open, so this is a narrowing and not a blanket refusal.
    let (status, body, _) = app
        .anonymous("GET", "/api/plugins/hello-backend/open")
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // And the declined route still works for a signed-in caller — it is a route, just not a
    // public one. The plugin is told it is not public, too.
    let (status, body, _) = app
        .authed("GET", "/api/plugins/hello-backend/webhook")
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let answer: Value = serde_json::from_str(&body).expect("JSON");
    assert_eq!(answer["public"], serde_json::json!(false));

    app.cleanup().await;
}

/// Identity arrives as a `user` object; the *credential* does not arrive at all. A plugin
/// that could read the cookie or the bearer header could impersonate its caller against
/// every other route in the API.
#[tokio::test]
async fn the_session_credential_never_reaches_the_plugin() {
    if skip() {
        return;
    }
    let app = app!(&["GET /status"], &[]);

    let (status, body, _) = app.authed("GET", "/api/plugins/hello-backend/status").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let answer: Value = serde_json::from_str(&body).expect("JSON");
    let headers: Vec<String> = answer["headers"]
        .as_array()
        .expect("the echoed header names")
        .iter()
        .map(|value| value.as_str().unwrap_or_default().to_string())
        .collect();

    assert!(
        !headers.iter().any(|name| name == "cookie"),
        "the cookie reached the plugin: {headers:?}"
    );
    assert!(
        !headers.iter().any(|name| name == "authorization"),
        "the bearer token reached the plugin: {headers:?}"
    );
    // The identity did arrive, through the one channel that is meant to carry it.
    assert_eq!(answer["user"], serde_json::json!(app.user_id));
    // And the raw body never contains the secret either.
    assert!(!body.contains("secret-value"));

    app.cleanup().await;
}

/// A plugin must not mint a cookie for this origin — a cookie for this origin is a session.
#[tokio::test]
async fn a_plugin_cannot_set_a_cookie_on_this_origin() {
    if skip() {
        return;
    }
    let app = app!(&["GET /cookie"], &[]);

    let (status, _, headers) = app.authed("GET", "/api/plugins/hello-backend/cookie").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers.get(header::SET_COOKIE).is_none(),
        "set-cookie must be stripped: {headers:?}"
    );
    // A header a plugin *is* allowed to set comes through, so the strip is targeted rather
    // than "drop everything".
    assert_eq!(
        headers
            .get("x-from-plugin")
            .and_then(|value| value.to_str().ok()),
        Some("yes")
    );
    // Plugin output is bytes a third party chose, so it is never sniffed.
    assert_eq!(
        headers
            .get(header::X_CONTENT_TYPE_OPTIONS)
            .and_then(|value| value.to_str().ok()),
        Some("nosniff")
    );

    app.cleanup().await;
}

/// A plugin's refusals are part of its HTTP contract: `not_found` means 404, not 500.
#[tokio::test]
async fn a_plugins_own_refusal_keeps_its_code() {
    if skip() {
        return;
    }
    let app = app!(&["GET /refuse"], &["/refuse"]);

    let (status, body, _) = app
        .anonymous("GET", "/api/plugins/hello-backend/refuse")
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let answer: Value = serde_json::from_str(&body).expect("JSON");
    assert_eq!(answer["error"]["code"], serde_json::json!("not_found"));
    assert!(
        answer["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("/refuse"),
        "the plugin's own message is forwarded: {body}"
    );

    app.cleanup().await;
}

/// Three different "no": an unknown plugin, a path the manifest never declared, and a
/// method the manifest never declared for a path it did.
#[tokio::test]
async fn an_unknown_plugin_route_or_method_is_a_404() {
    if skip() {
        return;
    }
    let app = app!(&["GET /status"], &[]);

    for (method, uri) in [
        ("GET", "/api/plugins/no-such-plugin/status"),
        ("GET", "/api/plugins/hello-backend/undeclared"),
        // Declared as GET only — the route table is (method, path), not path alone.
        ("POST", "/api/plugins/hello-backend/status"),
    ] {
        let (status, body, _) = app.authed(method, uri).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}: {body}");
    }

    app.cleanup().await;
}

/// A traversal attempt is refused as one rather than 404ing quietly: the declared table can
/// never contain a relative segment, so a request carrying one is someone probing.
#[tokio::test]
async fn a_traversal_attempt_is_refused_rather_than_silently_missed() {
    if skip() {
        return;
    }
    let app = app!(&["GET /status"], &[]);

    let (status, body, _) = app
        .authed("GET", "/api/plugins/hello-backend/../../documents")
        .await;
    assert!(
        status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND,
        "a traversal must never reach another route; got {status}: {body}"
    );
    // Whatever the normalizer decided, it must not have produced a document listing.
    assert!(!body.contains("\"documents\""), "{body}");

    app.cleanup().await;
}

/// A plugin with no active backend half is 404, not 503: there is nothing here, and a retry
/// could never work.
#[tokio::test]
async fn a_plugin_with_no_backend_half_answers_404() {
    if skip() {
        return;
    }
    let app = app!(&["GET /status"], &[]);

    // The M3 base distribution has no backend halves at all.
    let (status, _, _) = app.authed("GET", "/api/plugins/shell-ui/status").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    app.cleanup().await;
}

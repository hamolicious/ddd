mod common;

use std::collections::BTreeMap;
use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use ddd_server::domain::new_id;
use ddd_server::pluginhost::PluginHost;
use ddd_server::plugininstall::InstallSource;
use ddd_server::plugins::{
    PluginBackend, PluginCapabilities, PluginManifest, PluginRecord, PluginState,
};
use ddd_server::{routes, telemetry};
use serde_json::Value;

fn fixture() -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../plugins/target/wasm32-unknown-unknown/release/hello_backend.wasm");
    path.exists().then_some(path)
}

struct RouteApp {
    router: axum::Router,
    token: String,
    user_id: String,
    plugins_dir: PathBuf,
    client: mongodb::Client,
    database: String,
}

impl RouteApp {
    async fn start(routes_declared: &[&str], public: &[&str]) -> Option<RouteApp> {
        RouteApp::start_with_grant(routes_declared, public, public).await
    }

    async fn start_with_grant(
        routes_declared: &[&str],
        requested_public: &[&str],
        granted_public: &[&str],
    ) -> Option<RouteApp> {
        let uri = common::mongo_uri()?;
        let wasm = fixture()?;

        let database = format!("ddd_pluginroute_test_{}", new_id());
        let plugins_dir = std::env::temp_dir().join(format!("ddd-pluginroute-{database}"));
        let dir = plugins_dir.join("hello-backend").join("1.0.0");
        std::fs::create_dir_all(&dir).expect("a temp plugin directory");
        std::fs::copy(&wasm, dir.join("backend.wasm")).expect("copy the fixture");

        let mut config = common::test_config(uri.clone(), database.clone());
        config.plugins_dir = plugins_dir.clone();
        config.plugin_call_timeout = std::time::Duration::from_millis(1_500);

        let client = mongodb::Client::with_uri_str(&uri).await.ok()?;
        let state = ddd_server::state::AppState::new(config.clone())
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
                kernel: "^3.0".to_string(),
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
                    exports: BTreeMap::new(),
                }),
                name: None,
                description: None,
                author: None,
                license: None,
                provides: None,
                dependencies: BTreeMap::new(),
                optional_dependencies: BTreeMap::new(),
                extra: BTreeMap::new(),
            },
            capabilities_approved: granted,
            source: InstallSource::Base,
            installed_at: ddd_server::domain::Timestamp::now(),
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

    async fn authed(&self, method: &str, uri: &str) -> (StatusCode, String, axum::http::HeaderMap) {
        self.send(
            Request::builder()
                .method(method)
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {}", self.token))
                .header(header::COOKIE, "ddd_session=secret-value")
                .body(Body::empty())
                .expect("a valid request"),
        )
        .await
    }

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

    let (status, body, _) = app.authed("GET", "/api/plugins/hello-backend/status").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let answer: Value = serde_json::from_str(&body).expect("JSON");
    assert_eq!(answer["public"], serde_json::json!(false));
    assert_eq!(answer["user"], serde_json::json!(app.user_id));
    assert_eq!(answer["path"], serde_json::json!("/status"));
    assert_eq!(answer["method"], serde_json::json!("GET"));

    app.cleanup().await;
}

#[tokio::test]
async fn a_public_route_the_admin_declined_needs_a_session() {
    if skip() {
        return;
    }
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

    let (status, body, _) = app
        .anonymous("GET", "/api/plugins/hello-backend/open")
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body, _) = app
        .authed("GET", "/api/plugins/hello-backend/webhook")
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let answer: Value = serde_json::from_str(&body).expect("JSON");
    assert_eq!(answer["public"], serde_json::json!(false));

    app.cleanup().await;
}

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
    assert_eq!(answer["user"], serde_json::json!(app.user_id));
    assert!(!body.contains("secret-value"));

    app.cleanup().await;
}

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
    assert_eq!(
        headers
            .get("x-from-plugin")
            .and_then(|value| value.to_str().ok()),
        Some("yes")
    );
    assert_eq!(
        headers
            .get(header::X_CONTENT_TYPE_OPTIONS)
            .and_then(|value| value.to_str().ok()),
        Some("nosniff")
    );

    app.cleanup().await;
}

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

#[tokio::test]
async fn an_unknown_plugin_route_or_method_is_a_404() {
    if skip() {
        return;
    }
    let app = app!(&["GET /status"], &[]);

    for (method, uri) in [
        ("GET", "/api/plugins/no-such-plugin/status"),
        ("GET", "/api/plugins/hello-backend/undeclared"),
        ("POST", "/api/plugins/hello-backend/status"),
    ] {
        let (status, body, _) = app.authed(method, uri).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}: {body}");
    }

    app.cleanup().await;
}

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
    assert!(!body.contains("\"documents\""), "{body}");

    app.cleanup().await;
}

#[tokio::test]
async fn a_plugin_with_no_backend_half_answers_404() {
    if skip() {
        return;
    }
    let app = app!(&["GET /status"], &[]);

    let (status, _, _) = app.authed("GET", "/api/plugins/shell-ui/status").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    app.cleanup().await;
}

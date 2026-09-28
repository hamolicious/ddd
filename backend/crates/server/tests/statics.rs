//! Router-level tests for the M3 static surface: the PWA, the import map, the SPA
//! fallback and the plugin asset routes (area `server-static`, SPEC §6.4, §8).
//!
//! These drive the **assembled router** rather than the handlers, because almost
//! everything that can go wrong here is a routing or header question: whether
//! `/index.html` reaches the injection path or is served as a file, whether an unmatched
//! GET becomes `index.html` or a 404, whether `/api/**` keeps returning JSON once a
//! catch-all HTML fallback exists, and what `Cache-Control` each class of URL carries. The
//! unit tests inside `routes/statics.rs` cover the pure parts (path resolution, the CSP
//! string, the marker replacement); they cannot see any of the above.
//!
//! Each test builds its **own fixture tree** under `CARGO_TARGET_TMPDIR` — a fake
//! `dist/` and a fake installed-plugin directory — so the cases are independent of
//! whether anybody has run `mise run web-build`, and of each other. The plugin registry
//! caches per directory, which is what makes that work.
//!
//! Like the other Mongo-backed suites these are `#[ignore]`d and skip when `MONGO_URI`
//! is unset (the router needs an `AppState`, and `AppState::new` pings Mongo):
//!
//! ```text
//! docker compose up -d --wait mongo
//! MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p life-manager-server --test statics -- --ignored
//! ```

mod common;

use std::fs;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use life_manager_server::config::Config;
use life_manager_server::domain::new_id;
use life_manager_server::state::AppState;
use life_manager_server::{routes, telemetry};
use serde_json::{Value as Json, json};
use tower::ServiceExt as _;

use common::{ApiResponse, TEST_PASSWORD, mongo_uri, test_config};

/// A string that must never reach a client. It lives in the fixture root — the parent of
/// both served roots — so any answer containing it is a traversal that escaped.
const SECRET: &str = "TOP-SECRET-OUTSIDE-THE-ROOT";

/// The marker `web/app/index.html` carries; spelled here so a test fails if the constant
/// and the real template ever disagree.
const MARKER: &str = "<!--LM_IMPORT_MAP-->";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/// A fake built bundle plus a fake installed-plugin directory.
///
/// ```text
/// <root>/secret.txt                                  the file nothing may serve
/// <root>/dist/index.html                             carries the marker
/// <root>/dist/runtime-manifest.json
/// <root>/dist/assets/app-abc123.js                   content-hashed
/// <root>/dist/sw.js, icon.svg, manifest.webmanifest
/// <root>/plugins/shell-ui/1.0.0/…                     the installed plugin
/// <root>/plugins/shell-ui/0.9.0/…                     an older version, never served
/// <root>/plugins/broken/1.0.0/manifest.json           invalid JSON  → a problem
/// <root>/plugins/Bad_Id/1.0.0/manifest.json           invalid id    → a problem
/// ```
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Fixture {
        let root =
            Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("statics-{name}-{}", new_id()));
        let dist = root.join("dist");
        let plugins = root.join("plugins");

        fs::create_dir_all(dist.join("assets")).expect("fixture dist");
        fs::write(root.join("secret.txt"), SECRET).expect("fixture secret");
        fs::write(
            dist.join("index.html"),
            format!(
                "<!doctype html>\n<html><head><title>Life Manager</title>\n{MARKER}\n\
                 <script type=\"module\" src=\"/assets/app-abc123.js\"></script>\n\
                 </head><body><div id=\"root\"></div></body></html>\n"
            ),
        )
        .expect("fixture index.html");
        fs::write(
            dist.join("runtime-manifest.json"),
            json!({
                "imports": {
                    "react": "/runtime/react-pRvsLDve.js",
                    "react/jsx-runtime": "/runtime/react-jsx-runtime-D1.js",
                    "@kernel": "/runtime/kernel-BdFAWC4t.js",
                    "yjs": "/runtime/yjs-DFgAKIW1.js",
                }
            })
            .to_string(),
        )
        .expect("fixture runtime manifest");
        fs::write(dist.join("assets/app-abc123.js"), "export const app = 1;\n").expect("asset");
        fs::write(dist.join("sw.js"), "// service worker\n").expect("sw");
        fs::write(
            dist.join("icon.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .expect("icon");
        fs::write(
            dist.join("manifest.webmanifest"),
            json!({"name": "Life Manager"}).to_string(),
        )
        .expect("webmanifest");

        write_plugin(&plugins, "shell-ui", "1.0.0");
        write_plugin(&plugins, "shell-ui", "0.9.0");

        fs::create_dir_all(plugins.join("broken/1.0.0")).expect("broken dir");
        fs::write(plugins.join("broken/1.0.0/manifest.json"), "{ not json").expect("broken");
        fs::create_dir_all(plugins.join("Bad_Id/1.0.0")).expect("bad id dir");
        fs::write(plugins.join("Bad_Id/1.0.0/manifest.json"), "{}").expect("bad id");

        Fixture { root }
    }

    fn dist(&self) -> PathBuf {
        self.root.join("dist")
    }

    fn plugins(&self) -> PathBuf {
        self.root.join("plugins")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn write_plugin(plugins: &Path, id: &str, version: &str) {
    let dir = plugins.join(id).join(version);
    fs::create_dir_all(dir.join("frontend")).expect("plugin dir");
    fs::write(
        dir.join("manifest.json"),
        json!({
            "id": id,
            "version": version,
            "kernel": "^1.0",
            "peerLibraries": { "react": "^18.0.0" },
            "frontend": { "module": "frontend/index.mjs", "style": "frontend/style.css" },
            "x-defines": ["main.view"],
        })
        .to_string(),
    )
    .expect("plugin manifest");
    fs::write(
        dir.join("frontend/index.mjs"),
        format!("export default function activate() {{ return {{ id: \"{id}\" }}; }}\n"),
    )
    .expect("plugin module");
    fs::write(dir.join("frontend/style.css"), ".lm-shell {}\n").expect("plugin style");
    // A plugin package is third-party content from our own origin: an SVG in it is the
    // same stored-XSS vector as one in an attachment (SPEC §3.6).
    fs::write(
        dir.join("frontend/logo.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
    )
    .expect("plugin svg");
    // And an HTML file (a vendored viewer, a demo page) is the stronger case of the same
    // rule: served inline it would be a scriptable document on this origin, outside the CSP
    // every real document gets.
    fs::write(
        dir.join("frontend/docs.html"),
        "<!doctype html><title>demo</title>\n",
    )
    .expect("plugin html");
    // Server-side halves and the manifest are in the package but are not browser assets.
    fs::write(dir.join("backend.wasm"), b"\0asm not really").expect("plugin wasm");
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// The router, plus a bearer token for the one authenticated route.
struct StaticsApp {
    router: Router,
    token: String,
    database: String,
    client: mongodb::Client,
}

impl StaticsApp {
    /// `None` ⇒ no `MONGO_URI`, skip the test. `configure` receives the shared test
    /// config and points it at this test's fixture.
    async fn start(configure: impl FnOnce(&mut Config)) -> Option<StaticsApp> {
        let uri = mongo_uri()?;
        let database = format!("lm_router_test_{}", new_id());
        let mut config = test_config(uri.clone(), database.clone());
        configure(&mut config);

        let client = mongodb::Client::with_uri_str(&uri).await.ok()?;
        let state = AppState::new(config.clone()).await.ok()?;
        state.init_schema().await.ok()?;
        let metrics = telemetry::init_metrics(&config).ok()?;
        let router = routes::router(state, metrics);

        let mut app = StaticsApp {
            router,
            token: String::new(),
            database,
            client,
        };
        // The first registration is the admin (SPEC §5.1); `/api/plugins` needs a
        // session and nothing else here does.
        let response = app
            .request(
                "POST",
                "/api/auth/register",
                false,
                Some(json!({
                    "email": "first@example.com",
                    "password": TEST_PASSWORD,
                    "bearer": true,
                })),
            )
            .await;
        response.expect_status(StatusCode::OK);
        app.token = response.json()["token"]
            .as_str()
            .expect("register returns a bearer token")
            .to_string();
        Some(app)
    }

    async fn cleanup(self) {
        let _ = self.client.database(&self.database).drop().await;
    }

    async fn request(
        &self,
        method: &str,
        uri: &str,
        authenticated: bool,
        body: Option<Json>,
    ) -> ApiResponse {
        let mut builder = Request::builder().method(method).uri(uri);
        if authenticated && !self.token.is_empty() {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {}", self.token));
        }
        let request = match body {
            Some(body) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => builder.body(Body::empty()),
        }
        .expect("valid request");
        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("the router is infallible");
        let status = response.status();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .expect("reading the response body");
        ApiResponse {
            status,
            headers,
            body,
        }
    }

    /// An anonymous GET — everything on this surface except `/api/plugins`.
    async fn get(&self, uri: &str) -> ApiResponse {
        self.request("GET", uri, false, None).await
    }

    async fn get_authenticated(&self, uri: &str) -> ApiResponse {
        self.request("GET", uri, true, None).await
    }
}

fn header_value(response: &ApiResponse, name: &str) -> String {
    response
        .headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

/// Every test that serves the bundle wires both roots the same way.
fn with_fixture(fixture: &Fixture) -> impl FnOnce(&mut Config) + '_ {
    move |config: &mut Config| {
        config.web_dist_dir = Some(fixture.dist());
        config.plugins_dir = fixture.plugins();
    }
}

// ---------------------------------------------------------------------------
// /importmap.json
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_import_map_is_exactly_what_the_build_emitted() {
    let fixture = Fixture::new("importmap");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };

    let response = app.get("/importmap.json").await;
    response.expect_status(StatusCode::OK);
    assert_eq!(header_value(&response, "content-type"), "application/json");
    assert_eq!(header_value(&response, "cache-control"), "no-cache");
    assert_eq!(header_value(&response, "x-content-type-options"), "nosniff");

    // Read straight from `runtime-manifest.json`, with no hard-coded fallback: a map
    // naming chunks that do not exist is an app that boots and then fails on its first
    // plugin, which is far harder to diagnose than an empty map.
    let imports = &response.json()["imports"];
    assert_eq!(imports["react"], "/runtime/react-pRvsLDve.js");
    assert_eq!(
        imports["react/jsx-runtime"],
        "/runtime/react-jsx-runtime-D1.js"
    );
    assert_eq!(imports["@kernel"], "/runtime/kernel-BdFAWC4t.js");
    assert_eq!(imports["yjs"], "/runtime/yjs-DFgAKIW1.js");
    // Only the blessed runtime layer: plugin modules are loaded by URL, never by bare
    // specifier, so nothing about the installed set may leak here.
    assert!(
        imports.as_object().expect("imports is an object").len() == 4,
        "the import map grew an entry: {imports}"
    );
    assert!(!response.text().contains("shell-ui"));

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_import_map_is_empty_and_not_an_error_without_a_bundle() {
    // API-only deployment (`WEB_DIST_DIR` unset): the route still answers, so the
    // service worker and a curious operator get a defined result.
    let Some(app) = StaticsApp::start(|_| {}).await else {
        return;
    };
    let response = app.get("/importmap.json").await;
    response.expect_status(StatusCode::OK);
    assert_eq!(response.json(), json!({ "imports": {} }));
    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// index.html, the injection and the policy
// ---------------------------------------------------------------------------

/// The `nonce="…"` of the inline import map in a served page.
fn inline_nonce(html: &str) -> String {
    let after = html
        .split_once("<script type=\"importmap\" nonce=\"")
        .expect("the page carries a nonced inline import map")
        .1;
    after
        .split_once('"')
        .expect("the nonce attribute is closed")
        .0
        .to_string()
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_root_document_carries_the_map_and_a_matching_policy() {
    let fixture = Fixture::new("index");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };

    let response = app.get("/").await;
    response.expect_status(StatusCode::OK);
    assert_eq!(
        header_value(&response, "content-type"),
        "text/html; charset=utf-8"
    );
    // The nonce is per response, so the document must never be cached — a cached CSP
    // nonce is a CSP bypass, and it is also why `sw.js` must not precache this URL.
    assert_eq!(header_value(&response, "cache-control"), "no-store");
    assert_eq!(header_value(&response, "x-content-type-options"), "nosniff");
    assert_eq!(header_value(&response, "referrer-policy"), "same-origin");
    assert_eq!(
        header_value(&response, "cross-origin-opener-policy"),
        "same-origin"
    );

    let html = response.text();
    assert!(!html.contains(MARKER), "the marker was served as a comment");
    assert!(html.contains("/runtime/react-pRvsLDve.js"));

    // The one inline script on the page is authorised by the nonce in the policy, and by
    // nothing else: the policy has no `'unsafe-inline'` in `script-src`.
    let csp = header_value(&response, "content-security-policy");
    let nonce = inline_nonce(html);
    assert!(nonce.len() >= 20, "a guessable nonce is no nonce: {nonce}");
    assert!(
        csp.contains(&format!("'nonce-{nonce}'")),
        "the document nonce is not in the policy:\n{csp}"
    );
    for directive in [
        "default-src 'self'",
        "script-src 'self' 'nonce-",
        "'wasm-unsafe-eval'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "worker-src 'self' blob:",
    ] {
        assert!(csp.contains(directive), "policy lost `{directive}`:\n{csp}");
    }

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn every_response_gets_its_own_nonce() {
    let fixture = Fixture::new("nonce");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };
    let first = app.get("/").await;
    let second = app.get("/").await;
    assert_ne!(
        inline_nonce(first.text()),
        inline_nonce(second.text()),
        "two responses shared a nonce"
    );
    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn index_html_is_never_served_as_a_file_from_any_spelling() {
    let fixture = Fixture::new("index-file");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };
    // This is the exact bug the route was written to prevent: served as a file, the
    // marker stays a comment, the import map never arrives, and the app dies with
    // "Failed to resolve module specifier \"react\"".
    for uri in ["/index.html", "/./index.html", "//index.html"] {
        let response = app.get(uri).await;
        response.expect_status(StatusCode::OK);
        assert!(
            !response.text().contains(MARKER),
            "{uri} was served as a raw file"
        );
        assert_eq!(
            header_value(&response, "cache-control"),
            "no-store",
            "{uri} was cached"
        );
    }
    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// The SPA fallback
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn client_side_routes_survive_a_reload() {
    let fixture = Fixture::new("spa");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };
    // The router is a plugin (SPEC §6.5), so every in-app URL is a client-side route and
    // a reload of one has to reach the app rather than a 404.
    for uri in [
        "/doc/01JBQ0000000000000000000",
        "/doc/01JBQ0000000000000000000/edit",
        "/settings/themes",
        "/trash",
        "/nothing/like/a/file",
    ] {
        let response = app.get(uri).await;
        response.expect_status(StatusCode::OK);
        assert_eq!(
            header_value(&response, "content-type"),
            "text/html; charset=utf-8",
            "{uri} did not reach the app"
        );
        assert!(response.text().contains("importmap"), "{uri} lost the map");
    }
    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn an_api_404_is_json_even_though_the_fallback_serves_html() {
    let fixture = Fixture::new("api-404");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };
    for uri in ["/api/nope", "/api", "/api/documents/x/y/z"] {
        let response = app.get(uri).await;
        response.expect_status(StatusCode::NOT_FOUND);
        assert!(
            !response.text().contains("<html"),
            "{uri} handed an API client HTML"
        );
        assert!(
            !response.json()["error"]["code"].is_null(),
            "{uri} lost the error envelope: {}",
            response.text()
        );
    }
    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn without_a_bundle_the_server_says_it_is_api_only() {
    let Some(app) = StaticsApp::start(|_| {}).await else {
        return;
    };
    let response = app.get("/").await;
    response.expect_status(StatusCode::NOT_FOUND);
    assert!(response.text().contains("API only"));
    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// Cache policy on the bundle
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn hashed_assets_are_immutable_and_everything_else_revalidates() {
    let fixture = Fixture::new("cache");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };

    let asset = app.get("/assets/app-abc123.js").await;
    asset.expect_status(StatusCode::OK);
    assert_eq!(
        header_value(&asset, "cache-control"),
        "public, max-age=31536000, immutable"
    );
    assert_eq!(
        header_value(&asset, "content-type"),
        "application/javascript; charset=utf-8"
    );
    assert_eq!(header_value(&asset, "x-content-type-options"), "nosniff");

    for uri in ["/sw.js", "/manifest.webmanifest"] {
        let response = app.get(uri).await;
        response.expect_status(StatusCode::OK);
        assert_eq!(
            header_value(&response, "cache-control"),
            "no-cache",
            "{uri} must revalidate: it is not content-hashed"
        );
    }

    // The app's own icon is an SVG from our own build, not third-party content — but the
    // allowlist is type-based, not origin-based, so it downloads too. That is deliberate:
    // one rule, no exception that a plugin could grow into.
    let icon = app.get("/icon.svg").await;
    icon.expect_status(StatusCode::OK);
    assert_eq!(header_value(&icon, "content-disposition"), "attachment");

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn traversal_out_of_the_plugin_root_is_refused() {
    let fixture = Fixture::new("traversal-plugins");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };

    for uri in [
        "/plugins/shell-ui/1.0.0/../../../secret.txt",
        "/plugins/shell-ui/1.0.0/frontend/../../../../secret.txt",
        "/plugins/shell-ui/1.0.0/%2e%2e%2f%2e%2e%2f%2e%2e%2fsecret.txt",
        "/plugins/shell-ui/1.0.0/..%2f..%2f..%2fsecret.txt",
        "/plugins/shell-ui/1.0.0/./../../../secret.txt",
        // The id and version segments are validated before the path is: `..` is neither
        // a plugin id nor a version.
        "/plugins/../../secret.txt",
        "/plugins/shell-ui/../../secret.txt",
        // A directory is not a file.
        "/plugins/shell-ui/1.0.0/frontend",
    ] {
        let response = app.get(uri).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{uri} was served");
        assert!(!response.text().contains(SECRET), "{uri} leaked the secret");
    }

    app.cleanup().await;
}

/// `/plugins/:id/:version/*` is **unauthenticated by necessity** — a browser fetching an ES
/// module sends no credentials — so it must serve only `frontend/**` (web/CONTRACTS.md, the
/// M3 carry-over; `backend/CONTRACTS.md` decision 12).
///
/// The two files that must stay unreachable through it are the ones M4 started putting in
/// the same directory: the **manifest**, which lists capabilities, config keys, declared
/// hosts and routes, and the **backend module**, which is the plugin's server-side code. A
/// reader of either learns what this server's plugins are trusted with without ever signing
/// in. `/api/plugins` is the authenticated way to ask.
///
/// It holds by construction — `is_frontend_path` requires `frontend` as the first segment,
/// before any path resolution — and this is the test that says so out loud, now that the
/// installer really does write `backend.wasm` next to the frontend half.
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_manifest_and_the_backend_half_are_not_served_to_the_browser() {
    let fixture = Fixture::new("package-private");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };

    for uri in [
        "/plugins/shell-ui/1.0.0/manifest.json",
        "/plugins/shell-ui/1.0.0/backend.wasm",
        // Not reachable by walking out of `frontend/` either.
        "/plugins/shell-ui/1.0.0/frontend/../manifest.json",
        "/plugins/shell-ui/1.0.0/frontend/../backend.wasm",
        // Nor by dressing the first segment up.
        "/plugins/shell-ui/1.0.0/%66rontend/../backend.wasm",
    ] {
        let response = app.get(uri).await;
        assert_eq!(
            response.status,
            StatusCode::NOT_FOUND,
            "{uri} must not be served without a session"
        );
    }

    // The control: the frontend half of the same package is served, which is what makes
    // the assertions above about the *allowlist* rather than about a missing directory.
    app.get("/plugins/shell-ui/1.0.0/frontend/index.mjs")
        .await
        .expect_status(StatusCode::OK);

    app.cleanup().await;
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn a_symlink_cannot_walk_out_of_the_plugin_root() {
    let fixture = Fixture::new("symlink");
    // The lexical check cannot see this one: the URL has no `..` at all. Only
    // canonicalize-and-re-check does, which is why both passes exist. (SPEC §6.2 rejects
    // symlinks at install time as well; this is the serving-side half, and it is what
    // protects a directory somebody dropped in by hand.)
    std::os::unix::fs::symlink(
        fixture.root.join("secret.txt"),
        fixture.plugins().join("shell-ui/1.0.0/frontend/escape.txt"),
    )
    .expect("fixture symlink");

    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };
    let response = app.get("/plugins/shell-ui/1.0.0/frontend/escape.txt").await;
    response.expect_status(StatusCode::NOT_FOUND);
    assert!(!response.text().contains(SECRET));
    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn traversal_out_of_the_bundle_root_never_serves_the_file() {
    let fixture = Fixture::new("traversal-dist");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };
    // Unlike the plugin route this path ends at the SPA fallback, so the *status* is 200
    // and the body is the app. The property under test is the one that matters: the file
    // above the root is not in the response.
    for uri in [
        "/../secret.txt",
        "/..%2fsecret.txt",
        "/assets/../../secret.txt",
        "/%2e%2e%2f%2e%2e%2fsecret.txt",
        "/./../secret.txt",
    ] {
        let response = app.get(uri).await;
        assert!(
            !response.text().contains(SECRET),
            "{uri} leaked a file above WEB_DIST_DIR"
        );
    }
    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// Plugin assets
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn only_the_registered_plugin_at_its_registered_version_is_served() {
    let fixture = Fixture::new("plugin-assets");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };

    let module = app.get("/plugins/shell-ui/1.0.0/frontend/index.mjs").await;
    module.expect_status(StatusCode::OK);
    assert_eq!(
        header_value(&module, "content-type"),
        "application/javascript; charset=utf-8"
    );
    // The version is in the URL and the bytes behind it never change: this is the one
    // route that earns a year-long immutable cache (SPEC §8).
    assert_eq!(
        header_value(&module, "cache-control"),
        "public, max-age=31536000, immutable"
    );
    assert_eq!(header_value(&module, "x-content-type-options"), "nosniff");
    assert!(module.text().contains("activate"));

    let style = app.get("/plugins/shell-ui/1.0.0/frontend/style.css").await;
    style.expect_status(StatusCode::OK);
    assert_eq!(
        header_value(&style, "content-type"),
        "text/css; charset=utf-8"
    );
    assert_eq!(header_value(&style, "content-disposition"), "");

    // Only the highest version is in the registry; the older directory is on disk and
    // must still 404, because two versions in one page would give two copies of one
    // plugin's API to different dependents.
    app.get("/plugins/shell-ui/0.9.0/frontend/index.mjs")
        .await
        .expect_status(StatusCode::NOT_FOUND);
    // Not installed at all. In M4 this is what keeps a *pending* install unfetchable
    // before an admin approves it.
    app.get("/plugins/ghost/1.0.0/frontend/index.mjs")
        .await
        .expect_status(StatusCode::NOT_FOUND);
    // A directory the registry refused for a bad manifest is not served either.
    app.get("/plugins/broken/1.0.0/manifest.json")
        .await
        .expect_status(StatusCode::NOT_FOUND);
    // Malformed coordinates never reach the filesystem.
    for uri in [
        "/plugins/Shell-UI/1.0.0/frontend/index.mjs",
        "/plugins/shell-ui/1.0/frontend/index.mjs",
        "/plugins/shell-ui/v1.0.0/frontend/index.mjs",
    ] {
        assert_eq!(
            app.get(uri).await.status,
            StatusCode::NOT_FOUND,
            "{uri} was served"
        );
    }

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn an_svg_inside_a_plugin_package_downloads_instead_of_rendering() {
    let fixture = Fixture::new("plugin-svg");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };
    let response = app.get("/plugins/shell-ui/1.0.0/frontend/logo.svg").await;
    response.expect_status(StatusCode::OK);
    // An `image/svg+xml` served inline from the app's own origin is stored XSS with
    // access to the whole session — the SPEC §3.6 attachment rule, applied to plugin
    // packages because they are third-party content too.
    assert_eq!(header_value(&response, "content-disposition"), "attachment");
    assert_eq!(header_value(&response, "x-content-type-options"), "nosniff");
    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn an_html_file_inside_a_plugin_package_downloads_instead_of_rendering() {
    let fixture = Fixture::new("plugin-html");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };
    // `serve_file` sends no CSP, so an inline HTML file from a plugin package would be a
    // scriptable same-origin document *outside* the policy every real document in the app
    // gets — `default-src`, `frame-ancestors` and `base-uri` all absent. A DOM-XSS sink in
    // a vendored viewer would then be XSS on this origin, reachable by link.
    let response = app.get("/plugins/shell-ui/1.0.0/frontend/docs.html").await;
    response.expect_status(StatusCode::OK);
    assert_eq!(header_value(&response, "content-disposition"), "attachment");
    assert_eq!(header_value(&response, "x-content-type-options"), "nosniff");
    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn nothing_outside_the_frontend_directory_is_served() {
    let fixture = Fixture::new("plugin-non-frontend");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };
    // The manifest names the plugin's capabilities and config keys, which is exactly what
    // `GET /api/plugins` requires a session for ("not public information"); `backend.wasm`
    // is server-side code. Both are in the package on disk and neither is a browser asset,
    // so the public asset route does not serve them (SPEC §6.2's `frontend/**` layout).
    for uri in [
        "/plugins/shell-ui/1.0.0/manifest.json",
        "/plugins/shell-ui/1.0.0/backend.wasm",
        "/plugins/shell-ui/1.0.0/./manifest.json",
        "/plugins/shell-ui/1.0.0//manifest.json",
    ] {
        let response = app.get(uri).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{uri} was served");
    }
    // A URL with an empty `{*path}` does not match the asset route at all and lands on the
    // SPA fallback, which answers 200 with `index.html` — the router's behaviour for every
    // unmatched GET, and not a disclosure. What matters is that no package file is in it.
    let listing = app.get("/plugins/shell-ui/1.0.0/").await;
    assert!(
        !listing.text().contains("peerLibraries"),
        "the manifest leaked through the SPA fallback"
    );
    // The module and its stylesheet still are.
    app.get("/plugins/shell-ui/1.0.0/frontend/index.mjs")
        .await
        .expect_status(StatusCode::OK);
    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// /api/plugins
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_installed_list_needs_a_session_and_reports_refusals() {
    let fixture = Fixture::new("installed");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };

    // What is installed in a workspace is not public information.
    app.get("/api/plugins")
        .await
        .expect_status(StatusCode::UNAUTHORIZED);

    let response = app.get_authenticated("/api/plugins").await;
    response.expect_status(StatusCode::OK);
    let body = response.json();

    let plugins = body["plugins"].as_array().expect("plugins is an array");
    assert_eq!(plugins.len(), 1, "expected one installed plugin: {body}");
    let plugin = &plugins[0];
    assert_eq!(plugin["manifest"]["id"], "shell-ui");
    assert_eq!(plugin["manifest"]["version"], "1.0.0");
    // camelCase, deliberately and uniquely on this endpoint: this is `InstalledPlugin`
    // from `web/kernel-api/src/manifest.ts`, consumed by the loader as-is. A `base_url`
    // here is a loader that reads `undefined` and every plugin failing to load.
    assert_eq!(plugin["baseUrl"], "/plugins/shell-ui/1.0.0/");
    assert!(
        plugin["base"].as_bool().unwrap_or(false),
        "shell-ui is base"
    );
    assert_eq!(plugin["state"], "enabled");
    // The manifest passes through untouched, `peerLibraries` spelling included, and
    // unknown keys survive so an M3 server does not eat an M4 manifest's `capabilities`.
    assert_eq!(plugin["manifest"]["peerLibraries"]["react"], "^18.0.0");
    assert_eq!(plugin["manifest"]["x-defines"][0], "main.view");

    // A bad directory disables one plugin and is reported — never fatal, and never
    // silent, or the admin screen shows a mysteriously missing feature.
    let problems = body["problems"].as_array().expect("problems is an array");
    let rendered = serde_json::to_string(problems).expect("problems serialize");
    assert_eq!(problems.len(), 2, "expected two refusals: {rendered}");
    assert!(rendered.contains("Bad_Id"), "the invalid id: {rendered}");
    assert!(
        rendered.contains("broken"),
        "the invalid manifest: {rendered}"
    );
    // An older version that *parsed* is not a problem — it is simply not the one served.
    assert!(
        !rendered.contains("0.9.0"),
        "a shadowed version is not a fault"
    );
    assert_eq!(body["disabled"], false);

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn disable_plugins_is_the_server_side_half_of_safe_mode() {
    let fixture = Fixture::new("disabled");
    let Some(app) = StaticsApp::start(|config| {
        config.web_dist_dir = Some(fixture.dist());
        config.plugins_dir = fixture.plugins();
        config.disable_plugins = true;
    })
    .await
    else {
        return;
    };

    let response = app.get_authenticated("/api/plugins").await;
    response.expect_status(StatusCode::OK);
    assert_eq!(
        response.json(),
        json!({
            "plugins": [],
            "problems": [],
            "disabled": true,
            "wiring": { "version": 0, "unplugged": [], "bind": {}, "cut": [], "add": [], "order": {} },
            "protocols": [],
        }),
        "DISABLE_PLUGINS must say *why* the app is bare (SPEC §6.1)"
    );

    // And the assets go with it: an installed module that is still on disk must not be
    // loadable when the server has been told to boot without plugins.
    app.get("/plugins/shell-ui/1.0.0/frontend/index.mjs")
        .await
        .expect_status(StatusCode::NOT_FOUND);

    // The app itself still boots — safe mode is a working app with no plugins, not an
    // error page.
    app.get("/").await.expect_status(StatusCode::OK);

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// /kernel.d.ts
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_plugin_contract_is_served_as_text_to_anyone() {
    let fixture = Fixture::new("dts");
    let dts = fixture.root.join("kernel.d.ts");
    fs::write(
        &dts,
        "export interface Kernel { readonly version: string }\n",
    )
    .expect("dts");

    let Some(app) = StaticsApp::start(|config| {
        config.kernel_dts_path = Some(dts.clone());
    })
    .await
    else {
        return;
    };

    // Public on purpose (SPEC §6.4): a plugin author needs the contract before they
    // have an account in anybody's workspace.
    let response = app.get("/kernel.d.ts").await;
    response.expect_status(StatusCode::OK);
    assert_eq!(
        header_value(&response, "content-type"),
        "text/plain; charset=utf-8"
    );
    assert_eq!(header_value(&response, "x-content-type-options"), "nosniff");
    assert!(response.text().contains("interface Kernel"));

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn an_ungenerated_contract_explains_itself() {
    let Some(app) = StaticsApp::start(|config| {
        config.kernel_dts_path = Some(PathBuf::from("/nonexistent/kernel.d.ts"));
    })
    .await
    else {
        return;
    };
    let response = app.get("/kernel.d.ts").await;
    response.expect_status(StatusCode::NOT_FOUND);
    assert!(
        response.text().contains("kernel:dts"),
        "the 404 should name the command that fixes it: {}",
        response.text()
    );
    app.cleanup().await;
}

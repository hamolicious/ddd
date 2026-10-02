mod common;

use std::fs;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use ddd_server::config::Config;
use ddd_server::domain::new_id;
use ddd_server::state::AppState;
use ddd_server::{routes, telemetry};
use serde_json::{Value as Json, json};
use tower::ServiceExt as _;

use common::{ApiResponse, TEST_PASSWORD, mongo_uri, test_config};

const SECRET: &str = "TOP-SECRET-OUTSIDE-THE-ROOT";

const MARKER: &str = "<!--DDD_IMPORT_MAP-->";

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
                "<!doctype html>\n<html><head><title>ddd</title>\n{MARKER}\n\
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
            json!({"name": "ddd"}).to_string(),
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
            "kernel": "^3.0",
            "peerLibraries": { "react": "^18.0.0" },
            "frontend": { "module": "frontend/index.mjs", "style": "frontend/style.css" },
            "x-tailwind": { "prefix": "main" },
        })
        .to_string(),
    )
    .expect("plugin manifest");
    fs::write(
        dir.join("frontend/index.mjs"),
        format!("export default function activate() {{ return {{ id: \"{id}\" }}; }}\n"),
    )
    .expect("plugin module");
    fs::write(dir.join("frontend/style.css"), ".ddd-shell {}\n").expect("plugin style");
    fs::write(
        dir.join("frontend/logo.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
    )
    .expect("plugin svg");
    fs::write(
        dir.join("frontend/docs.html"),
        "<!doctype html><title>demo</title>\n",
    )
    .expect("plugin html");
    fs::write(dir.join("backend.wasm"), b"\0asm not really").expect("plugin wasm");
}

struct StaticsApp {
    router: Router,
    token: String,
    database: String,
    client: mongodb::Client,
}

impl StaticsApp {
    async fn start(configure: impl FnOnce(&mut Config)) -> Option<StaticsApp> {
        let uri = mongo_uri()?;
        let database = format!("ddd_router_test_{}", new_id());
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

fn with_fixture(fixture: &Fixture) -> impl FnOnce(&mut Config) + '_ {
    move |config: &mut Config| {
        config.web_dist_dir = Some(fixture.dist());
        config.plugins_dir = fixture.plugins();
    }
}

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

    let imports = &response.json()["imports"];
    assert_eq!(imports["react"], "/runtime/react-pRvsLDve.js");
    assert_eq!(
        imports["react/jsx-runtime"],
        "/runtime/react-jsx-runtime-D1.js"
    );
    assert_eq!(imports["@kernel"], "/runtime/kernel-BdFAWC4t.js");
    assert_eq!(imports["yjs"], "/runtime/yjs-DFgAKIW1.js");
    let object = imports.as_object().expect("imports is an object");
    assert_eq!(
        object.len(),
        4,
        "the anonymous map names a plugin: {imports}"
    );

    let response = app.get_authenticated("/importmap.json").await;
    response.expect_status(StatusCode::OK);
    let imports = &response.json()["imports"];
    let object = imports.as_object().expect("imports is an object");
    assert_eq!(object.len(), 5, "the import map grew an entry: {imports}");
    let shell = imports["plugin:shell-ui"]
        .as_str()
        .expect("plugin:shell-ui");
    assert!(
        shell.starts_with("/plugins/shell-ui/1.0.0/frontend/index.mjs?v="),
        "{shell}"
    );

    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_import_map_is_empty_and_not_an_error_without_a_bundle() {
    let Some(app) = StaticsApp::start(|_| {}).await else {
        return;
    };
    let response = app.get("/importmap.json").await;
    response.expect_status(StatusCode::OK);
    assert_eq!(response.json(), json!({ "imports": {} }));
    app.cleanup().await;
}

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

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn index_html_names_the_installed_plugins_only_to_a_session() {
    let fixture = Fixture::new("index-plugins");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };
    let anonymous = app.get("/").await;
    anonymous.expect_status(StatusCode::OK);
    assert!(
        !anonymous.text().contains("plugin:"),
        "the signed-out page names a plugin"
    );

    let signed_in = app.get_authenticated("/").await;
    signed_in.expect_status(StatusCode::OK);
    assert!(
        signed_in.text().contains("\"plugin:shell-ui\""),
        "the signed-in page is missing the plugin entries"
    );
    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn client_side_routes_survive_a_reload() {
    let fixture = Fixture::new("spa");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };
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

    let icon = app.get("/icon.svg").await;
    icon.expect_status(StatusCode::OK);
    assert_eq!(header_value(&icon, "content-disposition"), "attachment");

    app.cleanup().await;
}

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
        "/plugins/../../secret.txt",
        "/plugins/shell-ui/../../secret.txt",
        "/plugins/shell-ui/1.0.0/frontend",
    ] {
        let response = app.get(uri).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{uri} was served");
        assert!(!response.text().contains(SECRET), "{uri} leaked the secret");
    }

    app.cleanup().await;
}

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
        "/plugins/shell-ui/1.0.0/frontend/../manifest.json",
        "/plugins/shell-ui/1.0.0/frontend/../backend.wasm",
        "/plugins/shell-ui/1.0.0/%66rontend/../backend.wasm",
    ] {
        let response = app.get(uri).await;
        assert_eq!(
            response.status,
            StatusCode::NOT_FOUND,
            "{uri} must not be served without a session"
        );
    }

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

    app.get("/plugins/shell-ui/0.9.0/frontend/index.mjs")
        .await
        .expect_status(StatusCode::NOT_FOUND);
    app.get("/plugins/ghost/1.0.0/frontend/index.mjs")
        .await
        .expect_status(StatusCode::NOT_FOUND);
    app.get("/plugins/broken/1.0.0/manifest.json")
        .await
        .expect_status(StatusCode::NOT_FOUND);
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
    for uri in [
        "/plugins/shell-ui/1.0.0/manifest.json",
        "/plugins/shell-ui/1.0.0/backend.wasm",
        "/plugins/shell-ui/1.0.0/./manifest.json",
        "/plugins/shell-ui/1.0.0//manifest.json",
    ] {
        let response = app.get(uri).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{uri} was served");
    }
    let listing = app.get("/plugins/shell-ui/1.0.0/").await;
    assert!(
        !listing.text().contains("peerLibraries"),
        "the manifest leaked through the SPA fallback"
    );
    app.get("/plugins/shell-ui/1.0.0/frontend/index.mjs")
        .await
        .expect_status(StatusCode::OK);
    app.cleanup().await;
}

#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_installed_list_needs_a_session_and_reports_refusals() {
    let fixture = Fixture::new("installed");
    let Some(app) = StaticsApp::start(with_fixture(&fixture)).await else {
        return;
    };

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
    assert_eq!(plugin["baseUrl"], "/plugins/shell-ui/1.0.0/");
    assert!(
        plugin["base"].as_bool().unwrap_or(false),
        "shell-ui is base"
    );
    assert_eq!(plugin["state"], "enabled");
    assert_eq!(plugin["manifest"]["peerLibraries"]["react"], "^18.0.0");
    assert_eq!(plugin["manifest"]["x-tailwind"]["prefix"], "main");

    assert_eq!(body["load"]["normal"], json!(["shell-ui"]));
    assert_eq!(body["load"]["safe"], json!(["shell-ui"]));
    assert_eq!(body["load"]["skipped"], json!([]));
    assert_eq!(body["load"]["version"].as_str().map(str::len), Some(16));
    for gone in ["wiring", "protocols", "resolved"] {
        assert!(body.get(gone).is_none(), "`{gone}` is gone in @kernel 3.0");
    }

    let problems = body["problems"].as_array().expect("problems is an array");
    let rendered = serde_json::to_string(problems).expect("problems serialize");
    assert_eq!(problems.len(), 2, "expected two refusals: {rendered}");
    assert!(rendered.contains("Bad_Id"), "the invalid id: {rendered}");
    assert!(
        rendered.contains("broken"),
        "the invalid manifest: {rendered}"
    );
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
            "load": {
                "normal": [],
                "safe": [],
                "skipped": [],
                "version": ddd_server::plugins::fingerprint(
                    &[],
                    &ddd_server::plugins::LoadPlan::default()
                ),
            },
        }),
        "DISABLE_PLUGINS must say *why* the app is bare (SPEC §6.1)"
    );

    app.get("/plugins/shell-ui/1.0.0/frontend/index.mjs")
        .await
        .expect_status(StatusCode::NOT_FOUND);

    app.get("/").await.expect_status(StatusCode::OK);

    app.cleanup().await;
}

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

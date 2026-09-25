//! Router-level tests for the M5 shell bundle manifest (area `server-bundle`, SPEC §7,
//! `app/BRIDGE.md` §5).
//!
//! Three properties carry the milestone, and none of them is visible from a unit test:
//!
//! 1. **completeness** — everything the webview needs with no network is in `files`, at a
//!    path the shell can fetch, with a hash that matches the bytes on disk. A manifest
//!    that is missing one module produces a bundle that verifies, swaps, and then boots
//!    into nothing;
//! 2. **stability** — the same content yields the same `bundle_version` on a fresh
//!    process, so a restart or a second replica does not hand every device a "new"
//!    bundle to download;
//! 3. **movement** — a rebuild *does* move it, or an update never ships.
//!
//! Each test builds its own fixture tree under `CARGO_TARGET_TMPDIR`, so the suite does
//! not care whether anybody has run `mise run web-build`. Like the other router suites
//! these are `#[ignore]`d and skip when `MONGO_URI` is unset (`AppState::new` pings
//! Mongo):
//!
//! ```text
//! docker compose up -d --wait mongo
//! MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p life-manager-server --test shell_bundle -- --ignored
//! ```

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use life_manager_server::config::Config;
use life_manager_server::domain::new_id;
use life_manager_server::routes::shell::{ShellManifest, bundle_version};
use life_manager_server::state::AppState;
use life_manager_server::{routes, telemetry};
use serde_json::{Value as Json, json};
use sha2::{Digest as _, Sha256};
use tower::ServiceExt as _;

use common::{ApiResponse, TEST_PASSWORD, mongo_uri, test_config};

/// A file above both roots. Any manifest entry or response containing it is a traversal.
const SECRET: &str = "TOP-SECRET-OUTSIDE-THE-ROOT";

/// The marker `web/app/index.html` carries, spelled here so a drift fails a test.
const MARKER: &str = "<!--LM_IMPORT_MAP-->";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/// A fake built distribution and a fake installed-plugin directory, covering every class
/// of file the real ones contain — including the ones that must **not** be in a bundle.
///
/// ```text
/// <root>/secret.txt                           above both roots; never servable
/// <root>/dist/index.html                      carries the marker    → synthesized
/// <root>/dist/importmap.json                  a stale copy on disk  → synthesized
/// <root>/dist/shell-bundle.json               min_bridge_version    → read, not shipped
/// <root>/dist/runtime-manifest.json           the import map source
/// <root>/dist/assets/app-abc123.js  (+ .map)  the app; the map is excluded
/// <root>/dist/assets/core-abc123.wasm         the shared Rust core
/// <root>/dist/runtime/react-abc.js            the blessed runtime layer
/// <root>/dist/runtime/shared/dep-abc.js       nested, to exercise the walk
/// <root>/dist/sw.js (+ .map)                  excluded: two caches, one revert path
/// <root>/dist/icon.svg, manifest.webmanifest
/// <root>/dist/.vite/manifest.json             excluded: build metadata
/// <root>/dist/kernel.d.ts                     excluded: /kernel.d.ts is another route
/// <root>/dist/plugins/shell-ui/1.0.0/…        excluded: the plugin route owns that URL
/// <root>/dist/plugins/loader-shim.js          kept: two segments, not that route
/// <root>/plugins/shell-ui/1.0.0/…             frontend/** is bundled; the rest is not
/// <root>/plugins/agenda/2.1.0/…               a second plugin, nested assets
/// ```
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new(name: &str) -> Fixture {
        let root =
            Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("shell-{name}-{}", new_id()));
        let dist = root.join("dist");
        let plugins = root.join("plugins");

        fs::create_dir_all(dist.join("assets")).expect("fixture assets");
        fs::create_dir_all(dist.join("runtime/shared")).expect("fixture runtime");
        fs::create_dir_all(dist.join(".vite")).expect("fixture vite");
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
        // A stale `importmap.json` on disk: the manifest must carry the *synthesized*
        // rendering, not this, or the shell downloads a map generated before the last
        // plugin install.
        fs::write(
            dist.join("importmap.json"),
            "{\"imports\":{\"stale\":\"x\"}}\n",
        )
        .expect("fixture stale importmap");
        fs::write(
            dist.join("shell-bundle.json"),
            json!({"minBridgeVersion": 1}).to_string(),
        )
        .expect("fixture shell-bundle.json");
        fs::write(
            dist.join("runtime-manifest.json"),
            json!({
                "imports": {
                    "react": "/runtime/react-abc.js",
                    "@kernel": "/runtime/kernel-abc.js",
                },
                "versions": { "react": "18.3.1" },
            })
            .to_string(),
        )
        .expect("fixture runtime manifest");

        fs::write(dist.join("assets/app-abc123.js"), "export const app = 1;\n").expect("app");
        fs::write(
            dist.join("assets/app-abc123.js.map"),
            "{\"version\":3,\"sources\":[]}\n",
        )
        .expect("app map");
        fs::write(dist.join("assets/core-abc123.wasm"), b"\0asm\x01\0\0\0").expect("wasm");
        fs::write(dist.join("runtime/react-abc.js"), "export default {};\n").expect("react");
        fs::write(
            dist.join("runtime/shared/dep-abc.js"),
            "export const d = 1;\n",
        )
        .expect("dep");
        fs::write(dist.join("sw.js"), "// service worker\n").expect("sw");
        fs::write(dist.join("sw.js.map"), "{}\n").expect("sw map");
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
        fs::write(
            dist.join(".vite/manifest.json"),
            json!({"build": true}).to_string(),
        )
        .expect("vite metadata");

        // Two files whose *URL* another route answers, both reachable by dropping
        // something in `web/app/public/`. Publishing either would hand the shell a hash
        // the download cannot match, and one mismatch aborts the whole bundle — so every
        // device would fail every update over a file nothing loads.
        fs::write(dist.join("kernel.d.ts"), "export {};\n").expect("shadowed dts");
        fs::create_dir_all(dist.join("plugins/shell-ui/1.0.0/frontend")).expect("shadowed dir");
        fs::write(
            dist.join("plugins/shell-ui/1.0.0/frontend/index.mjs"),
            "export default function spoof() {}\n",
        )
        .expect("shadowed plugin module");
        // …and one that only *looks* shadowed: the plugin route needs an id, a version and
        // a tail, so two segments fall through to the distribution and this is ours.
        fs::write(dist.join("plugins/loader-shim.js"), "export const s = 1;\n")
            .expect("real dist plugins file");

        write_plugin(&plugins, "shell-ui", "1.0.0");
        write_plugin(&plugins, "agenda", "2.1.0");

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
    fs::create_dir_all(dir.join("frontend/assets")).expect("plugin dir");
    fs::write(
        dir.join("manifest.json"),
        json!({
            "id": id,
            "version": version,
            "kernel": "^1.0",
            "frontend": { "module": "frontend/index.mjs", "style": "frontend/style.css" },
        })
        .to_string(),
    )
    .expect("plugin manifest");
    fs::write(
        dir.join("frontend/index.mjs"),
        format!("export default function activate() {{ return {{ id: \"{id}\" }}; }}\n"),
    )
    .expect("plugin module");
    fs::write(dir.join("frontend/style.css"), format!(".lm-{id} {{}}\n")).expect("plugin style");
    fs::write(dir.join("frontend/assets/logo.png"), b"\x89PNG\r\n\x1a\n").expect("plugin asset");
    fs::write(dir.join("frontend/index.mjs.map"), "{}\n").expect("plugin map");
    // Neither of these is a browser asset, and neither belongs on a device: the manifest
    // lists capabilities and config keys, and `backend.wasm` is server-side code.
    fs::write(dir.join("backend.wasm"), b"\0asm not really").expect("plugin wasm");
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct ShellApp {
    router: Router,
    token: String,
    database: String,
    client: mongodb::Client,
}

impl ShellApp {
    async fn start(configure: impl FnOnce(&mut Config)) -> Option<ShellApp> {
        let uri = mongo_uri()?;
        let database = format!("lm_router_test_{}", new_id());
        let mut config = test_config(uri.clone(), database.clone());
        configure(&mut config);

        let client = mongodb::Client::with_uri_str(&uri).await.ok()?;
        let state = AppState::new(config.clone()).await.ok()?;
        state.init_schema().await.ok()?;
        let metrics = telemetry::init_metrics(&config).ok()?;
        let router = routes::router(state, metrics);

        let mut app = ShellApp {
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
        self.request("GET", uri, true, None).await
    }

    async fn anonymous(&self, uri: &str) -> ApiResponse {
        self.request("GET", uri, false, None).await
    }

    /// `GET /api/shell/manifest`, parsed through the published type — which is itself an
    /// assertion: a renamed field fails to deserialize here.
    async fn manifest(&self) -> (ShellManifest, ApiResponse) {
        let response = self.get("/api/shell/manifest").await;
        response.expect_status(StatusCode::OK);
        let manifest: ShellManifest = serde_json::from_slice(&response.body)
            .unwrap_or_else(|err| panic!("manifest did not parse ({err}): {}", response.text()));
        (manifest, response)
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

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn entries(manifest: &ShellManifest) -> BTreeMap<&str, (&str, u64)> {
    manifest
        .files
        .iter()
        .map(|file| (file.path.as_str(), (file.sha256.as_str(), file.size)))
        .collect()
}

/// The `nonce="…"` of the inline import map in a rendered document.
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

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

/// The manifest lists everything the webview needs offline, and every hash is the hash of
/// the bytes the shell will actually receive.
///
/// This is the test the milestone rests on: the shell trusts `files` completely — it
/// downloads exactly those paths, verifies exactly those hashes, and boots whatever
/// resulted. A missing entry is an app that verifies clean and then renders nothing.
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_manifest_covers_the_whole_bundle_and_every_hash_matches() {
    let fixture = Fixture::new("complete");
    let Some(app) = ShellApp::start(with_fixture(&fixture)).await else {
        return;
    };

    let (manifest, response) = app.manifest().await;
    // The shell polls this on every foreground: a cached manifest is an update the device
    // never learns about.
    assert_eq!(header_value(&response, "cache-control"), "no-store");
    assert_eq!(header_value(&response, "x-content-type-options"), "nosniff");
    assert_eq!(manifest.min_bridge_version, 1);

    let listed = entries(&manifest);

    // 1. The app shell, the runtime layer, the kernel assets and the plugin frontends —
    //    everything an offline boot loads.
    for expected in [
        "index.html",
        "importmap.json",
        "assets/app-abc123.js",
        "assets/core-abc123.wasm",
        "runtime/react-abc.js",
        "runtime/shared/dep-abc.js",
        "runtime-manifest.json",
        "manifest.webmanifest",
        "icon.svg",
        "plugins/shell-ui/1.0.0/frontend/index.mjs",
        "plugins/shell-ui/1.0.0/frontend/style.css",
        "plugins/shell-ui/1.0.0/frontend/assets/logo.png",
        "plugins/agenda/2.1.0/frontend/index.mjs",
        "plugins/agenda/2.1.0/frontend/style.css",
        "plugins/agenda/2.1.0/frontend/assets/logo.png",
    ] {
        assert!(
            listed.contains_key(expected),
            "the bundle is missing {expected}: {:?}",
            listed.keys().collect::<Vec<_>>()
        );
    }

    // 2. And nothing else. `sw.js` would fight the updater for control of the webview;
    //    the plugin manifest and `backend.wasm` are not browser assets; source maps are
    //    77 % of the bytes and only devtools fetch them; `.vite` is build metadata.
    for excluded in [
        "sw.js",
        "sw.js.map",
        "shell-bundle.json",
        "assets/app-abc123.js.map",
        "plugins/shell-ui/1.0.0/frontend/index.mjs.map",
        "plugins/shell-ui/1.0.0/manifest.json",
        "plugins/shell-ui/1.0.0/backend.wasm",
        ".vite/manifest.json",
        "secret.txt",
        "../secret.txt",
        // A dist file whose URL `statics::kernel_dts` answers from KERNEL_DTS_PATH — a
        // different file, and one no webview ever loads.
        "kernel.d.ts",
    ] {
        assert!(
            !listed.contains_key(excluded),
            "{excluded} must not be in a shell bundle"
        );
    }

    // 2b. The dist tree also holds `plugins/shell-ui/1.0.0/frontend/index.mjs`, whose URL
    //     belongs to the plugin asset route. The path is published exactly once, and the
    //     bytes behind it are the installed plugin's — not the distribution's copy. (The
    //     hash loop below proves it independently; this says which side must win.)
    let plugin_module = listed["plugins/shell-ui/1.0.0/frontend/index.mjs"];
    assert_eq!(
        plugin_module.0,
        sha256_hex(
            &fs::read(fixture.plugins().join("shell-ui/1.0.0/frontend/index.mjs"))
                .expect("the installed plugin module")
        ),
        "the manifest published the distribution's shadowing copy, not the plugin's"
    );
    // A `plugins/` path with only two segments is *not* claimed by that route, so it is
    // ordinary bundle content and stays.
    assert!(listed.contains_key("plugins/loader-shim.js"));
    assert!(
        !response.text().contains(SECRET),
        "the manifest reached above its roots"
    );

    // 3. Every hash and size is the hash and size of the bytes the shell will get. The
    //    two synthesized paths come from `/api/shell/bundle/{path}`, everything else from
    //    the public static route the updater uses (`BRIDGE.md` §5 step 1).
    for file in &manifest.files {
        let bytes = match file.path.as_str() {
            "index.html" | "importmap.json" => {
                let served = app.get(&format!("/api/shell/bundle/{}", file.path)).await;
                served.expect_status(StatusCode::OK);
                served.body.to_vec()
            }
            path => {
                // Fetched exactly as the updater fetches it, so a path in the manifest
                // that no route answers fails here rather than on a device.
                let served = app.anonymous(&format!("/{path}")).await;
                assert_eq!(
                    served.status,
                    StatusCode::OK,
                    "{path} is in the manifest but is not served"
                );
                served.body.to_vec()
            }
        };
        assert_eq!(
            file.size,
            bytes.len() as u64,
            "{} has the wrong size",
            file.path
        );
        assert_eq!(
            file.sha256,
            sha256_hex(&bytes),
            "{} has the wrong sha256",
            file.path
        );
        assert_eq!(
            file.sha256.to_lowercase(),
            file.sha256,
            "{} is not lowercase hex (the shell compares strings)",
            file.path
        );
    }

    // 4. Sorted, deduplicated, and the id is the hash of that canonical listing.
    let paths: Vec<&String> = manifest.files.iter().map(|file| &file.path).collect();
    let mut sorted = paths.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(paths, sorted, "files must be sorted by path and unique");
    assert_eq!(
        manifest.bundle_version,
        bundle_version(&manifest.files),
        "bundle_version is not the hash of its own listing"
    );

    app.cleanup().await;
}

/// The manifest names every installed plugin and version — the information
/// `GET /api/plugins` is authenticated to protect. The shell logs in natively first
/// (`BRIDGE.md` §4.1), so it always has a token.
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn both_shell_routes_need_a_session() {
    let fixture = Fixture::new("auth");
    let Some(app) = ShellApp::start(with_fixture(&fixture)).await else {
        return;
    };

    for uri in [
        "/api/shell/manifest",
        "/api/shell/bundle/index.html",
        "/api/shell/bundle/importmap.json",
    ] {
        let response = app.anonymous(uri).await;
        assert_eq!(
            response.status,
            StatusCode::UNAUTHORIZED,
            "{uri} answered without a session"
        );
    }

    // The control: with a token, all three answer.
    app.get("/api/shell/manifest")
        .await
        .expect_status(StatusCode::OK);
    app.get("/api/shell/bundle/index.html")
        .await
        .expect_status(StatusCode::OK);

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// Stability and movement
// ---------------------------------------------------------------------------

/// Same bytes ⇒ same version, from a *different process state*: a second `AppState`, a
/// second database, a second registry read, a cold cache.
///
/// This is what makes the shell's "do I already have this?" check work. A version that
/// picked up a timestamp, a boot id or a server identity would hand every device a fresh
/// multi-megabyte download after every restart and every deploy of an unchanged bundle.
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_version_survives_a_restart() {
    let fixture = Fixture::new("stable");
    let Some(first) = ShellApp::start(with_fixture(&fixture)).await else {
        return;
    };
    let (before, _) = first.manifest().await;
    // Twice through the same process as well, which is the cached path.
    let (cached, _) = first.manifest().await;
    assert_eq!(before.bundle_version, cached.bundle_version);
    first.cleanup().await;

    let Some(second) = ShellApp::start(with_fixture(&fixture)).await else {
        return;
    };
    let (after, _) = second.manifest().await;
    assert_eq!(
        before.bundle_version, after.bundle_version,
        "a restart changed the bundle version"
    );
    assert_eq!(before.files.len(), after.files.len());
    assert_eq!(
        before.index_csp, after.index_csp,
        "the nonce must be stable too"
    );
    second.cleanup().await;
}

/// A rebuild moves it — a changed file, a new file, a removed file.
///
/// The counterpart to the test above, and the reason the cache is keyed on a
/// `(path, size, mtime)` fingerprint rather than on a TTL: an update that ships one hour
/// after the deploy is an update that looks broken.
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn a_rebuild_moves_the_version() {
    let fixture = Fixture::new("rebuild");
    let Some(app) = ShellApp::start(with_fixture(&fixture)).await else {
        return;
    };
    let (first, _) = app.manifest().await;

    // A changed module: the common redeploy.
    fs::write(
        fixture.dist().join("assets/app-abc123.js"),
        "export const app = 2; // rebuilt\n",
    )
    .expect("rebuild the app");
    let (second, _) = app.manifest().await;
    assert_ne!(
        first.bundle_version, second.bundle_version,
        "a changed file did not move the version"
    );

    // A new chunk: the build split something.
    fs::write(
        fixture.dist().join("runtime/shared/new-chunk.js"),
        "export const n = 1;\n",
    )
    .expect("new chunk");
    let (third, _) = app.manifest().await;
    assert_ne!(second.bundle_version, third.bundle_version);
    assert_eq!(third.files.len(), second.files.len() + 1);

    // A removal: the case a "hash of what we added" would miss entirely.
    fs::remove_file(fixture.dist().join("runtime/shared/new-chunk.js")).expect("remove");
    let (fourth, _) = app.manifest().await;
    assert_eq!(
        second.bundle_version, fourth.bundle_version,
        "removing the added file should return to the previous version"
    );

    // The template changing moves the synthesized `index.html`, its stable nonce, the
    // policy that names the nonce, and therefore the version.
    fs::write(
        fixture.dist().join("index.html"),
        format!("<!doctype html>\n<html><head>\n{MARKER}\n</head><body>v2</body></html>\n"),
    )
    .expect("rebuild index");
    let (fifth, _) = app.manifest().await;
    assert_ne!(fourth.bundle_version, fifth.bundle_version);
    assert_ne!(fourth.index_csp, fifth.index_csp, "the nonce did not move");

    app.cleanup().await;
}

/// `min_bridge_version` comes from the bundle, not from this binary (`BRIDGE.md` §8), and
/// it is **not** part of the content hash: bumping it is a statement about what the shell
/// must implement, not a new set of bytes to download.
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn min_bridge_version_comes_from_the_bundle_and_is_not_the_content() {
    let fixture = Fixture::new("min-bridge");
    let Some(app) = ShellApp::start(with_fixture(&fixture)).await else {
        return;
    };
    let (first, _) = app.manifest().await;
    assert_eq!(first.min_bridge_version, 1);

    fs::write(
        fixture.dist().join("shell-bundle.json"),
        json!({"minBridgeVersion": 3}).to_string(),
    )
    .expect("bump minBridgeVersion");
    let (second, _) = app.manifest().await;
    assert_eq!(
        second.min_bridge_version, 3,
        "the file is the authority, and the cache has to see it change"
    );
    assert_eq!(
        first.bundle_version, second.bundle_version,
        "min_bridge_version is not part of the downloadable content"
    );

    // A missing file means "1" — a bundle built before M5, not a broken server.
    fs::remove_file(fixture.dist().join("shell-bundle.json")).expect("remove meta");
    let (third, _) = app.manifest().await;
    assert_eq!(third.min_bridge_version, 1);

    // So does a malformed one: refusing to publish a manifest over a typo in one field
    // would take every shell in the field offline.
    fs::write(fixture.dist().join("shell-bundle.json"), "{ not json").expect("break meta");
    let (fourth, _) = app.manifest().await;
    assert_eq!(fourth.min_bridge_version, 1);

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// The real distribution
// ---------------------------------------------------------------------------

/// The same completeness property, against the **actual** built bundle — `web/app/dist`
/// plus `plugins/base/dist` — rather than a fixture.
///
/// A fixture proves the algorithm; this proves the algorithm against what the build really
/// emits: nested `runtime/shared/**` chunks, a `.wasm`, a `.vite` directory, a dozen plugin
/// packages, and 4 MB of source maps that must not be in a phone's download. Every entry is
/// re-hashed straight from disk, which is the check that cannot be satisfied by agreeing
/// with itself.
///
/// Skipped — not failed — when the distribution has not been built, the same way the whole
/// suite skips without `MONGO_URI`: a clean checkout must test green.
///
/// ```text
/// mise run web-build && mise run plugins-build
/// MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p life-manager-server --test shell_bundle -- --ignored
/// ```
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_real_distribution_produces_a_complete_manifest() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("the repo root");
    let dist = repo.join("web/app/dist");
    let plugins = repo.join("plugins/base/dist");
    if !dist.join("index.html").is_file() || !plugins.is_dir() {
        eprintln!(
            "skipping: no built distribution at {} — run `mise run web-build` and \
             `mise run plugins-build`",
            dist.display()
        );
        return;
    }

    let Some(app) = ShellApp::start(|config| {
        config.web_dist_dir = Some(dist.clone());
        config.plugins_dir = plugins.clone();
    })
    .await
    else {
        return;
    };

    let (manifest, _) = app.manifest().await;
    let listed = entries(&manifest);

    // 1. Everything on disk that is not excluded is listed. The walk here is the test's
    //    own — a plain recursion — so a bug in the endpoint's walk shows up as a missing
    //    entry rather than as two implementations agreeing.
    let mut on_disk: Vec<String> = Vec::new();
    collect(&dist, "", &mut on_disk);
    let mut plugin_count = 0usize;
    for id in fs::read_dir(&plugins)
        .expect("the plugin root is readable")
        .flatten()
    {
        let id_name = id.file_name().to_string_lossy().to_string();
        if !id.path().is_dir() {
            continue;
        }
        for version in fs::read_dir(id.path()).expect("plugin versions").flatten() {
            let version_name = version.file_name().to_string_lossy().to_string();
            let frontend = version.path().join("frontend");
            if !frontend.is_dir() {
                continue;
            }
            plugin_count += 1;
            collect(
                &frontend,
                &format!("plugins/{id_name}/{version_name}/frontend/"),
                &mut on_disk,
            );
        }
    }
    assert!(
        plugin_count > 0,
        "the base distribution has no plugin with a frontend half; the assertions below \
         would be vacuous"
    );

    for path in &on_disk {
        // The synthesized pair is "excluded" *as a file* precisely because it is published
        // as a rendering — the on-disk `index.html` still carries the unreplaced marker.
        if is_synthesized(path) {
            assert!(
                listed.contains_key(path.as_str()),
                "{path} is not published"
            );
            continue;
        }
        // A real distribution has no `plugins/` directory of its own, so a path with that
        // prefix here came from a plugin root and cannot be shadowing anything.
        let shadowed = !path.starts_with("plugins/")
            && life_manager_server::routes::shell::is_shadowed_dist_path(path);
        if life_manager_server::routes::shell::is_excluded(path) || shadowed {
            assert!(
                !listed.contains_key(path.as_str()),
                "{path} is excluded but was published"
            );
            continue;
        }
        assert!(
            listed.contains_key(path.as_str()),
            "{path} is not in the bundle"
        );
    }

    // 2. Nothing is listed that is not on disk or synthesized.
    for file in &manifest.files {
        assert!(
            is_synthesized(&file.path) || on_disk.contains(&file.path),
            "{} is published but is not a file under either root",
            file.path
        );
    }

    // 3. Every hash is the hash of the bytes on disk, read independently of the endpoint.
    for file in &manifest.files {
        if is_synthesized(&file.path) {
            let served = app.get(&format!("/api/shell/bundle/{}", file.path)).await;
            served.expect_status(StatusCode::OK);
            assert_eq!(file.sha256, sha256_hex(&served.body), "{}", file.path);
            assert_eq!(file.size, served.body.len() as u64, "{}", file.path);
            continue;
        }
        let absolute = match file.path.strip_prefix("plugins/") {
            Some(rest) => plugins.join(rest),
            None => dist.join(&file.path),
        };
        let bytes = fs::read(&absolute)
            .unwrap_or_else(|err| panic!("{} is published but unreadable: {err}", file.path));
        assert_eq!(file.sha256, sha256_hex(&bytes), "{}", file.path);
        assert_eq!(file.size, bytes.len() as u64, "{}", file.path);
    }

    // 4. The three things a real bundle makes concrete.
    let real = entries(&manifest);
    assert!(
        real.keys().any(|path| path.ends_with(".wasm")),
        "the shared Rust core is missing — the client would lose filter evaluation, title \
         resolution and date normalisation offline"
    );
    assert!(
        real.keys().any(|path| path.starts_with("runtime/")),
        "the blessed runtime layer is missing"
    );
    assert!(
        real.keys()
            .any(|path| path.ends_with("/frontend/index.mjs")),
        "no plugin module is in the bundle — an offline boot would render nothing"
    );
    assert!(
        !real.keys().any(|path| path.ends_with(".map")),
        "source maps are in the bundle; that is most of the download"
    );

    let bytes: u64 = manifest.files.iter().map(|file| file.size).sum();
    eprintln!(
        "real bundle: version {}, {} files, {:.1} MiB",
        &manifest.bundle_version[..12],
        manifest.files.len(),
        bytes as f64 / (1024.0 * 1024.0)
    );

    app.cleanup().await;
}

/// The two paths `GET /api/shell/bundle/{path}` renders rather than copies
/// (`BRIDGE.md` §5): the on-disk `index.html` still carries the unreplaced import-map
/// marker, and `importmap.json` is generated from the installed plugin set.
fn is_synthesized(path: &str) -> bool {
    path == "index.html" || path == "importmap.json"
}

/// Every file under `root`, as `prefix + relative path`. The test's own walk.
fn collect(root: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(read_dir) = fs::read_dir(root) else {
        return;
    };
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = format!("{prefix}{name}");
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => collect(&entry.path(), &format!("{path}/"), out),
            Ok(file_type) if file_type.is_file() => out.push(path),
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// The synthesized files
// ---------------------------------------------------------------------------

/// The two files with no byte-stable static URL, and the nonce that ties them to
/// `index_csp`.
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_synthesized_files_are_byte_stable_and_carry_the_published_nonce() {
    let fixture = Fixture::new("synthesized");
    let Some(app) = ShellApp::start(with_fixture(&fixture)).await else {
        return;
    };
    let (manifest, _) = app.manifest().await;

    let first = app.get("/api/shell/bundle/index.html").await;
    first.expect_status(StatusCode::OK);
    let second = app.get("/api/shell/bundle/index.html").await;
    assert_eq!(
        first.body, second.body,
        "two renderings of the bundle's index.html differed — the shell would abort every \
         download it just verified"
    );
    assert_eq!(header_value(&first, "cache-control"), "no-store");
    assert_eq!(header_value(&first, "x-content-type-options"), "nosniff");
    // These bytes are for a downloader. A cookie-authenticated browser navigating here
    // would otherwise render a scriptable same-origin document with no CSP at all (the
    // policy travels in `index_csp`, for the loopback server to send).
    assert_eq!(header_value(&first, "content-disposition"), "attachment");

    let html = first.text();
    assert!(!html.contains(MARKER), "the marker survived");
    assert!(
        html.contains("\"react\":\"/runtime/react-abc.js\""),
        "the import map is not inlined: {html}"
    );
    // The nonce in the document, the nonce in the policy the shell will send, and the
    // hash in the manifest are one consistent set. If the first two diverge the import
    // map is blocked and every bare specifier fails to resolve.
    let nonce = inline_nonce(html);
    assert!(nonce.len() >= 20, "a guessable nonce is no nonce: {nonce}");
    assert!(
        manifest.index_csp.contains(&format!("'nonce-{nonce}'")),
        "index_csp does not name the document's nonce:\n{}",
        manifest.index_csp
    );

    // The synthesized import map is the live one, not the stale copy sitting in `dist/`.
    let map = app.get("/api/shell/bundle/importmap.json").await;
    map.expect_status(StatusCode::OK);
    let parsed = map.json();
    assert_eq!(parsed["imports"]["react"], "/runtime/react-abc.js");
    assert_eq!(parsed["imports"]["@kernel"], "/runtime/kernel-abc.js");
    assert!(
        parsed["imports"]["stale"].is_null(),
        "the stale on-disk importmap.json was served: {parsed}"
    );

    // And it is the *same* map the browser resolves against, byte for byte. The two are
    // rendered by different modules (`statics::import_map` runs the M4 peer resolution
    // over the installed set; this one renders the bundle's imports directly), and they
    // happen to agree today because that resolution returns the provided map unchanged.
    // If it ever stops doing so, a shell would boot plugins against a different runtime
    // layer than every browser — silently, and only offline. Pinned here so that change
    // has to be a deliberate one.
    let browser_map = app.anonymous("/importmap.json").await;
    browser_map.expect_status(StatusCode::OK);
    assert_eq!(
        map.body, browser_map.body,
        "the shell's import map and the browser's have drifted"
    );

    app.cleanup().await;
}

/// Only the two declared paths are served, and nothing about that route is a second
/// traversal check to get wrong: every other bundle file already has a public URL.
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_bundle_route_serves_nothing_but_the_synthesized_pair() {
    let fixture = Fixture::new("bundle-route");
    let Some(app) = ShellApp::start(with_fixture(&fixture)).await else {
        return;
    };

    for uri in [
        // Real files, reachable through their own public URLs — not through this one.
        "/api/shell/bundle/assets/app-abc123.js",
        "/api/shell/bundle/sw.js",
        "/api/shell/bundle/shell-bundle.json",
        "/api/shell/bundle/runtime-manifest.json",
        "/api/shell/bundle/plugins/shell-ui/1.0.0/manifest.json",
        // Traversal, in the spellings axum's decoding can leave behind.
        "/api/shell/bundle/../../secret.txt",
        "/api/shell/bundle/..%2f..%2fsecret.txt",
        "/api/shell/bundle/%2e%2e%2fsecret.txt",
        "/api/shell/bundle/./index.html",
        "/api/shell/bundle//index.html",
        "/api/shell/bundle/index.html/",
        // Not the allowlisted spelling.
        "/api/shell/bundle/INDEX.HTML",
        "/api/shell/bundle/index.htm",
    ] {
        let response = app.get(uri).await;
        assert_eq!(
            response.status,
            StatusCode::NOT_FOUND,
            "{uri} was served: {}",
            response.text()
        );
        assert!(!response.text().contains(SECRET), "{uri} leaked the secret");
    }

    app.cleanup().await;
}

/// `index_csp` is SPEC §8's policy with exactly one deviation, and the browser-facing
/// document is the reference.
///
/// The two documents now share one renderer (`statics::render_index_body`), but their
/// *policies* are still built separately and must be: the shell's `connect-src` is not the
/// browser's. So this test compares them directive by directive and names the one
/// difference the loopback origin forces — with `PUBLIC_URL` unset, which is what the test
/// config carries and what keeps that difference scheme-wide.
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn the_shell_policy_tracks_the_browser_policy() {
    let fixture = Fixture::new("csp");
    let Some(app) = ShellApp::start(with_fixture(&fixture)).await else {
        return;
    };
    let (manifest, _) = app.manifest().await;

    let browser = app.anonymous("/").await;
    browser.expect_status(StatusCode::OK);
    let browser_csp = header_value(&browser, "content-security-policy");

    fn directives(csp: &str) -> BTreeMap<String, String> {
        csp.split(';')
            .map(str::trim)
            .filter(|directive| !directive.is_empty())
            .map(|directive| {
                let (name, value) = directive.split_once(' ').unwrap_or((directive, ""));
                // The nonces differ by design: the browser's is 128 random bits per
                // response, the bundle's is derived from the bytes it authorises.
                let value = value
                    .split_whitespace()
                    .map(|source| {
                        if source.starts_with("'nonce-") {
                            "'nonce-…'".to_string()
                        } else {
                            source.to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                (name.to_string(), value)
            })
            .collect()
    }

    let browser_directives = directives(&browser_csp);
    let shell_directives = directives(&manifest.index_csp);

    assert_eq!(
        browser_directives.keys().collect::<Vec<_>>(),
        shell_directives.keys().collect::<Vec<_>>(),
        "the two policies no longer carry the same directives:\n{browser_csp}\n{}",
        manifest.index_csp
    );
    for (name, browser_value) in &browser_directives {
        let shell_value = &shell_directives[name];
        if name == "connect-src" {
            // The one deviation, and it is forced: on the loopback origin every API call
            // and the sync socket are cross-origin, and the server does not know which
            // host the device reaches it by (`BRIDGE.md` §6).
            assert_eq!(shell_value, "'self' https: http: wss: ws:");
            continue;
        }
        assert_eq!(
            shell_value, browser_value,
            "`{name}` drifted between the browser document and the shell bundle"
        );
    }

    app.cleanup().await;
}

// ---------------------------------------------------------------------------
// Degenerate deployments
// ---------------------------------------------------------------------------

/// An API-only server has nothing for a shell to mirror, and says so rather than
/// publishing an empty `files` (which the updater refuses anyway — a bundle with no
/// `index.html` cannot boot).
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn without_a_bundle_the_manifest_is_unavailable() {
    let Some(app) = ShellApp::start(|_| {}).await else {
        return;
    };
    let response = app.get("/api/shell/manifest").await;
    response.expect_status(StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.error_code(), "unavailable");
    app.get("/api/shell/bundle/index.html")
        .await
        .expect_status(StatusCode::SERVICE_UNAVAILABLE);
    app.cleanup().await;
}

/// `DISABLE_PLUGINS=1` is the server-side half of safe mode (SPEC §6.1), and a shell
/// updating against such a server gets exactly what a browser gets: the kernel, no
/// plugins. Anything else would have the device boot modules the server refuses to serve.
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn safe_mode_produces_a_kernel_only_bundle() {
    let fixture = Fixture::new("disabled");
    let Some(app) = ShellApp::start(|config| {
        config.web_dist_dir = Some(fixture.dist());
        config.plugins_dir = fixture.plugins();
        config.disable_plugins = true;
    })
    .await
    else {
        return;
    };

    let (manifest, _) = app.manifest().await;
    assert!(
        manifest
            .files
            .iter()
            .all(|file| !file.path.contains("/frontend/")),
        "a bundle built with DISABLE_PLUGINS carried plugin modules"
    );
    // The fixture's `dist/plugins/shell-ui/1.0.0/frontend/index.mjs` is the sharper half
    // of that: with the registry empty it is no longer shadowed by a plugin root, and it
    // is *still* not published — `statics::plugin_asset` answers that URL with a 404 under
    // DISABLE_PLUGINS, so listing it would abort every update.
    assert!(
        !entries(&manifest).contains_key("plugins/shell-ui/1.0.0/frontend/index.mjs"),
        "a dist file on the plugin route's URL was published"
    );
    // A two-segment `plugins/` path is ordinary bundle content and is unaffected.
    assert!(entries(&manifest).contains_key("plugins/loader-shim.js"));
    // The app shell is still there: safe mode is a working app with no plugins, not an
    // error page.
    assert!(entries(&manifest).contains_key("index.html"));
    assert!(entries(&manifest).contains_key("assets/app-abc123.js"));

    app.cleanup().await;
}

/// A symlink out of a root is not in the manifest — because it is not served either
/// (`statics::resolve_within` canonicalizes and re-checks), and a manifest entry no route
/// answers aborts every update.
#[cfg(unix)]
#[tokio::test]
#[ignore = "needs MONGO_URI"]
async fn a_symlink_out_of_a_root_is_not_bundled() {
    let fixture = Fixture::new("symlink");
    std::os::unix::fs::symlink(
        fixture.root.join("secret.txt"),
        fixture.dist().join("assets/escape.txt"),
    )
    .expect("fixture symlink");
    std::os::unix::fs::symlink(
        fixture.root.join("secret.txt"),
        fixture.plugins().join("shell-ui/1.0.0/frontend/escape.txt"),
    )
    .expect("fixture plugin symlink");

    let Some(app) = ShellApp::start(with_fixture(&fixture)).await else {
        return;
    };
    let (manifest, response) = app.manifest().await;
    for file in &manifest.files {
        assert!(
            !file.path.ends_with("escape.txt"),
            "a symlink out of the root was bundled: {}",
            file.path
        );
    }
    assert!(!response.text().contains(SECRET));
    app.cleanup().await;
}

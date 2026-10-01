//! Serving the PWA, the import map, the plugin modules and `kernel.d.ts` (SPEC §6.4, §8).
//!
//! This is the other half of the server's identity: "keep clients in step" (SPEC §2).
//! The routes are:
//!
//! | Route | Purpose |
//! |---|---|
//! | `GET /` + SPA fallback | `index.html` with the import map injected and a CSP nonce |
//! | `GET /assets/*`, `/runtime/*`, `/sw.js`, `/icon.svg`, … | the built bundle, from `WEB_DIST_DIR` |
//! | `GET /importmap.json` | the runtime layer and the `plugin:<id>` entries, for debugging and the service worker |
//! | `GET /plugins/{id}/{version}/{*path}` | plugin modules and assets, immutable |
//! | `GET /kernel.d.ts` | the generated plugin contract |
//! | `GET /api/plugins` | the installed list the loader activates from (authenticated) |
//!
//! Three decisions worth reading before changing anything here.
//!
//! **The import map is injected inline, with a nonce.** Browsers never shipped an
//! external import map (`<script type="importmap" src>` does not exist), so "served
//! external or nonced" in SPEC §8 resolves to nonced-inline. `index.html` carries an
//! `<!--DDD_IMPORT_MAP-->` marker; this module replaces it per response and puts the
//! matching nonce in the CSP. That is also why `index.html` is never cached: the nonce
//! must be fresh, and a cached CSP nonce is a CSP bypass.
//!
//! **No `ServeDir`.** Static serving here is about 80 lines of `tokio::fs` plus a path
//! canonicalization check, and it avoids adding `tower-http`'s `fs` feature (and its
//! three transitive crates) to a dependency list `backend/CONTRACTS.md` freezes. The
//! canonicalization is the part that matters: every path is resolved and re-checked
//! against the root, so `/plugins/x/1.0.0/../../../etc/passwd` cannot escape whatever
//! axum's decoding leaves behind.
//!
//! **`nosniff` on everything, and `Content-Disposition: attachment` on anything not on
//! the inline allowlist.** The attachment routes already do this for user uploads (SPEC
//! §3.6); plugin packages are third-party content served from the app's own origin, and
//! an `image/svg+xml` in a plugin's assets is the same stored-XSS vector as one in an
//! attachment.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use axum::Router;
use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::header::{
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_SECURITY_POLICY, CONTENT_TYPE, HeaderName,
    HeaderValue, REFERRER_POLICY,
};
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::auth::{AuthUser, MaybeAuthUser};
use crate::error::{AppError, AppResult};
use crate::plugins::{self, InstalledPlugin, safe_relative_path};
use crate::state::AppState;

/// The marker `web/app/index.html` carries where the import map belongs.
pub const IMPORT_MAP_MARKER: &str = "<!--DDD_IMPORT_MAP-->";

/// `runtime-manifest.json`, written by the runtime-layer build next to `index.html`.
pub const RUNTIME_MANIFEST_FILE: &str = "runtime-manifest.json";

/// `X-Content-Type-Options`, spelled once.
const NOSNIFF: HeaderName = HeaderName::from_static("x-content-type-options");

/// `Cross-Origin-Opener-Policy` — not in axum's constant set.
const COOP: HeaderName = HeaderName::from_static("cross-origin-opener-policy");

/// Types safe to render inline from our own origin. Everything else downloads.
///
/// **`text/html` is deliberately absent**, for the same reason `image/svg+xml` is: a
/// document served inline from this origin is a scripted context with the session cookie
/// attached, and a plugin package can contain one (a vendored viewer, a Storybook export,
/// a demo page). `serve_file` attaches no CSP, so such a page would run *outside* the
/// policy every real document in the app gets — no `default-src`, no `frame-ancestors`,
/// no `base-uri` — and one `location.hash` → `innerHTML` sink in it would be XSS on the
/// app's origin, reachable by sending a victim a link. The app's own `index.html` never
/// passes through here: every spelling of it routes to [`index_html`].
const INLINE_SAFE_TYPES: &[&str] = &[
    "text/css",
    "text/plain",
    "application/javascript",
    "application/json",
    "application/manifest+json",
    "application/wasm",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "font/woff2",
];

/// Public routes: the bundle, the import map, plugin modules, the contract.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/importmap.json", get(import_map))
        .route("/kernel.d.ts", get(kernel_dts))
        .route("/plugins/{id}/{version}/{*path}", get(plugin_asset))
}

/// `GET /api/plugins` — the installed list, for the loader and the admin screen.
pub fn api_router() -> Router<AppState> {
    Router::new().route("/", get(installed))
}

// ---------------------------------------------------------------------------
// /api/plugins
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct InstalledResponse {
    pub plugins: Vec<InstalledPlugin>,
    /// Plugin directories the server refused, so the admin screen can show them
    /// instead of a mysteriously missing feature.
    pub problems: Vec<plugins::PluginProblem>,
    /// `true` when `DISABLE_PLUGINS=1` (SPEC §6.1). The client shows why it is bare.
    pub disabled: bool,
    /// What the loader loads, in order, for a normal and a `?safe=1` boot, and which
    /// wanted plugins it skips and why ([`plugins::resolve_load`]).
    pub load: LoadResponse,
}

/// `load` in `GET /api/plugins`: [`plugins::LoadPlan`] plus the version it fingerprints.
#[derive(Debug, Serialize)]
pub struct LoadResponse {
    #[serde(flatten)]
    pub plan: plugins::LoadPlan,
    /// The same string `welcome.plugins_version` and `plugins.changed.version` carry.
    pub version: String,
}

/// Authenticated: the plugin list names what is installed in this workspace, which is
/// not public information. The loader runs after the auth gate, so it always has a
/// session (SPEC §6.4). Every user needs the list to boot, but the refused directories
/// are for the admin screen only: plugins are an administrator's business.
pub async fn installed(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<axum::Json<InstalledResponse>> {
    let registry = plugins::registry(&state.config);
    let plan = registry.load_plan();
    let version = plugins::fingerprint(registry.plugins(), &plan);
    Ok(axum::Json(InstalledResponse {
        plugins: registry.plugins().to_vec(),
        problems: if user.is_admin() {
            registry.problems().to_vec()
        } else {
            Vec::new()
        },
        disabled: state.config.disable_plugins,
        load: LoadResponse { plan, version },
    }))
}

// ---------------------------------------------------------------------------
// /importmap.json
// ---------------------------------------------------------------------------

/// The import map as the browser gets it — **only** `imports`.
///
/// A separate type from [`RuntimeManifest`] because what the build records and what the spec
/// allows in an import map are different documents: an extra top-level key here would be a
/// `<script type="importmap">` the browser may refuse.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ImportMap {
    pub imports: BTreeMap<String, String>,
}

/// `runtime-manifest.json` as the build writes it.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct RuntimeManifest {
    pub imports: BTreeMap<String, String>,
    /// Specifier → the version of the package the bundle actually shipped.
    ///
    /// The other half of a peer-library check. Without it the install flow could only ask
    /// whether a specifier *exists*, so `"@codemirror/view": "^7"` installed cleanly against a
    /// 6.x bundle and failed in the browser — the check HOST-ABI.md §7.1 step 4 describes
    /// ("ranges intersect with what the runtime bundle provides") was not being made.
    ///
    /// `#[serde(default)]`: a manifest written by an older build has no `versions`, and the
    /// check degrades to presence-only rather than refusing every plugin.
    #[serde(default)]
    pub versions: BTreeMap<String, String>,
}

/// Read `runtime-manifest.json` from the built bundle.
///
/// The build writes it (`web/vite.runtime.config.ts`), so the map always names chunks
/// that exist with the hashes they were built with. There is deliberately **no
/// fallback list** here: a hard-coded map would point at hashes that do not exist and
/// produce an app that loads and then fails on the first plugin, which is much harder to
/// diagnose than an empty map plus this log line.
pub fn runtime_imports(state: &AppState) -> BTreeMap<String, String> {
    runtime_manifest(state).imports
}

/// The page's whole import map: the runtime layer, plus — for a signed-in caller only —
/// a `plugin:<id>` entry for every plugin either boot loads ([`plugins::plugin_imports`]).
///
/// The entries name every installed plugin, which is exactly what `GET /api/plugins`
/// keeps behind a session, so a signed-out page gets the runtime layer alone. That
/// page only ever shows the login form; signing in reloads it (`web/app/src/main.tsx`),
/// and the reloaded page carries the full map. The shell bundle is authenticated, so it
/// always passes `true`.
pub fn page_imports(state: &AppState, signed_in: bool) -> BTreeMap<String, String> {
    let mut imports = runtime_imports(state);
    if signed_in {
        imports.extend(plugins::registry(&state.config).plugin_imports());
    }
    imports
}

/// Whether the request carries a valid session. Any failure to tell — no credential, an
/// expired one, or the database being unreachable — counts as signed out: the page must
/// still render (it is the login form, or an offline shell), just without the plugin list.
fn is_signed_in(user: Result<MaybeAuthUser, AppError>) -> bool {
    matches!(user, Ok(MaybeAuthUser(Some(_))))
}

/// Specifier → the version the built bundle provides, for the peer-range check.
///
/// Empty when there is no bundle, and possibly missing an entry when the build could not read
/// a package's version. Both cases mean "cannot be checked", never "does not satisfy".
pub fn runtime_versions(state: &AppState) -> BTreeMap<String, String> {
    runtime_manifest(state).versions
}

/// Read `runtime-manifest.json` whole. See [`runtime_imports`] for why there is no fallback.
fn runtime_manifest(state: &AppState) -> RuntimeManifest {
    let Some(dist) = state.config.web_dist_dir.as_ref() else {
        return RuntimeManifest::default();
    };
    let path = dist.join(RUNTIME_MANIFEST_FILE);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) => {
            warn!(path = %path.display(), error = %err, "no runtime manifest; the import map will be empty");
            return RuntimeManifest::default();
        }
    };
    match serde_json::from_str::<RuntimeManifest>(&raw) {
        Ok(map) => map,
        Err(err) => {
            warn!(path = %path.display(), error = %err, "runtime manifest is invalid");
            RuntimeManifest::default()
        }
    }
}

/// `GET /importmap.json` — unauthenticated, but the `plugin:<id>` entries of the load set
/// are added for a signed-in caller only (see [`page_imports`]).
///
/// The blessed runtime layer plus, when signed in, the plugin entries (`@kernel` 3.0: a
/// plugin's module is imported by that specifier, never by URL, so every importer shares
/// one instance). Every declared `peerLibraries` entry is also checked against the
/// runtime layer, and an unsatisfied one is logged.
pub async fn import_map(
    State(state): State<AppState>,
    user: Result<MaybeAuthUser, AppError>,
) -> Response {
    let imports = runtime_imports(&state);
    let registry = plugins::registry(&state.config);

    // `resolve_import_map` rather than `unsatisfied_peers`: the served map is
    // byte-identical either way (it is the bundle's, unchanged — plugin modules load by
    // URL, not by bare specifier), but this also runs the M4 peer *resolution* over the
    // set that will actually load. That is what catches two third-party plugins asking
    // for CodeMirror ranges that cannot both be satisfied — a conflict an import map
    // cannot express, because it cannot change after load (SPEC §6.4).
    let resolution = plugins::resolve_import_map(&registry, &imports, &runtime_versions(&state));
    if !resolution.missing.is_empty() {
        // Not an error response: the app boots and reports it in the notice strip. This
        // log line is for whoever installed the plugin (SPEC §6.4 peer resolution).
        warn!(
            libraries = resolution.missing.join("; "),
            "installed plugins declare peer libraries the runtime layer does not provide"
        );
    }
    for warning in &resolution.warnings {
        warn!(warning = %warning, "peer library resolution");
    }

    let mut imports = resolution.imports;
    if is_signed_in(user) {
        imports.extend(registry.plugin_imports());
    }
    let body = serde_json::to_vec_pretty(&ImportMap { imports }).unwrap_or_else(|_| b"{}".to_vec());
    (
        StatusCode::OK,
        [
            (CONTENT_TYPE, HeaderValue::from_static("application/json")),
            (NOSNIFF, HeaderValue::from_static("nosniff")),
            // Short: it changes when a plugin is installed, and the service worker
            // revalidates it in the background anyway.
            (CACHE_CONTROL, HeaderValue::from_static("no-cache")),
        ],
        body,
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// /kernel.d.ts
// ---------------------------------------------------------------------------

/// `GET /kernel.d.ts` — the generated plugin contract (SPEC §6.4: "also served at
/// `/kernel.d.ts`"). Public: it is the API documentation, and a plugin author needs it
/// before they have an account.
pub async fn kernel_dts(State(state): State<AppState>) -> Response {
    let Some(path) = state.config.kernel_dts_path.as_ref() else {
        return not_found();
    };
    match tokio::fs::read(path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8")),
                (NOSNIFF, HeaderValue::from_static("nosniff")),
                (CACHE_CONTROL, HeaderValue::from_static("no-cache")),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            [
                (CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8")),
                (NOSNIFF, HeaderValue::from_static("nosniff")),
            ],
            "kernel.d.ts has not been generated — run `npm run kernel:dts` in web/, or set KERNEL_DTS_PATH\n",
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// /plugins/{id}/{version}/{*path}
// ---------------------------------------------------------------------------

/// The one directory of a plugin package this route will serve.
///
/// SPEC §6.2 fixes the package layout and the zip rules reject "entries outside
/// `frontend/**` + declared wasm", so the frontend directory is by definition everything a
/// browser needs. Restricting the route to it keeps two things that are *not* browser
/// assets off a public URL: `manifest.json` — whose capability and `config` key lists are
/// exactly what `GET /api/plugins` is authenticated to protect ("the plugin list … is not
/// public information") — and `backend.wasm`, which is server-side code.
///
/// The route stays unauthenticated, and that is forced rather than chosen: a plugin module
/// is fetched by `import()`, which cannot carry an `Authorization` header, and the M5 shell
/// authenticates with a bearer token from a local-file origin where the cookie is not sent
/// (SPEC §5.2, §7). So the frontend bundle of an installed plugin is readable by anyone who
/// knows an id and a version. Narrowing the path is what is available today; a signed or
/// token-scoped asset URL is the M4 conversation, when a privately installed third-party
/// plugin first has something to lose.
const PLUGIN_ASSET_ROOT: &str = "frontend";

/// One file out of an installed plugin package's `frontend/` directory.
///
/// Version-scoped and immutable: the version is in the URL, the bytes behind it never
/// change, so this is the one route that gets a year-long `immutable` cache (SPEC §8).
/// The plugin must be in the registry — serving a directory that is not installed would
/// make the registry decorative, and in M4 it would serve a *pending* plugin nobody
/// approved.
///
/// **The state is checked, not only the presence.** "A pending package is never in
/// `PLUGINS_DIR`" is the structural half of that guarantee
/// ([`plugins::InstalledPlugin::state`]), and a structural guarantee is worth one explicit
/// check anyway: an interrupted approval (renamed into the served root, record not yet
/// written) used to leave a `pending` directory here that this route happily served,
/// unauthenticated, to anyone who knew the id and version — and `reject` deleted the record
/// while leaving those files behind.
pub async fn plugin_asset(
    State(state): State<AppState>,
    AxumPath((id, version, path)): AxumPath<(String, String, String)>,
) -> Response {
    if state.config.disable_plugins {
        return not_found();
    }
    if !plugins::is_valid_plugin_id(&id) || !plugins::is_valid_version(&version) {
        return not_found();
    }
    let registry = plugins::registry(&state.config);
    match registry.get(&id, &version) {
        None => return not_found(),
        Some(plugin) if !plugin.state.is_served() => {
            tracing::warn!(
                plugin = %id, %version, state = plugin.state.as_str(),
                "refusing to serve an asset of a plugin that is not approved; \
                 its directory should not be in PLUGINS_DIR"
            );
            return not_found();
        }
        Some(_) => {}
    }
    let Some(root) = registry.root() else {
        return not_found();
    };
    if !safe_relative_path(&path) {
        return not_found();
    }
    // Everything the browser loads lives under `frontend/`; nothing else is served (see
    // `PLUGIN_ASSET_ROOT`). Checked on the requested path *before* resolution, so the
    // answer does not depend on what is on disk.
    if !is_frontend_path(&path) {
        return not_found();
    }

    let base = root.join(&id).join(&version);
    match resolve_within(&base, &path) {
        Some(file) => serve_file(&file, CachePolicy::Immutable).await,
        None => not_found(),
    }
}

/// `true` when `path`'s first segment is [`PLUGIN_ASSET_ROOT`] and there is more after it.
///
/// Empty and `.` segments are skipped the way [`resolve_within`] skips them, so
/// `//frontend/index.mjs` and `./frontend/index.mjs` are the same request as
/// `frontend/index.mjs` — the check has to agree with the resolver or it is decorative.
/// `..` never reaches here (`safe_relative_path` rejects it) and is refused anyway.
fn is_frontend_path(path: &str) -> bool {
    let mut segments = path
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".");
    segments.next() == Some(PLUGIN_ASSET_ROOT) && segments.next().is_some()
}

// ---------------------------------------------------------------------------
// The bundle and the SPA fallback
// ---------------------------------------------------------------------------

/// Everything that did not match a route.
///
/// Three cases, in this order:
///
/// 1. `/api/**` → a JSON 404, because an API client must never be handed HTML;
/// 2. an existing file under `WEB_DIST_DIR` → that file;
/// 3. anything else → `index.html`, because the router is a plugin and every in-app URL
///    is a client-side route (`/doc/01J…` must survive a reload).
pub async fn fallback(
    State(state): State<AppState>,
    user: Result<MaybeAuthUser, AppError>,
    uri: Uri,
) -> Response {
    let signed_in = is_signed_in(user);
    let path = uri.path();
    if path.starts_with("/api/") || path == "/api" {
        return AppError::NotFound("route").into_response();
    }

    let Some(dist) = state.config.web_dist_dir.clone() else {
        // No frontend configured: the dev setup (Vite serves the app and proxies here).
        return (
            StatusCode::NOT_FOUND,
            [
                (
                    CONTENT_TYPE,
                    HeaderValue::from_static("text/plain; charset=utf-8"),
                ),
                (NOSNIFF, HeaderValue::from_static("nosniff")),
            ],
            "This server serves the API only (WEB_DIST_DIR is not set).\n",
        )
            .into_response();
    };

    // Normalize before deciding anything: empty segments (`//index.html`) and `.`
    // segments (`/./index.html`) are noise that must not change which branch runs.
    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();

    // `index.html` is never served as a file, from **any** spelling of its path: it has
    // to go through `index_html`, which injects the import map and a fresh CSP nonce.
    // This is not a nicety — serving the raw file produced a page whose
    // `<!--DDD_IMPORT_MAP-->` marker was still a comment, so every bare specifier failed
    // to resolve and the whole app died with "Failed to resolve module specifier
    // \"react\"". Comparing the *raw* path against one spelling was the first version of
    // this check, and `/./index.html` and `/index.html/` walked straight past it into the
    // file branch.
    if segments == ["index.html"] {
        return index_html(&state, &dist, signed_in).await;
    }
    if !segments.is_empty()
        && let Some(file) = resolve_within(&dist, &segments.join("/"))
    {
        let policy = match segments.first() {
            // Content-hashed by the build.
            Some(&"assets") | Some(&"runtime") => CachePolicy::Immutable,
            _ => CachePolicy::Revalidate,
        };
        return serve_file(&file, policy).await;
    }

    index_html(&state, &dist, signed_in).await
}

/// The rendered `index.html`: the body to send and the policy that must accompany it.
///
/// Split out of [`index_html`] so the two things that are easy to get silently wrong —
/// the marker replacement and the exact policy string — are testable without a
/// filesystem, an `AppState` or a database (`tests` at the bottom of this file).
struct IndexPage {
    body: String,
    csp: String,
}

/// Replace [`IMPORT_MAP_MARKER`] with a nonced inline import map.
///
/// **The one implementation.** `shell.rs` renders the same document for the Flutter
/// bundle and used to carry a copy of this function, with the copy's own comment saying
/// exporting this one was the right fix and the statics owner's call. It is, and this is
/// it: two renderings of `index.html` that differ by a character are two ways for the
/// browser page and the shipped bundle to diverge, and the divergence would show up as a
/// module-resolution failure on a device rather than a test failure here.
///
/// The *policy* is not shared, and deliberately: the shell's document is served by the
/// device's own loopback origin and needs a different `connect-src` (see
/// `shell::shell_csp`). Only the markup is common.
///
/// Pure: `imports` and `nonce` are the only inputs.
pub(super) fn render_index_body(
    html: &str,
    imports: &BTreeMap<String, String>,
    nonce: &str,
) -> String {
    let map = serde_json::to_string(&ImportMap {
        imports: imports.clone(),
    })
    .unwrap_or_else(|_| "{}".to_string());
    let script = format!("<script type=\"importmap\" nonce=\"{nonce}\">{map}</script>");
    if html.contains(IMPORT_MAP_MARKER) {
        html.replace(IMPORT_MAP_MARKER, &script)
    } else {
        // A bundle built from an index.html without the marker would load and then fail
        // to resolve `react` in the first plugin. Say so here rather than there.
        warn!(
            "index.html has no {IMPORT_MAP_MARKER} marker; bare specifiers will not resolve the runtime layer"
        );
        html.to_string()
    }
}

/// The browser-facing `index.html`: [`render_index_body`] plus the policy that must
/// accompany it. Pure: `nonce` and `imports` are the only inputs that vary per response.
fn render_index(html: &str, imports: &BTreeMap<String, String>, nonce: &str) -> IndexPage {
    let body = render_index_body(html, imports, nonce);

    // SPEC §8, with two deliberate additions and one narrowing.
    //
    // `'wasm-unsafe-eval'` is an addition, and it is not optional: the shared Rust core
    // is WebAssembly (SPEC §2), and `script-src` without it makes
    // `WebAssembly.instantiateStreaming` throw a CSP violation — the client then loses
    // filter evaluation, title resolution and date normalisation, and silently stops
    // agreeing with the server. It is the narrow directive, not `'unsafe-eval'`: it
    // permits compiling WebAssembly and nothing else, and it is supported across the
    // browser floor of SPEC §8 (Chrome 97+, Safari 16.4+, Firefox 102+).
    //
    // `worker-src 'self' blob:` is the second addition — the local search index runs in a
    // Web Worker (SPEC §4.2). `blob:` is there for a worker constructed from a blob URL;
    // note it is deliberately **not** in `script-src`, so a blob can still not become a
    // top-level script.
    //
    // `connect-src` adds `ws:` alongside the spec's `wss:` so a plain-http compose or
    // dev origin can open `/api/sync` at all; over TLS the browser refuses `ws:` anyway.
    //
    // `media-src 'self' blob:` is the third addition, and it is the attachment story
    // (SPEC §3.6). Audio and video are attachments like any other — `attachment://<ulid>`
    // in the text, resolved by the `markdown` plugin to `/api/attachments/<id>` — and with
    // no `media-src` they fell through to `default-src 'self'`, which covers the direct URL
    // but not the other half of the same feature: the client caches attachment bytes and
    // renders them from an object URL, and `<audio src="blob:…">` was refused outright.
    // `img-src` has carried `blob:` for exactly this reason since M3; media had simply never
    // been played. It is the same narrow shape — a blob URL is same-origin by construction
    // and cannot be minted by a remote page.
    //
    // `frame-src 'self' blob:` is the fourth, and the same story again for PDFs: the
    // `native-preview` plugin shows one in an `<iframe>` from an object URL, the only way
    // a browser's built-in PDF viewer can be reached with the bytes the client already
    // fetched (a bearer-token shell cannot load the API URL at all). The plugin re-types
    // the bytes as `application/pdf` before minting the URL, so the frame gets the PDF
    // viewer, never an HTML document; and a `blob:` document inherits this policy
    // anyway, so it could not run a script if it were one.
    //
    // The nonce is what authorises the one inline script on the page (the import map).
    // Everything else, including every plugin module, is `'self'`.
    let csp = format!(
        "default-src 'self'; script-src 'self' 'nonce-{nonce}' 'wasm-unsafe-eval'; \
         style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
         media-src 'self' blob:; frame-src 'self' blob:; font-src 'self'; \
         connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; \
         base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );

    IndexPage { body, csp }
}

/// `index.html` with the import map inlined and a per-response CSP nonce.
async fn index_html(state: &AppState, dist: &Path, signed_in: bool) -> Response {
    let path = dist.join("index.html");
    let Ok(html) = tokio::fs::read_to_string(&path).await else {
        return (
            StatusCode::NOT_FOUND,
            [
                (CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8")),
                (NOSNIFF, HeaderValue::from_static("nosniff")),
            ],
            "The web bundle is missing — run `mise run web-build` (WEB_DIST_DIR points at web/app/dist).\n",
        )
            .into_response();
    };

    let page = render_index(&html, &page_imports(state, signed_in), &nonce());

    (
        StatusCode::OK,
        [
            (
                CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (NOSNIFF, HeaderValue::from_static("nosniff")),
            // Never cached: the nonce is per response (and so is the import map). A
            // cached nonce is a CSP bypass, which is also why `sw.js` must not precache
            // this document.
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (REFERRER_POLICY, HeaderValue::from_static("same-origin")),
            // Cross-origin isolation, the sensible half: the app opens no cross-origin
            // popups and wants none opening it, so `same-origin` costs nothing and
            // severs the window reference an attacker-opened tab would otherwise keep.
            // Deliberately **not** paired with COEP (`require-corp`) — that would force
            // CORP headers onto every plugin asset for no benefit we need today.
            (COOP, HeaderValue::from_static("same-origin")),
            (
                CONTENT_SECURITY_POLICY,
                HeaderValue::from_str(&page.csp)
                    .unwrap_or_else(|_| HeaderValue::from_static("default-src 'self'")),
            ),
        ],
        page.body,
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// File serving
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
enum CachePolicy {
    /// Content-hashed or version-scoped: cache for a year.
    Immutable,
    /// Revalidate every time (`sw.js`, the manifest, icons).
    Revalidate,
}

/// Resolve `relative` under `root`, refusing anything that escapes it.
///
/// Two checks, because either alone is insufficient: the lexical pass rejects `..` and
/// absolute segments before touching the filesystem, and the canonicalization pass
/// catches symlinks pointing out of the tree (SPEC §6.2 rejects those at install time
/// too, and this is the serving-side equivalent).
fn resolve_within(root: &Path, relative: &str) -> Option<PathBuf> {
    if relative.contains('\0') {
        return None;
    }
    let mut candidate = root.to_path_buf();
    for segment in relative.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        let path = Path::new(segment);
        if path.components().count() != 1
            || !matches!(path.components().next(), Some(Component::Normal(_)))
        {
            return None;
        }
        candidate.push(segment);
    }

    let canonical_root = root.canonicalize().ok()?;
    let canonical = candidate.canonicalize().ok()?;
    if !canonical.starts_with(&canonical_root) {
        return None;
    }
    if !canonical.is_file() {
        return None;
    }
    Some(canonical)
}

async fn serve_file(path: &Path, policy: CachePolicy) -> Response {
    let Ok(file) = tokio::fs::File::open(path).await else {
        return not_found();
    };
    let mime = content_type(path);
    let inline = INLINE_SAFE_TYPES.iter().any(|safe| mime.starts_with(safe));

    let stream = tokio_util::io::ReaderStream::new(file);
    let mut response = Response::new(Body::from_stream(stream));
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(NOSNIFF, HeaderValue::from_static("nosniff"));
    headers.insert(
        CACHE_CONTROL,
        match policy {
            CachePolicy::Immutable => {
                HeaderValue::from_static("public, max-age=31536000, immutable")
            }
            CachePolicy::Revalidate => HeaderValue::from_static("no-cache"),
        },
    );
    if !inline {
        // An `image/svg+xml` inside a plugin package is executable content from the
        // app's own origin; the same rule as attachments (SPEC §3.6).
        headers.insert(CONTENT_DISPOSITION, HeaderValue::from_static("attachment"));
    }
    response
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [
            (
                CONTENT_TYPE,
                HeaderValue::from_static("text/plain; charset=utf-8"),
            ),
            (NOSNIFF, HeaderValue::from_static("nosniff")),
        ],
        "not found\n",
    )
        .into_response()
}

/// Content type from the extension. Small on purpose: this serves our own build output
/// and plugin packages, not arbitrary uploads (those go through `attachments.rs`, which
/// sniffs the bytes).
fn content_type(path: &Path) -> &'static str {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if name.ends_with(".d.ts") {
        return "text/plain; charset=utf-8";
    }
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("webmanifest") => "application/manifest+json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("wasm") => "application/wasm",
        Some("woff2") => "font/woff2",
        Some("txt" | "md" | "ts" | "tsx") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 128 bits of randomness, base64url — a CSP nonce must be unguessable per response.
fn nonce() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolution_refuses_to_leave_the_root() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        assert!(resolve_within(root, "Cargo.toml").is_some());
        assert!(resolve_within(root, "./Cargo.toml").is_some());
        assert!(resolve_within(root, "../Cargo.toml").is_none());
        assert!(resolve_within(root, "src/../Cargo.toml").is_none());
        assert!(resolve_within(root, "/etc/passwd").is_none());
        assert!(
            resolve_within(root, "src").is_none(),
            "a directory is not a file"
        );
        assert!(resolve_within(root, "nope.txt").is_none());
    }

    #[test]
    fn content_types_cover_the_bundle_and_the_contract() {
        assert_eq!(
            content_type(Path::new("a/index.mjs")),
            "application/javascript; charset=utf-8"
        );
        assert_eq!(
            content_type(Path::new("a/style.css")),
            "text/css; charset=utf-8"
        );
        assert_eq!(
            content_type(Path::new("kernel.d.ts")),
            "text/plain; charset=utf-8"
        );
        assert_eq!(
            content_type(Path::new("a/app.webmanifest")),
            "application/manifest+json; charset=utf-8"
        );
        assert_eq!(content_type(Path::new("a/core.wasm")), "application/wasm");
        assert_eq!(
            content_type(Path::new("a/blob.bin")),
            "application/octet-stream"
        );
    }

    #[test]
    fn scriptable_documents_are_never_served_inline() {
        // The inline allowlist is what decides `Content-Disposition`. Neither SVG nor HTML
        // may be on it: both are scripted contexts on our own origin, and `serve_file`
        // sends no CSP (SPEC §3.6 — stored XSS from our own origin).
        assert!(!INLINE_SAFE_TYPES.contains(&"image/svg+xml"));
        assert!(!INLINE_SAFE_TYPES.contains(&"text/html"));
        assert!(
            !INLINE_SAFE_TYPES
                .iter()
                .any(|safe| content_type(Path::new("a/page.html")).starts_with(safe)),
            "an .html file inside a plugin package must download, not render"
        );
    }

    #[test]
    fn only_the_frontend_directory_of_a_package_is_reachable() {
        assert!(is_frontend_path("frontend/index.mjs"));
        assert!(is_frontend_path("frontend/assets/logo.png"));
        // Spellings the resolver treats as identical have to answer identically here.
        assert!(is_frontend_path("./frontend/index.mjs"));
        assert!(is_frontend_path("frontend//index.mjs"));
        // The manifest is what `/api/plugins` is authenticated to protect, and
        // `backend.wasm` is server-side code. Neither is a browser asset.
        assert!(!is_frontend_path("manifest.json"));
        assert!(!is_frontend_path("backend.wasm"));
        assert!(!is_frontend_path("frontend"));
        assert!(!is_frontend_path("frontendish/index.mjs"));
        assert!(!is_frontend_path(""));
    }

    #[test]
    fn nonces_are_unguessable_and_unique() {
        let a = nonce();
        let b = nonce();
        assert_ne!(a, b);
        assert!(a.len() >= 20);
    }

    fn imports() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("react".to_string(), "/runtime/react-abc.js".to_string()),
            ("@kernel".to_string(), "/runtime/kernel-def.js".to_string()),
        ])
    }

    #[test]
    fn the_marker_becomes_a_nonced_inline_import_map() {
        let html = format!("<head>{IMPORT_MAP_MARKER}</head>");
        let page = render_index(&html, &imports(), "NONCE1");

        assert!(!page.body.contains(IMPORT_MAP_MARKER), "marker survived");
        assert!(
            page.body
                .contains("<script type=\"importmap\" nonce=\"NONCE1\">")
        );
        assert!(page.body.contains("\"react\":\"/runtime/react-abc.js\""));
        assert!(page.body.contains("\"@kernel\":\"/runtime/kernel-def.js\""));
        // The nonce in the document and the nonce in the policy are one value; if they
        // ever diverge the map is blocked and every bare specifier fails to resolve.
        assert!(page.csp.contains("'nonce-NONCE1'"));
    }

    #[test]
    fn a_bundle_without_the_marker_is_served_unchanged_rather_than_refused() {
        // Degraded, not fatal: the page loads and the loader reports the failure. The
        // log line in `render_index` is what points at the cause.
        let page = render_index("<head></head>", &imports(), "N");
        assert_eq!(page.body, "<head></head>");
    }

    #[test]
    fn the_policy_is_spec_8_plus_the_documented_deviations() {
        let csp = render_index(IMPORT_MAP_MARKER, &imports(), "N").csp;
        for directive in [
            "default-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
        ] {
            assert!(csp.contains(directive), "SPEC §8 lost `{directive}`");
        }
        // The deviations, each pinned so removing one is a deliberate act:
        assert!(csp.contains("worker-src 'self' blob:"), "the search worker");
        assert!(csp.contains("connect-src 'self' ws: wss:"), "/api/sync");
        // Audio and video attachments are played from an object URL, so `blob:` here is
        // the whole feature and not a convenience: without `media-src` the directive fell
        // back to `default-src 'self'` and `<audio src="blob:…">` was refused.
        assert!(
            csp.contains("media-src 'self' blob:"),
            "audio/video attachments"
        );
        assert!(csp.contains("frame-src 'self' blob:"), "PDF attachments");

        // `script-src` is asserted whole. It is the one directive where an extra source
        // is a hole rather than a loosening: no `'unsafe-eval'` (only the narrow Wasm
        // form), no `blob:` and no `data:` (either would let a plugin promote arbitrary
        // text to a top-level script), no `'unsafe-inline'` (the nonce is the point).
        let script_src = csp
            .split("; ")
            .find(|directive| directive.starts_with("script-src "))
            .expect("script-src is present");
        assert_eq!(script_src, "script-src 'self' 'nonce-N' 'wasm-unsafe-eval'");
    }
}

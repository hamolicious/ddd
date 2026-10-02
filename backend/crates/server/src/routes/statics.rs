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

pub const IMPORT_MAP_MARKER: &str = "<!--DDD_IMPORT_MAP-->";

pub const RUNTIME_MANIFEST_FILE: &str = "runtime-manifest.json";

const NOSNIFF: HeaderName = HeaderName::from_static("x-content-type-options");

const COOP: HeaderName = HeaderName::from_static("cross-origin-opener-policy");

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

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/importmap.json", get(import_map))
        .route("/kernel.d.ts", get(kernel_dts))
        .route("/plugins/{id}/{version}/{*path}", get(plugin_asset))
}

pub fn api_router() -> Router<AppState> {
    Router::new().route("/", get(installed))
}

#[derive(Debug, Serialize)]
pub struct InstalledResponse {
    pub plugins: Vec<InstalledPlugin>,
    pub problems: Vec<plugins::PluginProblem>,
    pub disabled: bool,
    pub load: LoadResponse,
}

#[derive(Debug, Serialize)]
pub struct LoadResponse {
    #[serde(flatten)]
    pub plan: plugins::LoadPlan,
    pub version: String,
}

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

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ImportMap {
    pub imports: BTreeMap<String, String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct RuntimeManifest {
    pub imports: BTreeMap<String, String>,
    #[serde(default)]
    pub versions: BTreeMap<String, String>,
}

pub fn runtime_imports(state: &AppState) -> BTreeMap<String, String> {
    runtime_manifest(state).imports
}

pub fn page_imports(state: &AppState, signed_in: bool) -> BTreeMap<String, String> {
    let mut imports = runtime_imports(state);
    if signed_in {
        imports.extend(plugins::registry(&state.config).plugin_imports());
    }
    imports
}

fn is_signed_in(user: Result<MaybeAuthUser, AppError>) -> bool {
    matches!(user, Ok(MaybeAuthUser(Some(_))))
}

pub fn runtime_versions(state: &AppState) -> BTreeMap<String, String> {
    runtime_manifest(state).versions
}

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

pub async fn import_map(
    State(state): State<AppState>,
    user: Result<MaybeAuthUser, AppError>,
) -> Response {
    let imports = runtime_imports(&state);
    let registry = plugins::registry(&state.config);

    let resolution = plugins::resolve_import_map(&registry, &imports, &runtime_versions(&state));
    if !resolution.missing.is_empty() {
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
            (CACHE_CONTROL, HeaderValue::from_static("no-cache")),
        ],
        body,
    )
        .into_response()
}

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

const PLUGIN_ASSET_ROOT: &str = "frontend";

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
    if !is_frontend_path(&path) {
        return not_found();
    }

    let base = root.join(&id).join(&version);
    match resolve_within(&base, &path) {
        Some(file) => serve_file(&file, CachePolicy::Immutable).await,
        None => not_found(),
    }
}

fn is_frontend_path(path: &str) -> bool {
    let mut segments = path
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".");
    segments.next() == Some(PLUGIN_ASSET_ROOT) && segments.next().is_some()
}

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

    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();

    if segments == ["index.html"] {
        return index_html(&state, &dist, signed_in).await;
    }
    if !segments.is_empty()
        && let Some(file) = resolve_within(&dist, &segments.join("/"))
    {
        let policy = match segments.first() {
            Some(&"assets") | Some(&"runtime") => CachePolicy::Immutable,
            _ => CachePolicy::Revalidate,
        };
        return serve_file(&file, policy).await;
    }

    index_html(&state, &dist, signed_in).await
}

struct IndexPage {
    body: String,
    csp: String,
}

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
        warn!(
            "index.html has no {IMPORT_MAP_MARKER} marker; bare specifiers will not resolve the runtime layer"
        );
        html.to_string()
    }
}

fn render_index(html: &str, imports: &BTreeMap<String, String>, nonce: &str) -> IndexPage {
    let body = render_index_body(html, imports, nonce);

    let csp = format!(
        "default-src 'self'; script-src 'self' 'nonce-{nonce}' 'wasm-unsafe-eval'; \
         style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
         media-src 'self' blob:; frame-src 'self' blob:; font-src 'self'; \
         connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; \
         base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );

    IndexPage { body, csp }
}

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
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (REFERRER_POLICY, HeaderValue::from_static("same-origin")),
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

#[derive(Debug, Clone, Copy)]
enum CachePolicy {
    Immutable,
    Revalidate,
}

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
        assert!(is_frontend_path("./frontend/index.mjs"));
        assert!(is_frontend_path("frontend//index.mjs"));
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
    fn the_shipped_index_html_carries_the_import_map_marker() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../web/app/index.html");
        let html = std::fs::read_to_string(&path).unwrap();
        assert!(
            html.contains(IMPORT_MAP_MARKER),
            "{} has no {IMPORT_MAP_MARKER}",
            path.display()
        );
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
        assert!(page.csp.contains("'nonce-NONCE1'"));
    }

    #[test]
    fn a_bundle_without_the_marker_is_served_unchanged_rather_than_refused() {
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
        assert!(csp.contains("worker-src 'self' blob:"), "the search worker");
        assert!(csp.contains("connect-src 'self' ws: wss:"), "/api/sync");
        assert!(
            csp.contains("media-src 'self' blob:"),
            "audio/video attachments"
        );
        assert!(csp.contains("frame-src 'self' blob:"), "PDF attachments");

        let script_src = csp
            .split("; ")
            .find(|directive| directive.starts_with("script-src "))
            .expect("script-src is present");
        assert_eq!(script_src, "script-src 'self' 'nonce-N' 'wasm-unsafe-eval'");
    }
}

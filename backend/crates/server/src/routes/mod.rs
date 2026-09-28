//! Router assembly. **Wiring only** — no handlers live here.
//!
//! Owned by the http-routes area, but every builder reads it: it is the map of
//! which path belongs to which file.
//!
//! ```text
//! /healthz, /readyz, /metrics      -> health.rs, telemetry.rs   (unauthenticated)
//! /api/auth/*                      -> auth.rs
//! /api/documents*                  -> documents.rs              (authenticated)
//! /api/attachments*                -> attachments.rs            (authenticated)
//! /api/uploads*                    -> uploads.rs                (authenticated)
//! /api/admin/*                     -> admin.rs                  (admin only)
//! /api/sync, /api/sync/bootstrap   -> sync.rs                   (authenticated)
//! /api/plugins                     -> statics.rs                (authenticated)
//! /api/plugins/:id/*               -> plugin_api.rs             (session, or public per manifest)
//! /api/admin/plugins/*             -> plugin_api.rs             (admin only)
//! /api/wiring, /api/wiring/*       -> wiring.rs                 (admin only; the wiring store)
//! /api/shell/*                     -> shell.rs                  (authenticated; M5 bundle manifest)
//! /importmap.json, /kernel.d.ts    -> statics.rs                (public)
//! /plugins/:id/:version/*          -> statics.rs                (public, immutable)
//! everything else (GET)            -> statics.rs                (the PWA + SPA fallback)
//! ```

pub mod admin;
pub mod attachments;
pub mod auth;
pub mod changes;
pub mod documents;
pub mod health;
pub mod plugin_api;
pub mod shell;
pub mod statics;
pub mod sync;
pub mod uploads;
pub mod wiring;

use std::time::Duration;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::http::{HeaderName, HeaderValue, Method, header};
use axum::routing::get;
use metrics_exporter_prometheus::PrometheusHandle;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::TraceLayer;

use crate::state::AppState;
use crate::telemetry;

/// Header carrying the request id through logs and responses (SPEC §8).
pub const REQUEST_ID_HEADER: &str = "x-request-id";

/// Body limit for JSON endpoints. Document text is capped separately, by the
/// shared core's limit, with a clearer error (SPEC §3.5).
pub const JSON_BODY_LIMIT: usize = 2 * 1024 * 1024;

/// Assemble the whole application router.
pub fn router(state: AppState, metrics: PrometheusHandle) -> Router {
    let api = Router::new()
        .nest("/auth", auth::router())
        .nest("/documents", documents::router())
        .nest("/attachments", attachments::router())
        .nest("/uploads", uploads::router())
        .nest("/admin", admin::router())
        // M4: plugin management lives beside the rest of admin but in its own file —
        // `plugin_api.rs` owns both halves of the plugin HTTP surface (the admin screens
        // and the inbound dispatch), because the route table is the same resource.
        .nest("/admin/plugins", plugin_api::admin_router())
        // PLUGIN-PROTOCOLS step 7: the wiring store's admin surface — the live version, the
        // history, and the one route that applies a draft (`wiring.rs`). Admin-only like
        // `/api/admin/*`, but its own nest: it is the store's surface, not the user admin's.
        .nest("/wiring", wiring::router())
        // The installed-plugin list (M3) and the per-plugin route dispatch (M4) share the
        // `/api/plugins` prefix: `GET /` is the list, `/{id}/{*path}` reaches a backend
        // half. Merged rather than nested twice — axum resolves `/` and `/{id}/{*path}`
        // without ambiguity, and one nest keeps the body limit and the layer stack single.
        .nest(
            "/plugins",
            statics::api_router().merge(plugin_api::router()),
        )
        // M5: the Flutter shell's bundle manifest and the two files it cannot fetch from
        // a static route byte-stably (`shell.rs`, `app/BRIDGE.md` §5). Inside the JSON
        // body limit like the rest of `/api` — both routes are GETs with no body.
        .nest("/shell", shell::router())
        .layer(DefaultBodyLimit::max(JSON_BODY_LIMIT))
        // Merged *outside* the body limit: `/api/sync` is a WebSocket upgrade (no
        // request body at all) and `/api/sync/bootstrap` streams a response, so a
        // request-body cap is meaningless on both. Frame and page sizes are bounded
        // by the protocol instead (PROTOCOL.md §6).
        .merge(sync::router());

    let metrics_router = Router::new()
        .route("/metrics", get(telemetry::metrics_handler))
        .with_state(metrics);

    Router::new()
        .merge(health::router())
        .nest("/api", api)
        // The PWA, the import map, the plugin modules and `kernel.d.ts` (SPEC §6.4, §8).
        // Merged at the root: `/plugins/...` is a *client-facing* URL, deliberately not
        // under `/api`, because it is immutable cacheable content rather than an API.
        .merge(statics::router())
        // Any unmatched GET is a client-side route — `index.html`. `/api/**` is
        // excluded inside the handler so an API 404 stays JSON.
        .fallback(statics::fallback)
        .with_state(state.clone())
        .merge(metrics_router)
        .layer(cors_layer(&state))
        .layer(PropagateRequestIdLayer::new(HeaderName::from_static(
            REQUEST_ID_HEADER,
        )))
        // Inside `SetRequestIdLayer`, so the span, the log lines and the echoed
        // header all carry the same id; outside the router, so `/healthz`,
        // `/readyz` and `/metrics` are counted too (SPEC §8).
        .layer(axum::middleware::from_fn(telemetry::http_observability))
        .layer(TraceLayer::new_for_http())
        .layer(SetRequestIdLayer::new(
            HeaderName::from_static(REQUEST_ID_HEADER),
            MakeRequestUuid,
        ))
}

/// CORS for the PWA origin(s) in `APP_ORIGIN`. Credentials are allowed because
/// the browser client authenticates with a cookie; with no configured origin the
/// layer stays same-origin only.
///
/// Everything is an explicit allowlist — `Any` is not usable alongside
/// `allow_credentials(true)` (tower-http rejects the combination, and the CORS
/// spec forbids it), and an echo-the-origin implementation would make the
/// `APP_ORIGIN` allowlist of SPEC §4.3 decorative.
fn cors_layer(state: &AppState) -> CorsLayer {
    let origins: Vec<HeaderValue> = state
        .config
        .app_origins
        .iter()
        .filter_map(|origin| HeaderValue::from_str(origin).ok())
        .collect();

    // No `APP_ORIGIN` (or none parseable): send no CORS headers at all, which
    // leaves the API same-origin only. Same-origin requests never consult CORS,
    // so a single-origin deployment needs no configuration.
    if origins.is_empty() {
        return CorsLayer::new();
    }

    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::ACCEPT,
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::IF_MATCH,
            header::IF_NONE_MATCH,
            HeaderName::from_static(REQUEST_ID_HEADER),
        ])
        // Response headers the client reads programmatically: `Location` after a
        // document create, the CRDT state vector next to `?format=crdt`, `ETag`
        // for attachment revalidation.
        .expose_headers([
            header::LOCATION,
            header::ETAG,
            header::CONTENT_DISPOSITION,
            HeaderName::from_static(REQUEST_ID_HEADER),
            HeaderName::from_static("x-state-vector"),
        ])
        .max_age(Duration::from_secs(600))
}

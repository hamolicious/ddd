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
//! /api/admin/*                     -> admin.rs                  (admin only)
//! /api/sync, /api/sync/bootstrap   -> sync.rs                   (authenticated)
//! ```

pub mod admin;
pub mod attachments;
pub mod auth;
pub mod documents;
pub mod health;
pub mod sync;

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
        .nest("/admin", admin::router())
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

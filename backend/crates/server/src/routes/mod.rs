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

pub const REQUEST_ID_HEADER: &str = "x-request-id";

pub const JSON_BODY_LIMIT: usize = 2 * 1024 * 1024;

pub fn router(state: AppState, metrics: PrometheusHandle) -> Router {
    let api = Router::new()
        .nest("/auth", auth::router())
        .nest("/documents", documents::router())
        .route("/query", axum::routing::post(documents::query))
        .nest("/attachments", attachments::router())
        .nest("/uploads", uploads::router())
        .nest("/admin", admin::router())
        .nest("/admin/plugins", plugin_api::admin_router())
        .nest(
            "/plugins",
            statics::api_router().merge(plugin_api::router()),
        )
        .nest("/shell", shell::router())
        .layer(DefaultBodyLimit::max(JSON_BODY_LIMIT))
        .merge(sync::router());

    let metrics_router = Router::new()
        .route("/metrics", get(telemetry::metrics_handler))
        .with_state(metrics);

    Router::new()
        .merge(health::router())
        .nest("/api", api)
        .merge(statics::router())
        .fallback(statics::fallback)
        .with_state(state.clone())
        .merge(metrics_router)
        .layer(cors_layer(&state))
        .layer(PropagateRequestIdLayer::new(HeaderName::from_static(
            REQUEST_ID_HEADER,
        )))
        .layer(axum::middleware::from_fn(telemetry::http_observability))
        .layer(TraceLayer::new_for_http())
        .layer(SetRequestIdLayer::new(
            HeaderName::from_static(REQUEST_ID_HEADER),
            MakeRequestUuid,
        ))
}

fn cors_layer(state: &AppState) -> CorsLayer {
    let origins: Vec<HeaderValue> = state
        .config
        .app_origins
        .iter()
        .filter_map(|origin| HeaderValue::from_str(origin).ok())
        .collect();

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
        .expose_headers([
            header::LOCATION,
            header::ETAG,
            header::CONTENT_DISPOSITION,
            HeaderName::from_static(REQUEST_ID_HEADER),
            HeaderName::from_static("x-state-vector"),
        ])
        .max_age(Duration::from_secs(600))
}

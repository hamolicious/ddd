use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::extract::Request;
use axum::http::{HeaderName, HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use metrics::{counter, describe_counter, describe_gauge, describe_histogram, gauge, histogram};
use metrics_exporter_prometheus::{Matcher, PrometheusBuilder, PrometheusHandle};
use tracing::Instrument;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, fmt};

use crate::config::{Config, LogFormat};

pub mod names {
    pub const HTTP_REQUESTS: &str = "ddd_http_requests_total";
    pub const HTTP_LATENCY: &str = "ddd_http_request_duration_seconds";
    pub const DOCUMENTS_TOTAL: &str = "ddd_documents_total";
    pub const UPDATES_APPLIED: &str = "ddd_crdt_updates_applied_total";
    pub const MATERIALIZE_LATENCY: &str = "ddd_materialize_duration_seconds";
    pub const MATERIALIZE_FAILURES: &str = "ddd_materialize_failures_total";
    pub const ROOMS: &str = "ddd_rooms";
    pub const DIRTY_ROOMS: &str = "ddd_rooms_dirty";
    pub const OVERSIZED_DOCS: &str = "ddd_documents_oversized";
    pub const ATTACHMENT_BYTES: &str = "ddd_attachment_bytes_total";
    pub const LOGIN_FAILURES: &str = "ddd_login_failures_total";
    pub const WS_CONNECTIONS: &str = "ddd_ws_connections";
    pub const WS_SUBSCRIBED_DOCS: &str = "ddd_ws_subscribed_documents";
    pub const FEED_HEAD_SEQ: &str = "ddd_feed_head_seq";
    pub const FEED_SAFE_SEQ: &str = "ddd_feed_safe_seq";
    pub const FEED_SUBSCRIBERS: &str = "ddd_feed_subscribers";
    pub const WS_BACKPRESSURE_DROPS: &str = "ddd_ws_backpressure_drops_total";

    pub const PLUGIN_CALLS: &str = "ddd_plugin_calls_total";
    pub const PLUGIN_CALL_LATENCY: &str = "ddd_plugin_call_duration_seconds";
    pub const PLUGIN_CALL_FAILURES: &str = "ddd_plugin_call_failures_total";
    pub const PLUGIN_ACTIVE: &str = "ddd_plugins_active";
    pub const PLUGIN_DISABLED: &str = "ddd_plugins_disabled";
    pub const PLUGIN_INSTANCES: &str = "ddd_plugin_instances";
    pub const PLUGIN_HOOKS_DELIVERED: &str = "ddd_plugin_hooks_delivered_total";
    pub const PLUGIN_HOOKS_PENDING: &str = "ddd_plugin_hooks_pending";
    pub const PLUGIN_HTTP_REQUESTS: &str = "ddd_plugin_http_requests_total";
    pub const PLUGIN_DOCUMENT_WRITES: &str = "ddd_plugin_document_writes_total";
    pub const PLUGIN_WRITES_REFUSED: &str = "ddd_plugin_write_cap_refusals_total";

    pub const CONFIG_MAX_DOCUMENT_BYTES: &str = "ddd_config_max_document_bytes";
    pub const CONFIG_MAX_ATTACHMENT_BYTES: &str = "ddd_config_max_attachment_bytes";
    pub const BUILD_INFO: &str = "ddd_build_info";
}

const HTTP_LATENCY_BUCKETS: &[f64] = &[
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];
const MATERIALIZE_LATENCY_BUCKETS: &[f64] = &[
    0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 5.0,
];

const UNKNOWN_ROUTE: &str = "other";

static TRACING: OnceLock<()> = OnceLock::new();
static METRICS: OnceLock<PrometheusHandle> = OnceLock::new();

pub fn init_tracing(format: LogFormat) -> anyhow::Result<()> {
    if TRACING.get().is_some() {
        return Ok(());
    }

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    let result = match format {
        LogFormat::Json => tracing_subscriber::registry()
            .with(filter)
            .with(
                fmt::layer()
                    .json()
                    .flatten_event(true)
                    .with_current_span(true)
                    .with_span_list(true)
                    .with_target(true),
            )
            .try_init(),
        LogFormat::Pretty => tracing_subscriber::registry()
            .with(filter)
            .with(fmt::layer().compact().with_target(true))
            .try_init(),
    };

    match result {
        Ok(()) => {
            let _ = TRACING.set(());
            Ok(())
        }
        Err(err) => {
            let _ = TRACING.set(());
            tracing::debug!(error = %err, "tracing subscriber already installed");
            Ok(())
        }
    }
}

pub fn init_metrics(config: &Config) -> anyhow::Result<PrometheusHandle> {
    static INSTALL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    if let Some(handle) = METRICS.get() {
        return Ok(handle.clone());
    }
    let _guard = INSTALL.lock().unwrap_or_else(|err| err.into_inner());
    if let Some(handle) = METRICS.get() {
        return Ok(handle.clone());
    }

    let handle = recorder_builder()?.install_recorder()?;

    describe();

    gauge!(names::CONFIG_MAX_DOCUMENT_BYTES).set(config.max_document_bytes as f64);
    gauge!(names::CONFIG_MAX_ATTACHMENT_BYTES).set(config.max_attachment_bytes as f64);
    gauge!(names::BUILD_INFO, "version" => crate::VERSION).set(1.0);

    let _ = METRICS.set(handle.clone());
    Ok(handle)
}

fn recorder_builder() -> anyhow::Result<PrometheusBuilder> {
    Ok(PrometheusBuilder::new()
        .set_buckets_for_metric(
            Matcher::Full(names::HTTP_LATENCY.to_string()),
            HTTP_LATENCY_BUCKETS,
        )?
        .set_buckets_for_metric(
            Matcher::Full(names::MATERIALIZE_LATENCY.to_string()),
            MATERIALIZE_LATENCY_BUCKETS,
        )?)
}

fn describe() {
    describe_counter!(
        names::HTTP_REQUESTS,
        "HTTP requests by method, route, status"
    );
    describe_histogram!(
        names::HTTP_LATENCY,
        metrics::Unit::Seconds,
        "HTTP request latency"
    );
    describe_gauge!(names::DOCUMENTS_TOTAL, "Documents stored (including trash)");
    describe_counter!(names::UPDATES_APPLIED, "CRDT updates applied");
    describe_histogram!(
        names::MATERIALIZE_LATENCY,
        metrics::Unit::Seconds,
        "Time to materialize content/title/fm/plugins for one document"
    );
    describe_counter!(names::MATERIALIZE_FAILURES, "Failed materialization passes");
    describe_gauge!(names::ROOMS, "Hot documents held in memory");
    describe_gauge!(names::DIRTY_ROOMS, "Rooms with unflushed materialization");
    describe_gauge!(
        names::OVERSIZED_DOCS,
        "Documents whose CRDT blob is above the compaction threshold"
    );
    describe_counter!(
        names::ATTACHMENT_BYTES,
        "Attachment bytes written to GridFS"
    );
    describe_counter!(names::LOGIN_FAILURES, "Failed login attempts");
    describe_gauge!(names::WS_CONNECTIONS, "Open WebSocket connections (M2)");
    describe_gauge!(
        names::WS_SUBSCRIBED_DOCS,
        "Documents with at least one subscriber (M2)"
    );
    describe_gauge!(
        names::FEED_HEAD_SEQ,
        "Highest change-feed sequence number allocated"
    );
    describe_gauge!(
        names::FEED_SAFE_SEQ,
        "Change-feed watermark clients persist as their resume point"
    );
    describe_gauge!(
        names::FEED_SUBSCRIBERS,
        "Sockets tailing the workspace change feed"
    );
    describe_counter!(
        names::WS_BACKPRESSURE_DROPS,
        "Send-queue overflows that cost a client a re-derivation, by queue"
    );
    describe_gauge!(
        names::CONFIG_MAX_DOCUMENT_BYTES,
        "Configured maximum document text size"
    );
    describe_gauge!(
        names::CONFIG_MAX_ATTACHMENT_BYTES,
        "Configured maximum attachment size"
    );
    describe_gauge!(
        names::BUILD_INFO,
        "Always 1; carries the build version label"
    );
}

pub async fn metrics_handler(
    axum::extract::State(handle): axum::extract::State<PrometheusHandle>,
) -> Response {
    let body = handle.render();
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
            ),
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store, max-age=0"),
            ),
        ],
        body,
    )
        .into_response()
}

pub async fn http_observability(mut request: Request, next: Next) -> Response {
    let header_name = request_id_header();

    let request_id = request
        .headers()
        .get(&header_name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .unwrap_or_else(new_request_id);

    if let Ok(value) = HeaderValue::from_str(&request_id) {
        request.headers_mut().insert(header_name.clone(), value);
    }

    let method = request.method().clone();
    let route = route_label(request.uri().path());
    let span = tracing::info_span!(
        "http_request",
        request_id = %request_id,
        method = %method,
        route = %route,
    );

    let started = Instant::now();
    let mut response = next.run(request).instrument(span.clone()).await;
    let elapsed = started.elapsed();
    let status = response.status();

    counter!(
        names::HTTP_REQUESTS,
        "method" => method.to_string(),
        "route" => route.clone(),
        "status" => status.as_u16().to_string(),
    )
    .increment(1);
    histogram!(
        names::HTTP_LATENCY,
        "method" => method.to_string(),
        "route" => route,
    )
    .record(elapsed.as_secs_f64());

    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().entry(header_name).or_insert(value);
    }

    span.in_scope(|| {
        tracing::info!(
            status = status.as_u16(),
            latency_ms = elapsed.as_millis() as u64,
            "request completed"
        );
    });

    response
}

fn request_id_header() -> HeaderName {
    HeaderName::from_static(crate::routes::REQUEST_ID_HEADER)
}

fn new_request_id() -> String {
    ulid::Ulid::generate().to_string()
}

fn route_label(path: &str) -> String {
    let mut label = String::with_capacity(path.len().min(64));

    for (index, segment) in path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .enumerate()
    {
        if index == 4 {
            label.push_str("/*");
            break;
        }
        label.push('/');
        if segment.len() > 32 || !segment.chars().all(is_label_safe) {
            label.push_str(UNKNOWN_ROUTE);
        } else if looks_like_id(segment) {
            label.push_str(":id");
        } else {
            label.push_str(segment);
        }
    }

    if label.is_empty() {
        label.push('/');
    }
    label
}

fn looks_like_id(segment: &str) -> bool {
    segment.len() >= 16 || segment.chars().any(|c| c.is_ascii_digit())
}

fn is_label_safe(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
}

pub async fn sample_gauges(state: &crate::state::AppState) {
    let stats = state.docs.stats();
    gauge!(names::ROOMS).set(stats.rooms as f64);
    gauge!(names::DIRTY_ROOMS).set(stats.dirty_rooms as f64);
    gauge!(names::OVERSIZED_DOCS).set(stats.oversized_docs as f64);

    gauge!(names::FEED_HEAD_SEQ).set(state.feed.head_seq() as f64);
    gauge!(names::FEED_SAFE_SEQ).set(state.feed.safe_seq() as f64);
    gauge!(names::FEED_SUBSCRIBERS).set(state.feed.subscriber_count() as f64);

    match state
        .collections
        .documents()
        .estimated_document_count()
        .await
    {
        Ok(count) => gauge!(names::DOCUMENTS_TOTAL).set(count as f64),
        Err(err) => tracing::debug!(error = %err, "document count sample failed"),
    }
}

pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};

        let mut sigterm = match signal(SignalKind::terminate()) {
            Ok(stream) => stream,
            Err(err) => {
                tracing::error!(error = %err, "cannot listen for SIGTERM");
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };

        tokio::select! {
            _ = sigterm.recv() => tracing::info!(signal = "SIGTERM", "shutdown requested"),
            result = tokio::signal::ctrl_c() => match result {
                Ok(()) => tracing::info!(signal = "SIGINT", "shutdown requested"),
                Err(err) => tracing::error!(error = %err, "cannot listen for SIGINT"),
            },
        }
    }

    #[cfg(not(unix))]
    {
        match tokio::signal::ctrl_c().await {
            Ok(()) => tracing::info!(signal = "SIGINT", "shutdown requested"),
            Err(err) => tracing::error!(error = %err, "cannot listen for SIGINT"),
        }
    }
}

pub fn spawn_shutdown_watchdog(grace: Duration) {
    tokio::spawn(async move {
        tokio::time::sleep(grace).await;
        tracing::error!(
            grace_secs = grace.as_secs(),
            "graceful shutdown exceeded its grace period; exiting now"
        );
        std::process::exit(1);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn metrics_handler_renders_prometheus_text() {
        let recorder = recorder_builder().expect("builder").build_recorder();
        let handle = recorder.handle();
        metrics::with_local_recorder(&recorder, || {
            describe();
            counter!(names::HTTP_REQUESTS, "route" => "/healthz").increment(1);
            histogram!(names::HTTP_LATENCY, "route" => "/healthz").record(0.004);
        });

        let response = metrics_handler(axum::extract::State(handle)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("text/plain; version=0.0.4; charset=utf-8")
        );

        let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("body");
        let body = String::from_utf8(body.to_vec()).expect("utf-8");
        assert!(body.contains(names::HTTP_REQUESTS), "{body}");
        assert!(
            body.contains("# HELP ddd_http_requests_total HTTP requests"),
            "{body}"
        );
        assert!(
            body.contains("ddd_http_request_duration_seconds_bucket"),
            "{body}"
        );
    }

    #[test]
    fn route_labels_collapse_identifiers() {
        assert_eq!(route_label("/healthz"), "/healthz");
        assert_eq!(route_label("/"), "/");
        assert_eq!(route_label("/api/documents"), "/api/documents");
        assert_eq!(
            route_label("/api/documents/01JBQZ0X9V8M0000000000AAAA"),
            "/api/documents/:id"
        );
        assert_eq!(
            route_label("/api/documents/01JBQZ0X9V8M0000000000AAAA/snapshots"),
            "/api/documents/:id/snapshots"
        );
    }

    #[test]
    fn route_labels_are_bounded() {
        let deep = route_label("/api/documents/01JBQZ0X9V8M0000000000AAAA/snapshots/xyz/more/more");
        assert!(deep.ends_with("/*"), "{deep}");
        assert!(deep.len() <= 64, "{deep}");

        let hostile = route_label(&format!("/api/{}", "a".repeat(200)));
        assert_eq!(hostile, "/api/other");
    }
}

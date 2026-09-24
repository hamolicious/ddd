//! Tracing and metrics setup (SPEC §8): JSON logs with request ids, Prometheus
//! `/metrics`.
//!
//! Owned by the **ops** area. `routes/mod.rs` mounts [`metrics_handler`]; nobody
//! else registers metrics recorders or subscribers.

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

/// Metric names, so emitters and dashboards cannot drift (SPEC §8).
pub mod names {
    pub const HTTP_REQUESTS: &str = "lm_http_requests_total";
    pub const HTTP_LATENCY: &str = "lm_http_request_duration_seconds";
    pub const DOCUMENTS_TOTAL: &str = "lm_documents_total";
    pub const UPDATES_APPLIED: &str = "lm_crdt_updates_applied_total";
    pub const MATERIALIZE_LATENCY: &str = "lm_materialize_duration_seconds";
    pub const MATERIALIZE_FAILURES: &str = "lm_materialize_failures_total";
    pub const ROOMS: &str = "lm_rooms";
    pub const DIRTY_ROOMS: &str = "lm_rooms_dirty";
    pub const OVERSIZED_DOCS: &str = "lm_documents_oversized";
    pub const ATTACHMENT_BYTES: &str = "lm_attachment_bytes_total";
    pub const LOGIN_FAILURES: &str = "lm_login_failures_total";
    /// M2: WebSocket connections and subscribed docs.
    pub const WS_CONNECTIONS: &str = "lm_ws_connections";
    pub const WS_SUBSCRIBED_DOCS: &str = "lm_ws_subscribed_documents";
    /// M2: the workspace change feed (PROTOCOL.md §2.2). `HEAD` is the highest
    /// number handed out, `SAFE` the watermark clients persist; a widening gap
    /// between them means writes are sitting in flight, which is the signal that
    /// the feed is stalling. `SUBSCRIBERS` counts the in-process notification
    /// receivers, i.e. sockets tailing the feed.
    pub const FEED_HEAD_SEQ: &str = "lm_feed_head_seq";
    pub const FEED_SAFE_SEQ: &str = "lm_feed_safe_seq";
    pub const FEED_SUBSCRIBERS: &str = "lm_feed_subscribers";
    /// M2: send-queue overflows, labelled `queue="feed"|"doc"|"plugin"`. Every
    /// increment on `feed` or `doc` is a client that was told to re-derive
    /// (PROTOCOL.md §6) — cheap, but a sustained rate means the bounds are wrong for
    /// the workload. `plugin` (M4) is a dropped `plugin.event` frame, which is
    /// ephemeral by design (SPEC §6.3: no offline replay) — a chatty plugin loses
    /// events rather than closing everybody's socket.
    pub const WS_BACKPRESSURE_DROPS: &str = "lm_ws_backpressure_drops_total";

    /// M4: the plugin host (SPEC §8 names "hook latency/failures, wasm timeouts").
    ///
    /// All of them are labelled `plugin="<id>"`, and the call metrics additionally by
    /// `kind="hook"|"cron"|"route"|"call"|"event"|"init"` — which is what makes "the
    /// calendar's cron is slow" and "something is hammering a plugin route" different
    /// lines on a dashboard rather than one average.
    pub const PLUGIN_CALLS: &str = "lm_plugin_calls_total";
    pub const PLUGIN_CALL_LATENCY: &str = "lm_plugin_call_duration_seconds";
    /// Labelled `outcome="refused"|"timeout"|"trap"|"bad_response"|"unavailable"`. A
    /// refusal is the plugin working; the other four are the breaker's input.
    pub const PLUGIN_CALL_FAILURES: &str = "lm_plugin_call_failures_total";
    pub const PLUGIN_ACTIVE: &str = "lm_plugins_active";
    pub const PLUGIN_DISABLED: &str = "lm_plugins_disabled";
    pub const PLUGIN_INSTANCES: &str = "lm_plugin_instances";
    /// Hook deliveries and the debounce backlog (SPEC §6.3).
    pub const PLUGIN_HOOKS_DELIVERED: &str = "lm_plugin_hooks_delivered_total";
    pub const PLUGIN_HOOKS_PENDING: &str = "lm_plugin_hooks_pending";
    /// Outbound requests, labelled `outcome="ok"|"blocked"|"timeout"|"too_large"`. The
    /// `blocked` series is the one to alert on: a plugin repeatedly aiming at a refused
    /// address is either misconfigured or probing.
    pub const PLUGIN_HTTP_REQUESTS: &str = "lm_plugin_http_requests_total";
    /// Document writes made by plugins, and the ones the per-document cap refused.
    pub const PLUGIN_DOCUMENT_WRITES: &str = "lm_plugin_document_writes_total";
    pub const PLUGIN_WRITES_REFUSED: &str = "lm_plugin_write_cap_refusals_total";

    /// Effective limits, published so a dashboard can draw the ceiling next to
    /// the usage it is comparing against.
    pub const CONFIG_MAX_DOCUMENT_BYTES: &str = "lm_config_max_document_bytes";
    pub const CONFIG_MAX_ATTACHMENT_BYTES: &str = "lm_config_max_attachment_bytes";
    /// `1`, carrying the build version as a label.
    pub const BUILD_INFO: &str = "lm_build_info";
}

/// Latency buckets for HTTP handlers: sub-millisecond up to ten seconds.
const HTTP_LATENCY_BUCKETS: &[f64] = &[
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];
/// Materialization is a parse + one Mongo write; it lives in the milliseconds.
const MATERIALIZE_LATENCY_BUCKETS: &[f64] = &[
    0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 5.0,
];

/// Label value used when a path cannot be reduced to a low-cardinality route.
const UNKNOWN_ROUTE: &str = "other";

/// Set once `init_tracing` has installed a global subscriber, so repeated calls
/// (integration tests build several `AppState`s) are no-ops rather than errors.
static TRACING: OnceLock<()> = OnceLock::new();
/// The installed Prometheus handle. The recorder is process-global, so
/// `init_metrics` must be idempotent for the same reason.
static METRICS: OnceLock<PrometheusHandle> = OnceLock::new();

/// Install the tracing subscriber. Call exactly once, first thing in `main`.
/// `RUST_LOG` selects levels; `LOG_FORMAT` selects JSON vs pretty.
///
/// JSON is the deployed format: one object per event, the event's own fields
/// flattened in, and the enclosing span list retained so every line inside a
/// request carries that request's `request_id` (SPEC §8).
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
                // The default timer is already RFC-3339 UTC.
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
        // Another subscriber is already installed (a test harness, a second
        // call): that is not a reason to refuse to boot.
        Err(err) => {
            let _ = TRACING.set(());
            tracing::debug!(error = %err, "tracing subscriber already installed");
            Ok(())
        }
    }
}

/// Install the Prometheus recorder and return the scrape handle.
///
/// Histograms are rendered as true Prometheus histograms (explicit buckets)
/// rather than summaries, so latency is aggregatable across scrapes.
/// Idempotent, and idempotent *under concurrency*: the recorder is
/// process-global, so installing it and publishing the handle must happen as one
/// critical section. Checking the `OnceLock` and then installing would let two
/// threads both see "not installed" and race, and the loser of
/// `install_recorder()` would fail a perfectly valid `AppState::new`. Integration
/// tests build several states in parallel, so this is a real path, not a
/// theoretical one.
pub fn init_metrics(config: &Config) -> anyhow::Result<PrometheusHandle> {
    static INSTALL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    if let Some(handle) = METRICS.get() {
        return Ok(handle.clone());
    }
    let _guard = INSTALL.lock().unwrap_or_else(|err| err.into_inner());
    // Re-check under the lock: another thread may have finished while we waited.
    if let Some(handle) = METRICS.get() {
        return Ok(handle.clone());
    }

    let handle = recorder_builder()?.install_recorder()?;

    describe();

    // Publish the effective limits once; they only change on restart.
    gauge!(names::CONFIG_MAX_DOCUMENT_BYTES).set(config.max_document_bytes as f64);
    gauge!(names::CONFIG_MAX_ATTACHMENT_BYTES).set(config.max_attachment_bytes as f64);
    gauge!(names::BUILD_INFO, "version" => crate::VERSION).set(1.0);

    let _ = METRICS.set(handle.clone());
    Ok(handle)
}

/// The recorder configuration, shared with the tests so they exercise the real
/// bucket setup: with explicit buckets a histogram renders as a Prometheus
/// histogram (aggregatable across scrapes) instead of a summary.
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

/// Register descriptions and units, so `/metrics` carries `# HELP` / `# TYPE`
/// lines for everything that has been emitted.
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

/// `GET /metrics` — Prometheus text format. Unauthenticated; expose it only on
/// the internal network (documented in OPERATIONS).
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

/// Per-request observability: a request-id span around the handler plus the two
/// HTTP metrics. Applied in `main` as the outermost layer, so it also covers
/// `/healthz`, `/readyz` and `/metrics`.
///
/// The id is taken from an inbound `x-request-id` when present (a proxy may have
/// minted it) and otherwise generated here, then written onto the request so
/// `tower_http`'s `SetRequestIdLayer` — which never overwrites an existing header
/// — agrees with the span and the response header.
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

/// Request ids are ULIDs like every other id in the system — sortable, and
/// greppable across logs, audit entries and client reports.
fn new_request_id() -> String {
    ulid::Ulid::generate().to_string()
}

/// Reduce a request path to a bounded label.
///
/// This layer sits outside the router, so axum's `MatchedPath` is not available
/// yet; document ids would otherwise blow up the metric's cardinality. Segments
/// that look like identifiers collapse to `:id`, and the path is cut after four
/// segments — enough to tell `/api/documents/:id/snapshots` from its siblings.
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

/// ULIDs (26 chars) and anything containing a digit are treated as identifiers.
/// No real route segment in SPEC §5.1 contains a digit.
fn looks_like_id(segment: &str) -> bool {
    segment.len() >= 16 || segment.chars().any(|c| c.is_ascii_digit())
}

fn is_label_safe(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.'
}

/// Refresh gauges that are sampled rather than incremented (room counts,
/// document totals). Called on a timer from `main`.
pub async fn sample_gauges(state: &crate::state::AppState) {
    let stats = state.docs.stats();
    gauge!(names::ROOMS).set(stats.rooms as f64);
    gauge!(names::DIRTY_ROOMS).set(stats.dirty_rooms as f64);
    gauge!(names::OVERSIZED_DOCS).set(stats.oversized_docs as f64);

    // The change feed's two sequence numbers and its tail count. `head - safe` is
    // the in-flight depth, so a dashboard can alert on a watermark that stops
    // moving while head climbs (PROTOCOL.md §2.2).
    gauge!(names::FEED_HEAD_SEQ).set(state.feed.head_seq() as f64);
    gauge!(names::FEED_SAFE_SEQ).set(state.feed.safe_seq() as f64);
    gauge!(names::FEED_SUBSCRIBERS).set(state.feed.subscriber_count() as f64);

    // Estimated: it reads collection metadata instead of counting, which is what
    // a gauge sampled every few seconds should cost.
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

/// Await SIGTERM / SIGINT, then return so the caller can start the graceful
/// shutdown sequence (SPEC §8: flush dirty rooms, close sockets, exit ≤ 30 s).
pub async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};

        let mut sigterm = match signal(SignalKind::terminate()) {
            Ok(stream) => stream,
            Err(err) => {
                tracing::error!(error = %err, "cannot listen for SIGTERM");
                // Never return immediately: that would shut the server down at
                // boot. Fall back to Ctrl-C only.
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

/// Hard deadline for the shutdown sequence (SPEC §8): once the grace period is
/// spent, the process leaves rather than hanging a rolling deploy. Spawned when
/// the signal arrives, so the clock starts at the signal, not at boot.
pub fn spawn_shutdown_watchdog(grace: Duration) {
    tokio::spawn(async move {
        tokio::time::sleep(grace).await;
        tracing::error!(
            grace_secs = grace.as_secs(),
            "graceful shutdown exceeded its grace period; exiting now"
        );
        // Flushed state is durable; anything still in flight is lost either way.
        std::process::exit(1);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A local recorder keeps the test off the process-global one, which
    /// `init_metrics` installs exactly once.
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
            body.contains("# HELP lm_http_requests_total HTTP requests"),
            "{body}"
        );
        // Latency must render as a true histogram, not a summary: summaries
        // cannot be aggregated across scrapes.
        assert!(
            body.contains("lm_http_request_duration_seconds_bucket"),
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

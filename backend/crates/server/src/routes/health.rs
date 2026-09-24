//! Liveness and readiness (SPEC §8). Unauthenticated, cheap, never cached.
//!
//! The split matters operationally: `/healthz` answers "is this process alive"
//! and must never depend on Mongo — a database blip should not make Kubernetes
//! kill a server that is about to recover. `/readyz` answers "should traffic go
//! here", and that one *does* depend on Mongo and on migrations having finished.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Router, http::StatusCode};
use serde::Serialize;

use crate::state::AppState;

/// A readiness probe that hangs is a readiness probe that lies. The ping is
/// bounded well inside any sane probe timeout.
const MONGO_PING_TIMEOUT: Duration = Duration::from_secs(2);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
}

/// Liveness: the process is up and the runtime responds. Never touches Mongo.
pub async fn healthz() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

/// Readiness detail (SPEC §8: Mongo + migrations + plugin load, with details).
#[derive(Debug, Serialize)]
pub struct ReadyReport {
    pub ready: bool,
    pub mongo: CheckResult,
    pub migrations: CheckResult,
    /// The frontend plugin registry: count, root, and anything it refused to load.
    /// Informational — see [`check_plugins`] for why it never fails the probe.
    pub plugins: CheckResult,
    pub schema_version: i32,
    pub uptime_secs: u64,
    pub version: &'static str,
}

#[derive(Debug, Serialize)]
pub struct CheckResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
}

impl CheckResult {
    fn ok() -> Self {
        Self {
            ok: true,
            detail: None,
            latency_ms: None,
        }
    }

    fn passed(detail: impl Into<String>, latency: Duration) -> Self {
        Self {
            ok: true,
            detail: Some(detail.into()),
            latency_ms: Some(latency.as_millis() as u64),
        }
    }

    fn failed(detail: impl Into<String>, latency: Option<Duration>) -> Self {
        Self {
            ok: false,
            detail: Some(detail.into()),
            latency_ms: latency.map(|latency| latency.as_millis() as u64),
        }
    }

    fn skipped(detail: impl Into<String>) -> Self {
        Self {
            ok: true,
            detail: Some(detail.into()),
            latency_ms: None,
        }
    }

    fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

/// Readiness: 200 when every check passes, 503 with the same body otherwise.
pub async fn readyz(State(state): State<AppState>) -> (StatusCode, Json<ReadyReport>) {
    let mongo = check_mongo(&state).await;
    let migrations = check_migrations(&state);
    let plugins = check_plugins(&state);

    let ready = mongo.ok && migrations.ok && plugins.ok;

    let report = ReadyReport {
        ready,
        mongo,
        migrations,
        plugins,
        schema_version: state.readiness.schema_version.load(Ordering::Relaxed),
        uptime_secs: state.readiness.started_at.elapsed().as_secs(),
        version: crate::VERSION,
    };

    if !ready {
        tracing::warn!(
            mongo_ok = report.mongo.ok,
            migrations_ok = report.migrations.ok,
            "not ready"
        );
    }

    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, Json(report))
}

async fn check_mongo(state: &AppState) -> CheckResult {
    let started = Instant::now();
    match tokio::time::timeout(MONGO_PING_TIMEOUT, crate::db::ping(&state.mongo)).await {
        Ok(Ok(())) => CheckResult::passed("ping ok", started.elapsed()),
        Ok(Err(err)) => CheckResult::failed(format!("ping failed: {err}"), Some(started.elapsed())),
        Err(_) => CheckResult::failed(
            format!("ping timed out after {:?}", MONGO_PING_TIMEOUT),
            Some(started.elapsed()),
        ),
    }
}

fn check_migrations(state: &AppState) -> CheckResult {
    if state.readiness.migrations_complete.load(Ordering::Relaxed) {
        let version = state.readiness.schema_version.load(Ordering::Relaxed);
        CheckResult::ok().with_detail(format!("schema version {version}"))
    } else {
        CheckResult::failed("migrations have not finished", None)
    }
}

/// The frontend plugin registry (SPEC §8: "plugin load, with **details**").
///
/// M3 has no plugin *host* — that is M4 — but it does have a registry, and "the
/// plugins did not load" is the most likely M3 misconfiguration: a `PLUGINS_DIR`
/// that resolved somewhere empty ships a server whose clients boot into a shell
/// with nothing in it. This check is how an operator sees that without reading the
/// client's console.
///
/// **It never fails the probe, and that is deliberate.** `/readyz` answers "should
/// traffic come here", and a server with an unbuilt plugin directory or one
/// unparsable manifest serves every request it is asked to — including the API, the
/// sync socket, and the other thirteen plugins. Failing readiness would take a
/// working deployment out of rotation over a missing subdirectory, and
/// `plugins::scan` says so in as many words where it records that case ("not an
/// error: a deployment with no plugins installed is a valid state"). `DISABLE_PLUGINS=1`
/// is likewise a supported recovery mode (SPEC §6.1), not a fault.
///
/// So the counts go in `detail`, and readiness stays a question about traffic.
///
/// **Counts, and nothing identifying.** `/readyz` is unauthenticated by design (above) and
/// the documented Compose deployment proxies it straight through Caddy, so its body is
/// world-readable. It used to carry the absolute `PLUGINS_DIR` and up to three manifest
/// rejection strings — the server's filesystem layout and which plugin directories are
/// malformed, handed to anyone who asks. That is reconnaissance, and this file is careful
/// to keep exactly that kind of thing out of `/healthz`. The paths and messages are still
/// available where they belong: a `WARN` at boot (`main.rs`) and the admin plugin view,
/// both of which have an operator behind them.
fn check_plugins(state: &AppState) -> CheckResult {
    if state.config.disable_plugins {
        return CheckResult::skipped("DISABLE_PLUGINS=1: no plugins are served");
    }
    let registry = crate::plugins::registry(&state.config);
    let count = registry.plugins().len();
    let problems = registry.problems().len();
    if problems == 0 {
        return CheckResult::ok().with_detail(format!("{count} plugins loaded"));
    }
    CheckResult::ok().with_detail(format!(
        "{count} plugins loaded; {problems} not loaded (see the server log or admin)"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn healthz_answers_without_any_state() {
        let response = healthz().await.into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }

    /// The readiness contract end to end, against a real database.
    ///
    /// ```text
    /// SESSION_SECRET=0123456789012345678901234567890123456789 \
    /// MONGO_URI=mongodb://127.0.0.1:27017 MONGO_DATABASE=life_manager_test \
    ///   cargo test -p life-manager-server -- --ignored readyz
    /// ```
    #[tokio::test]
    #[ignore = "requires a reachable MongoDB"]
    async fn readyz_is_503_until_migrations_are_marked_complete() {
        let config = crate::config::Config::from_env().expect("configured environment");
        let state = AppState::new(config).await.expect("state");
        let app = router().with_state(state.clone());

        // Nothing has run migrations yet: not ready, and it says why.
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/readyz")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);

        state.init_schema().await.expect("schema");
        state
            .readiness
            .migrations_complete
            .store(true, Ordering::Relaxed);
        state
            .readiness
            .schema_version
            .store(crate::db::migrations::SCHEMA_VERSION, Ordering::Relaxed);

        let response = app
            .oneshot(
                Request::builder()
                    .uri("/readyz")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body");
        let report: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(report["ready"], true);
        assert_eq!(report["mongo"]["ok"], true);
        assert_eq!(report["migrations"]["ok"], true);
        // The plugin check reports, it never gates: this test's `PLUGINS_DIR` is
        // whatever the environment says and is usually not built, which is a valid
        // deployment state and must not take the server out of rotation (SPEC §8;
        // `plugins::scan` records an unreadable directory as a problem, not an error).
        assert_eq!(report["plugins"]["ok"], true);
        let plugin_detail = report["plugins"]["detail"]
            .as_str()
            .expect("the plugin check says what it found")
            .to_string();
        assert!(
            plugin_detail.contains("plugins loaded") || plugin_detail.contains("DISABLE_PLUGINS"),
            "the plugin check must say what it found: {plugin_detail}"
        );
        // Unauthenticated body: counts only. No filesystem paths, no manifest messages —
        // see `check_plugins` for why.
        assert!(
            !plugin_detail.contains('/'),
            "/readyz must not disclose the plugin directory: {plugin_detail}"
        );
        assert_eq!(
            report["schema_version"],
            crate::db::migrations::SCHEMA_VERSION
        );
    }
}

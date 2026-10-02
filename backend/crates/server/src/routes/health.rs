use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Router, http::StatusCode};
use serde::Serialize;

use crate::state::AppState;

const MONGO_PING_TIMEOUT: Duration = Duration::from_secs(2);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
}

pub async fn healthz() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

#[derive(Debug, Serialize)]
pub struct ReadyReport {
    pub ready: bool,
    pub mongo: CheckResult,
    pub migrations: CheckResult,
    pub plugins: CheckResult,
    pub plugin_host: CheckResult,
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

pub async fn readyz(State(state): State<AppState>) -> (StatusCode, Json<ReadyReport>) {
    let mongo = check_mongo(&state).await;
    let migrations = check_migrations(&state);
    let plugins = check_plugins(&state);
    let plugin_host = check_plugin_host(&state);

    let ready = mongo.ok && migrations.ok && plugins.ok && plugin_host.ok;

    let report = ReadyReport {
        ready,
        mongo,
        migrations,
        plugins,
        plugin_host,
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

fn check_plugin_host(state: &AppState) -> CheckResult {
    if state.config.disable_plugins {
        return CheckResult::skipped("DISABLE_PLUGINS=1: no backend plugins run");
    }
    let Some(host) = crate::pluginhost::PluginHost::existing(state) else {
        return CheckResult::skipped("the plugin host has not started yet");
    };
    let stats = host.stats();
    CheckResult::ok().with_detail(format!(
        "{} active, {} breaker-open, {} cron schedules, {} instances, {} calls in flight",
        stats.active, stats.disabled, stats.cron_jobs, stats.instances, stats.calls_in_flight
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

    #[tokio::test]
    #[ignore = "requires a reachable MongoDB"]
    async fn readyz_is_503_until_migrations_are_marked_complete() {
        let config = crate::config::Config::from_env().expect("configured environment");
        let state = AppState::new(config).await.expect("state");
        let app = router().with_state(state.clone());

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
        assert_eq!(report["plugins"]["ok"], true);
        let plugin_detail = report["plugins"]["detail"]
            .as_str()
            .expect("the plugin check says what it found")
            .to_string();
        assert!(
            plugin_detail.contains("plugins loaded") || plugin_detail.contains("DISABLE_PLUGINS"),
            "the plugin check must say what it found: {plugin_detail}"
        );
        assert!(
            !plugin_detail.contains('/'),
            "/readyz must not disclose the plugin directory: {plugin_detail}"
        );
        assert_eq!(report["plugin_host"]["ok"], true);
        let host_detail = report["plugin_host"]["detail"]
            .as_str()
            .expect("the plugin host check says what it found")
            .to_string();
        assert!(
            host_detail.contains("breaker-open")
                || host_detail.contains("DISABLE_PLUGINS")
                || host_detail.contains("has not started"),
            "the plugin host check must say what it found: {host_detail}"
        );
        assert!(
            !host_detail.contains('/'),
            "/readyz must not disclose plugin paths or ids: {host_detail}"
        );
        assert_eq!(
            report["schema_version"],
            crate::db::migrations::SCHEMA_VERSION
        );
    }
}

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use bson::doc;
use ddd_plugin_abi as abi;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::auth::{AdminUser, ClientMeta, MaybeAuthUser, audit};
use crate::domain::{Timestamp, new_id};
use crate::error::{AppError, AppResult};
use crate::pluginhost::limits::PluginLimits;
use crate::pluginhost::{self, CallKind, Invocation, PluginHost};
use crate::plugininstall::{self, InstallRequest, InstallSource, zipcheck};
use crate::plugins::{self, ConfigField, PluginCapabilities, PluginRecord, PluginState, RouteSpec};
use crate::state::AppState;

pub const MAX_ROUTE_BODY: usize = abi::limits::MAX_ROUTE_BODY_BYTES;

pub const ROUTE_RATE_BUCKET: &str = "plugin-route";

const STRIPPED_RESPONSE_HEADERS: &[&str] = &[
    "set-cookie",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
];

fn route_limiter() -> &'static std::sync::Arc<crate::auth::RateLimiter> {
    static LIMITER: OnceLock<std::sync::Arc<crate::auth::RateLimiter>> = OnceLock::new();
    LIMITER.get_or_init(|| {
        std::sync::Arc::new(crate::auth::RateLimiter::new(
            abi::limits::ROUTE_REQUESTS_PER_MINUTE,
            std::time::Duration::from_secs(60),
        ))
    })
}

fn rate_limit_key(
    plugin_id: &str,
    user_id: Option<&str>,
    client_ip: Option<&str>,
) -> crate::auth::RateKey {
    let client = user_id
        .or(client_ip)
        .map(str::to_string)
        .unwrap_or_else(|| "anonymous".to_string());
    crate::auth::RateKey::Named {
        bucket: ROUTE_RATE_BUCKET,
        key: format!("{plugin_id}:{client}"),
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/{id}", axum::routing::any(dispatch_root))
        .route("/{id}/{*path}", axum::routing::any(dispatch))
        .layer(DefaultBodyLimit::max(MAX_ROUTE_BODY))
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_root(
    state: State<AppState>,
    user: MaybeAuthUser,
    meta: ClientMeta,
    Path(id): Path<String>,
    method: Method,
    query: Query<Vec<(String, String)>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> AppResult<Response> {
    dispatch(
        state,
        user,
        meta,
        Path((id, String::new())),
        method,
        query,
        headers,
        body,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn dispatch(
    State(state): State<AppState>,
    MaybeAuthUser(user): MaybeAuthUser,
    meta: ClientMeta,
    Path((id, path)): Path<(String, String)>,
    method: Method,
    Query(query): Query<Vec<(String, String)>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> AppResult<Response> {
    let host = PluginHost::get(&state);
    let Some(plugin) = host.get_active(&id) else {
        return Err(AppError::NotFound("plugin"));
    };

    let inner = normalize_route_path(&path)?;
    let Some(route) = plugin
        .routes
        .iter()
        .find(|route| route.method == method.as_str() && route.path == inner)
    else {
        return Err(AppError::NotFound("plugin route"));
    };

    if !route.public && user.is_none() {
        return Err(AppError::Unauthorized);
    }

    let limiter = route_limiter();
    let key = rate_limit_key(&id, user.as_ref().map(|user| user.id()), meta.ip.as_deref());
    limiter.check(&key)?;
    limiter.record_failure(&key);

    if body.len() > MAX_ROUTE_BODY {
        return Err(AppError::PayloadTooLarge {
            len: body.len() as u64,
            limit: MAX_ROUTE_BODY as u64,
        });
    }

    let request_id = headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(new_id);

    let payload = abi::http::HttpRouteRequest {
        method: method.as_str().to_string(),
        path: inner,
        query: query
            .into_iter()
            .map(|(key, value)| (key, serde_json::Value::String(value)))
            .collect(),
        headers: inbound_headers(&headers),
        body_base64: (!body.is_empty())
            .then(|| base64::Engine::encode(&base64::prelude::BASE64_STANDARD, &body)),
        public: route.public,
        user: user.as_ref().map(|user| abi::http::RequestUser {
            id: user.id().to_string(),
            is_admin: user.is_admin(),
        }),
        request_id,
    };

    let invocation = Invocation::top_level(
        plugin.id.clone(),
        CallKind::Route,
        serde_json::to_value(&payload).map_err(|err| AppError::Internal(err.into()))?,
        host.limits(),
    )
    .with_user(user.as_ref().map(|user| user.id().to_string()));

    match host
        .call_typed::<abi::http::HttpRouteResponse>(&state, invocation)
        .await
    {
        Ok(Some(response)) => to_response(response),
        Ok(None) => Ok(gateway_error(
            StatusCode::BAD_GATEWAY,
            "the plugin returned no response",
        )),
        Err(pluginhost::CallFailure::Refused(error)) => Ok(refusal_response(&error)),
        Err(pluginhost::CallFailure::Host(error)) => Ok(host_failure_response(&id, &error)),
    }
}

fn normalize_route_path(raw: &str) -> AppResult<String> {
    let trimmed = raw.trim_start_matches('/').trim_end_matches('/');
    if trimmed
        .split('/')
        .any(|segment| segment == ".." || segment == ".")
    {
        return Err(AppError::bad_request(
            "a plugin route path may not contain a relative segment",
        ));
    }
    if trimmed.is_empty() {
        Ok("/".to_string())
    } else {
        Ok(format!("/{trimmed}"))
    }
}

fn inbound_headers(headers: &HeaderMap) -> abi::JsonMap {
    let mut out = abi::JsonMap::new();
    for (name, value) in headers {
        let lower = name.as_str().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "cookie" | "authorization" | "proxy-authorization"
        ) {
            continue;
        }
        if let Ok(text) = value.to_str() {
            out.insert(lower, serde_json::Value::String(text.to_string()));
        }
    }
    out
}

pub fn to_response(response: abi::http::HttpRouteResponse) -> AppResult<Response> {
    let Ok(status) = StatusCode::from_u16(response.status) else {
        return Ok(gateway_error(
            StatusCode::BAD_GATEWAY,
            "the plugin answered with a status outside 200–599",
        ));
    };
    if !(200..=599).contains(&response.status) {
        return Ok(gateway_error(
            StatusCode::BAD_GATEWAY,
            "the plugin answered with a status outside 200–599",
        ));
    }

    if response.headers.len() > abi::limits::MAX_ROUTE_RESPONSE_HEADERS {
        return Ok(gateway_error(
            StatusCode::BAD_GATEWAY,
            "the plugin answered with too many headers",
        ));
    }

    let body = match response.body_base64.as_deref() {
        None => Vec::new(),
        Some(encoded) => match base64::Engine::decode(&base64::prelude::BASE64_STANDARD, encoded) {
            Ok(bytes) => bytes,
            Err(_) => {
                return Ok(gateway_error(
                    StatusCode::BAD_GATEWAY,
                    "the plugin's response body is not base64",
                ));
            }
        },
    };
    if body.len() > MAX_ROUTE_BODY {
        return Ok(gateway_error(
            StatusCode::BAD_GATEWAY,
            "the plugin's response body is over the cap",
        ));
    }

    let mut builder = Response::builder().status(status);
    for (name, value) in &response.headers {
        let lower = name.to_ascii_lowercase();
        if STRIPPED_RESPONSE_HEADERS.contains(&lower.as_str()) {
            continue;
        }
        let Some(text) = value.as_str() else { continue };
        let (Ok(name), Ok(value)) = (
            axum::http::HeaderName::from_bytes(lower.as_bytes()),
            axum::http::HeaderValue::from_str(text),
        ) else {
            continue;
        };
        builder = builder.header(name, value);
    }
    builder = builder.header(axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff");

    let inline_safe = builder
        .headers_ref()
        .and_then(|headers| headers.get(axum::http::header::CONTENT_TYPE))
        .and_then(|value| value.to_str().ok())
        .is_some_and(is_inline_safe_response);
    builder = builder.header(
        axum::http::header::CONTENT_SECURITY_POLICY,
        "sandbox; default-src 'none'",
    );
    if !inline_safe {
        builder = builder.header(axum::http::header::CONTENT_DISPOSITION, "attachment");
    }

    builder
        .body(axum::body::Body::from(body))
        .map_err(|err| AppError::Internal(err.into()))
}

const INLINE_SAFE_ROUTE_TYPES: &[&str] = &[
    "application/json",
    "application/problem+json",
    "text/csv",
    "text/event-stream",
];

fn is_inline_safe_response(content_type: &str) -> bool {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if crate::routes::attachments::NEVER_INLINE_TYPES.contains(&mime.as_str()) {
        return false;
    }
    crate::routes::attachments::INLINE_SAFE_TYPES.contains(&mime.as_str())
        || INLINE_SAFE_ROUTE_TYPES.contains(&mime.as_str())
}

fn route_error_body(code: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "error": { "code": code, "message": message } })
}

fn gateway_error(status: StatusCode, message: &str) -> Response {
    tracing::warn!(%status, %message, "plugin route: the plugin misbehaved");
    nosniff_json(status, route_error_body("bad_gateway", message))
}

fn nosniff_json(status: StatusCode, body: serde_json::Value) -> Response {
    use axum::response::IntoResponse as _;
    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(
        axum::http::header::X_CONTENT_TYPE_OPTIONS,
        axum::http::HeaderValue::from_static("nosniff"),
    );
    response
}

fn refusal_response(error: &abi::HostError) -> Response {
    let status = match error.code {
        abi::ErrorCode::NotFound => StatusCode::NOT_FOUND,
        abi::ErrorCode::Gone => StatusCode::GONE,
        abi::ErrorCode::AlreadyExists => StatusCode::CONFLICT,
        abi::ErrorCode::InvalidArgument => StatusCode::BAD_REQUEST,
        abi::ErrorCode::Forbidden | abi::ErrorCode::CapabilityDenied | abi::ErrorCode::Blocked => {
            StatusCode::FORBIDDEN
        }
        abi::ErrorCode::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        abi::ErrorCode::LimitExceeded | abi::ErrorCode::Reentrancy => StatusCode::TOO_MANY_REQUESTS,
        abi::ErrorCode::Timeout => StatusCode::GATEWAY_TIMEOUT,
        abi::ErrorCode::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        abi::ErrorCode::Internal => StatusCode::BAD_GATEWAY,
    };
    nosniff_json(
        status,
        route_error_body(error.code.as_str(), &error.message),
    )
}

fn host_failure_response(plugin_id: &str, error: &pluginhost::PluginHostError) -> Response {
    let status = error.http_status();
    if status.is_server_error() {
        tracing::warn!(plugin = %plugin_id, %status, error = %error, "plugin route: call failed");
    }
    let forwarded = error.as_host_error();
    nosniff_json(
        status,
        route_error_body(forwarded.code.as_str(), &forwarded.message),
    )
}

pub fn admin_router() -> Router<AppState> {
    Router::new()
        .route(
            "/",
            get(list).post(upload).layer(DefaultBodyLimit::disable()),
        )
        .route("/{id}/{version}/approve", post(approve))
        .route("/{id}/{version}/reject", post(reject))
        .route("/{id}/enable", post(enable))
        .route("/{id}/disable", post(disable))
        .route("/{id}", axum::routing::delete(uninstall))
        .route("/{id}/config", get(read_config).put(write_config))
        .route("/{id}/cron/{index}/run", post(run_cron))
        .route("/{id}/logs", get(logs))
}

pub const MAX_UPLOAD_BYTES: u64 = zipcheck::MAX_ARCHIVE_BYTES;

pub const PACKAGE_FIELD: &str = "package";

const OTHER_FIELDS_BUDGET: u64 = 64 * 1024;

pub const ADMIN_DISABLE_REASON: &str = "admin";

pub const EVENT_LOG_CAPACITY: usize = 400;
const LOG_DEFAULT_LIMIT: usize = 50;

#[derive(Debug, Clone, Serialize)]
pub struct PluginEvent {
    pub at: Timestamp,
    pub plugin_id: String,
    pub level: String,
    pub message: String,
}

fn event_log() -> &'static Mutex<VecDeque<PluginEvent>> {
    static LOG: OnceLock<Mutex<VecDeque<PluginEvent>>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(VecDeque::with_capacity(EVENT_LOG_CAPACITY)))
}

pub fn note(plugin_id: &str, level: &str, message: impl Into<String>) {
    let event = PluginEvent {
        at: Timestamp::now(),
        plugin_id: plugin_id.to_string(),
        level: level.to_string(),
        message: message.into(),
    };
    let Ok(mut log) = event_log().lock() else {
        return;
    };
    if log.len() >= EVENT_LOG_CAPACITY {
        log.pop_front();
    }
    log.push_back(event);
}

pub fn events_for(plugin_id: &str, limit: usize) -> Vec<PluginEvent> {
    let Ok(log) = event_log().lock() else {
        return Vec::new();
    };
    log.iter()
        .rev()
        .filter(|event| event.plugin_id == plugin_id)
        .take(limit)
        .cloned()
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct BreakerView {
    pub open: bool,
    pub reason: Option<String>,
    pub by_admin: bool,
}

fn breaker_view(record: &PluginRecord) -> BreakerView {
    let disabled = record.state == PluginState::Disabled;
    let by_admin = record.disabled_reason.as_deref() == Some(ADMIN_DISABLE_REASON);
    BreakerView {
        open: disabled && !by_admin && record.disabled_reason.is_some(),
        reason: if disabled {
            record.disabled_reason.clone()
        } else {
            None
        },
        by_admin: disabled && by_admin,
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PluginMetricsView {
    pub cron_jobs: usize,
    pub cron_runs: u64,
    pub cron_failures: u64,
    pub last_cron_run: Option<Timestamp>,
    pub last_cron_status: Option<String>,
    pub recent_events: usize,
}

fn metrics_view(record: &PluginRecord) -> PluginMetricsView {
    let mut view = PluginMetricsView {
        cron_jobs: cron_view(record).len(),
        recent_events: events_for(&record.id, EVENT_LOG_CAPACITY).len(),
        ..PluginMetricsView::default()
    };
    for entry in &record.cron_state {
        view.cron_runs += entry.runs;
        view.cron_failures += entry.failures;
        if let Some(last) = entry.last_run
            && view
                .last_cron_run
                .is_none_or(|current| last.timestamp_millis() > current.timestamp_millis())
        {
            view.last_cron_run = Some(last);
            view.last_cron_status = entry.last_status.clone();
        }
    }
    view
}

fn cron_view(record: &PluginRecord) -> Vec<pluginhost::cron::CronState> {
    let declared = record
        .manifest
        .backend
        .as_ref()
        .map(|backend| backend.cron.clone())
        .unwrap_or_default();

    declared
        .into_iter()
        .enumerate()
        .map(|(index, expression)| {
            let index = index as u32;
            match record.cron_state.iter().find(|entry| entry.index == index) {
                Some(entry) => pluginhost::cron::CronState {
                    expression: expression.clone(),
                    ..entry.clone()
                },
                None => pluginhost::cron::CronState {
                    index,
                    expression,
                    last_run: None,
                    last_status: None,
                    runs: 0,
                    failures: 0,
                },
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginAdminView {
    pub id: String,
    pub version: String,
    pub state: PluginState,
    pub base: bool,
    pub served: bool,
    pub active: bool,
    pub manifest: plugins::PluginManifest,
    pub capabilities_requested: PluginCapabilities,
    pub capabilities_approved: PluginCapabilities,
    pub capabilities_differ: bool,
    pub source: InstallSource,
    pub installed_at: Timestamp,
    pub installed_by: Option<String>,
    pub approved_at: Option<Timestamp>,
    pub approved_by: Option<String>,
    pub last_error: Option<String>,
    pub module_sha256: Option<String>,
    pub has_backend: bool,
    pub hooks: Vec<String>,
    pub cron: Vec<pluginhost::cron::CronState>,
    pub routes: Vec<RouteSpec>,
    pub events: Vec<String>,
    pub config_schema: BTreeMap<String, ConfigField>,
    pub breaker: BreakerView,
    pub metrics: PluginMetricsView,
}

fn admin_view(record: &PluginRecord, base: bool, active: bool) -> PluginAdminView {
    let manifest = record.manifest.clone();
    let backend = manifest.backend.clone();
    PluginAdminView {
        id: record.id.clone(),
        version: record.version.clone(),
        state: record.state,
        base,
        served: record.state.is_served(),
        active,
        capabilities_requested: manifest.capabilities.clone(),
        capabilities_approved: record.capabilities_approved.clone(),
        capabilities_differ: record.state != PluginState::Pending
            && record.capabilities_approved != manifest.capabilities,
        source: record.source.clone(),
        installed_at: record.installed_at,
        installed_by: record.installed_by.clone(),
        approved_at: record.approved_at,
        approved_by: record.approved_by.clone(),
        last_error: record.last_error.clone(),
        module_sha256: record.module_sha256.clone(),
        has_backend: backend.is_some(),
        hooks: backend
            .as_ref()
            .map(|b| b.hooks.clone())
            .unwrap_or_default(),
        cron: cron_view(record),
        routes: if record.state == PluginState::Pending {
            plugins::route_specs(&manifest).unwrap_or_default()
        } else {
            plugins::route_specs_granted(&manifest, &record.capabilities_approved)
                .unwrap_or_default()
        },
        events: backend.map(|b| b.events).unwrap_or_default(),
        config_schema: manifest.config.clone(),
        breaker: breaker_view(record),
        metrics: metrics_view(record),
        manifest,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LimitsView {
    pub call_timeout_ms: u64,
    pub cron_timeout_ms: u64,
    pub memory_bytes: u64,
    pub max_instances: usize,
    pub breaker_threshold: u32,
    pub http_timeout_ms: u64,
    pub max_http_response_bytes: u64,
    pub http_allow_cidrs: Vec<String>,
    pub cron_enabled: bool,
    pub max_package_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct PluginListResponse {
    pub plugins: Vec<PluginAdminView>,
    pub problems: Vec<plugins::PluginProblem>,
    pub host: pluginhost::PluginHostStats,
    pub limits: LimitsView,
    pub plugins_disabled: bool,
    pub install_lock: Option<String>,
    pub abi_version: u32,
    pub pending_count: usize,
    pub secret_placeholder: &'static str,
}

pub async fn list(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> AppResult<Json<PluginListResponse>> {
    let records = plugininstall::records(&state).await?;
    let registry = plugins::registry(&state.config);
    let host = PluginHost::get(&state);

    let plugins = records
        .iter()
        .map(|record| {
            let base = registry
                .plugins()
                .iter()
                .find(|installed| installed.manifest.id == record.id)
                .map(|installed| installed.base)
                .unwrap_or_else(|| plugins::BASE_PLUGIN_IDS.contains(&record.id.as_str()));
            admin_view(record, base, host.get_active(&record.id).is_some())
        })
        .collect::<Vec<_>>();

    let pending_count = plugins
        .iter()
        .filter(|view| view.state == PluginState::Pending)
        .count();
    let config = state.config();

    Ok(Json(PluginListResponse {
        plugins,
        problems: registry.problems().to_vec(),
        host: host.stats(),
        limits: LimitsView {
            call_timeout_ms: config.plugin_call_timeout.as_millis() as u64,
            cron_timeout_ms: config.plugin_cron_timeout.as_millis() as u64,
            memory_bytes: config.plugin_memory_bytes,
            max_instances: config.plugin_max_instances,
            breaker_threshold: config.plugin_breaker_threshold,
            http_timeout_ms: config.plugin_http_timeout.as_millis() as u64,
            max_http_response_bytes: config.plugin_http_max_response_bytes,
            http_allow_cidrs: config
                .plugin_http_allow_cidrs
                .iter()
                .map(|net| net.to_string())
                .collect(),
            cron_enabled: config.plugin_enable_cron,
            max_package_bytes: MAX_UPLOAD_BYTES,
        },
        plugins_disabled: config.disable_plugins,
        install_lock: plugininstall::queue::holder(&state).await?,
        abi_version: abi::ABI_VERSION,
        pending_count,
        secret_placeholder: plugininstall::config::SECRET_PLACEHOLDER,
    }))
}

pub async fn upload(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    multipart: Multipart,
) -> AppResult<(StatusCode, Json<plugininstall::InstallOutcome>)> {
    let staged = stage_upload(&state, multipart).await?;
    let outcome = match plugininstall::install(
        &state,
        InstallRequest {
            source: InstallSource::Upload {
                filename: staged.filename.clone(),
            },
            archive: staged.path.clone(),
            actor: admin.actor(),
            auto_approve: false,
        },
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            let _ = tokio::fs::remove_file(&staged.path).await;
            return Err(error.into());
        }
    };

    note(
        &outcome.id,
        "info",
        format!(
            "uploaded {} {} from `{}` — pending approval",
            outcome.id, outcome.version, staged.filename
        ),
    );
    audit::record(
        &state,
        "plugin.install",
        Some(&admin.actor()),
        audit::TARGET_PLUGIN,
        Some(outcome.id.clone()),
        doc! {
            "version": &outcome.version,
            "filename": &staged.filename,
            "state": outcome.state.as_str(),
            "replaced": outcome.replaced.clone(),
            "warnings": outcome.warnings.len() as i64,
        },
        meta.ip.clone(),
    )
    .await;

    Ok((StatusCode::CREATED, Json(outcome)))
}

fn io_error(step: &str, error: std::io::Error) -> AppError {
    AppError::Internal(anyhow::anyhow!("{step}: {error}"))
}

struct StagedUpload {
    path: PathBuf,
    filename: String,
}

async fn stage_upload(state: &AppState, mut multipart: Multipart) -> AppResult<StagedUpload> {
    let directory = plugininstall::staging_dir(state.config()).join("uploads");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| io_error("creating the plugin staging directory", error))?;

    let mut other_bytes: u64 = 0;
    loop {
        let Some(mut field) = multipart
            .next_field()
            .await
            .map_err(|error| AppError::bad_request(format!("malformed multipart body: {error}")))?
        else {
            return Err(AppError::bad_request(format!(
                "multipart body has no package part (send the zip as `{PACKAGE_FIELD}`)"
            )));
        };

        let is_package = field.file_name().is_some() || field.name() == Some(PACKAGE_FIELD);
        if !is_package {
            while let Some(chunk) = field.chunk().await.map_err(|error| {
                AppError::bad_request(format!("malformed multipart body: {error}"))
            })? {
                other_bytes += chunk.len() as u64;
                if other_bytes > OTHER_FIELDS_BUDGET {
                    return Err(AppError::bad_request(
                        "multipart body has too much non-file content",
                    ));
                }
            }
            continue;
        }

        let filename = sanitize_package_name(field.file_name());
        let path = directory.join(format!("{}-{}", new_id(), filename));
        let mut file = tokio::fs::File::create(&path)
            .await
            .map_err(|error| io_error("creating the staged package file", error))?;
        let mut size: u64 = 0;

        loop {
            let chunk = match field.chunk().await {
                Ok(chunk) => chunk,
                Err(error) => {
                    let _ = tokio::fs::remove_file(&path).await;
                    return Err(AppError::bad_request(format!(
                        "upload interrupted: {error}"
                    )));
                }
            };
            let Some(chunk) = chunk else { break };
            size += chunk.len() as u64;
            if size > MAX_UPLOAD_BYTES {
                let _ = tokio::fs::remove_file(&path).await;
                return Err(AppError::PayloadTooLarge {
                    len: size,
                    limit: MAX_UPLOAD_BYTES,
                });
            }
            if let Err(error) = file.write_all(&chunk).await {
                let _ = tokio::fs::remove_file(&path).await;
                return Err(io_error("writing the staged package", error));
            }
        }

        if size == 0 {
            let _ = tokio::fs::remove_file(&path).await;
            return Err(AppError::bad_request("the uploaded package is empty"));
        }
        file.flush()
            .await
            .map_err(|error| io_error("flushing the staged package", error))?;
        file.sync_all()
            .await
            .map_err(|error| io_error("syncing the staged package", error))?;
        drop(file);

        return Ok(StagedUpload { path, filename });
    }
}

pub fn sanitize_package_name(raw: Option<&str>) -> String {
    let candidate = raw
        .unwrap_or("package.zip")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("package.zip")
        .trim();
    let cleaned: String = candidate
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .take(96)
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        "package.zip".to_string()
    } else {
        cleaned
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct ApproveRequest {
    #[serde(default)]
    pub capabilities: Option<PluginCapabilities>,
}

pub async fn approve(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Path((id, version)): Path<(String, String)>,
    Json(body): Json<ApproveRequest>,
) -> AppResult<Json<PluginAdminView>> {
    let record = plugininstall::record(&state, &id)
        .await?
        .ok_or(AppError::NotFound("plugin"))?;
    if record.version != version {
        return Err(AppError::NotFound("plugin version"));
    }
    if record.state != PluginState::Pending {
        return Err(AppError::Unprocessable(format!(
            "{id} {version} is `{}`, not pending; only a pending install can be approved",
            record.state.as_str()
        )));
    }

    let requested = record.manifest.capabilities.clone();
    let granted = body.capabilities.unwrap_or_else(|| requested.clone());
    requested
        .approval_is_legal(&granted)
        .map_err(AppError::bad_request)?;

    let approved =
        plugininstall::approve(&state, &id, &version, granted.clone(), &admin.actor()).await?;

    note(
        &id,
        "info",
        format!("approved {id} {version} by {}", admin.0.id()),
    );
    audit::record(
        &state,
        "plugin.approve",
        Some(&admin.actor()),
        audit::TARGET_PLUGIN,
        Some(id.clone()),
        doc! {
            "version": &version,
            "documents": granted.documents.join(","),
            "http_hosts": granted.http_hosts().join(","),
            "notifications": granted.notifications,
            "public_routes": granted.public_routes.join(","),
            "narrowed": granted != requested,
        },
        meta.ip.clone(),
    )
    .await;

    let host = PluginHost::get(&state);
    let base = plugins::BASE_PLUGIN_IDS.contains(&id.as_str());
    Ok(Json(admin_view(
        &approved,
        base,
        host.get_active(&id).is_some(),
    )))
}

pub async fn reject(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Path((id, version)): Path<(String, String)>,
) -> AppResult<StatusCode> {
    plugininstall::reject(&state, &id, &version, &admin.actor()).await?;
    note(&id, "info", format!("rejected pending {id} {version}"));
    audit::record(
        &state,
        "plugin.reject",
        Some(&admin.actor()),
        audit::TARGET_PLUGIN,
        Some(id),
        doc! { "version": version },
        meta.ip.clone(),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Default, Deserialize)]
pub struct DisableRequest {
    #[serde(default)]
    pub note: Option<String>,
}

pub async fn disable(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Path(id): Path<String>,
    body: Option<Json<DisableRequest>>,
) -> AppResult<StatusCode> {
    let request = body.map(|Json(value)| value).unwrap_or_default();
    plugininstall::disable(&state, &id, ADMIN_DISABLE_REASON, &admin.actor()).await?;
    note(&id, "warn", format!("disabled by {}", admin.0.id()));
    audit::record(
        &state,
        "plugin.disable",
        Some(&admin.actor()),
        audit::TARGET_PLUGIN,
        Some(id),
        doc! { "reason": ADMIN_DISABLE_REASON, "note": request.note },
        meta.ip.clone(),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn enable(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    plugininstall::enable(&state, &id, &admin.actor()).await?;
    PluginHost::get(&state).reset_breaker(&id);
    note(
        &id,
        "info",
        format!("re-enabled by {} (breaker cleared)", admin.0.id()),
    );
    audit::record(
        &state,
        "plugin.enable",
        Some(&admin.actor()),
        audit::TARGET_PLUGIN,
        Some(id),
        doc! { "breaker_reset": true },
        meta.ip.clone(),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Default, Deserialize)]
pub struct UninstallParams {
    #[serde(default)]
    pub purge: bool,
}

pub async fn uninstall(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Path(id): Path<String>,
    Query(params): Query<UninstallParams>,
) -> AppResult<StatusCode> {
    plugininstall::uninstall(&state, &id, params.purge, &admin.actor()).await?;
    note(
        &id,
        "warn",
        if params.purge {
            format!("uninstalled by {} — data purged", admin.0.id())
        } else {
            format!("uninstalled by {} — KV and %%% data kept", admin.0.id())
        },
    );
    audit::record(
        &state,
        "plugin.uninstall",
        Some(&admin.actor()),
        audit::TARGET_PLUGIN,
        Some(id),
        doc! { "purge": params.purge },
        meta.ip.clone(),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    pub plugin_id: String,
    pub schema: BTreeMap<String, ConfigField>,
    pub values: serde_json::Value,
    pub set: serde_json::Value,
    pub missing: serde_json::Value,
    pub updated_at: serde_json::Value,
    pub updated_by: serde_json::Value,
    pub secret_keys: Vec<String>,
    pub secret_placeholder: &'static str,
}

fn config_response(
    plugin_id: String,
    schema: BTreeMap<String, ConfigField>,
    envelope: serde_json::Value,
) -> ConfigResponse {
    let take = |key: &str| {
        envelope
            .get(key)
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    };
    let secret_keys = schema
        .iter()
        .filter(|(_, field)| field.secret)
        .map(|(key, _)| key.clone())
        .collect();
    ConfigResponse {
        plugin_id,
        values: take("values"),
        set: take("set"),
        missing: take("missing"),
        updated_at: take("updatedAt"),
        updated_by: take("updatedBy"),
        schema,
        secret_keys,
        secret_placeholder: plugininstall::config::SECRET_PLACEHOLDER,
    }
}

pub async fn read_config(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> AppResult<Json<ConfigResponse>> {
    let record = plugininstall::record(&state, &id)
        .await?
        .ok_or(AppError::NotFound("plugin"))?;
    let schema = record.manifest.config.clone();
    let envelope = plugininstall::config::for_admin(&state, &id, &schema).await?;
    Ok(Json(config_response(id, schema, envelope)))
}

#[derive(Debug, Deserialize)]
pub struct WriteConfigRequest {
    pub values: serde_json::Map<String, serde_json::Value>,
}

pub async fn write_config(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Path(id): Path<String>,
    Json(body): Json<WriteConfigRequest>,
) -> AppResult<Json<ConfigResponse>> {
    let record = plugininstall::record(&state, &id)
        .await?
        .ok_or(AppError::NotFound("plugin"))?;
    let schema = record.manifest.config.clone();

    let unknown: Vec<&String> = body
        .values
        .keys()
        .filter(|key| !schema.contains_key(*key))
        .collect();
    if !unknown.is_empty() {
        return Err(AppError::bad_request(format!(
            "`{}` is not a config key `{id}` declares",
            unknown
                .iter()
                .map(|key| key.as_str())
                .collect::<Vec<_>>()
                .join("`, `")
        )));
    }
    for (key, value) in &body.values {
        if value.is_null() {
            continue;
        }
        if let Some(field) = schema.get(key) {
            plugininstall::config::validate_value(field, value)
                .map_err(|message| AppError::bad_request(format!("`{key}`: {message}")))?;
        }
    }

    let touched: Vec<String> = body.values.keys().cloned().collect();
    let secrets_touched = touched
        .iter()
        .filter(|key| schema.get(*key).is_some_and(|field| field.secret))
        .count();

    plugininstall::config::set(&state, &id, &schema, body.values, &admin.actor()).await?;

    note(
        &id,
        "info",
        format!(
            "configuration updated by {} ({} keys)",
            admin.0.id(),
            touched.len()
        ),
    );
    audit::record(
        &state,
        "plugin.config",
        Some(&admin.actor()),
        audit::TARGET_PLUGIN,
        Some(id.clone()),
        doc! { "keys": touched.join(","), "secret_keys_touched": secrets_touched as i64 },
        meta.ip.clone(),
    )
    .await;

    read_config(State(state), admin, Path(id)).await
}

#[derive(Debug, Serialize)]
pub struct CronRunResponse {
    pub plugin_id: String,
    pub index: u32,
    pub expression: String,
    pub duration_ms: u64,
    pub writes: u32,
    pub logs: u32,
    pub value: Option<serde_json::Value>,
}

pub async fn run_cron(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Path((id, index)): Path<(String, u32)>,
) -> AppResult<Json<CronRunResponse>> {
    let host = PluginHost::get(&state);
    let active = host
        .get_active(&id)
        .ok_or(AppError::NotFound("active plugin"))?;
    let expression = active
        .cron
        .get(index as usize)
        .cloned()
        .ok_or(AppError::NotFound("cron job"))?;

    let _claim = pluginhost::cron::CronClaim::try_acquire(&id, index).ok_or_else(|| {
        AppError::Conflict(format!(
            "a run of `{id}` cron job {index} is already in flight; wait for it to finish"
        ))
    })?;

    let now = Timestamp::now().to_rfc3339();
    let limits = PluginLimits::from_config(state.config());
    let payload = serde_json::to_value(abi::cron::CronPayload {
        expression: expression.clone(),
        index,
        scheduled_for: now.clone(),
        fired_at: now,
        last_run: None,
        missed: 0,
        deadline_ms: limits.cron_timeout.as_millis() as u64,
    })
    .map_err(|error| AppError::Internal(anyhow::anyhow!("cron payload: {error}")))?;

    let invocation = Invocation::top_level(&id, CallKind::Cron { index }, payload, &limits)
        .with_user(Some(admin.0.id().to_string()));

    let outcome = match host.call(&state, invocation).await {
        Ok(outcome) => outcome,
        Err(error) => {
            note(&id, "error", format!("manual cron {index} failed: {error}"));
            return Err(error.into());
        }
    };

    note(
        &id,
        "info",
        format!(
            "manual cron {index} (`{expression}`) ran in {} ms, {} writes",
            outcome.duration.as_millis(),
            outcome.writes
        ),
    );
    audit::record(
        &state,
        "plugin.cron_run",
        Some(&admin.actor()),
        audit::TARGET_PLUGIN,
        Some(id.clone()),
        doc! {
            "index": index as i64,
            "expression": &expression,
            "duration_ms": outcome.duration.as_millis() as i64,
            "writes": outcome.writes as i64,
        },
        meta.ip.clone(),
    )
    .await;

    Ok(Json(CronRunResponse {
        plugin_id: id,
        index,
        expression,
        duration_ms: outcome.duration.as_millis() as u64,
        writes: outcome.writes,
        logs: outcome.logs,
        value: outcome.value,
    }))
}

#[derive(Debug, Default, Deserialize)]
pub struct LogParams {
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct LogResponse {
    pub plugin_id: String,
    pub events: Vec<PluginEvent>,
    pub ephemeral: bool,
    pub capacity: usize,
}

pub async fn logs(
    _state: State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
    Query(params): Query<LogParams>,
) -> AppResult<Json<LogResponse>> {
    let limit = params
        .limit
        .unwrap_or(LOG_DEFAULT_LIMIT)
        .clamp(1, EVENT_LOG_CAPACITY);
    Ok(Json(LogResponse {
        events: events_for(&id, limit),
        plugin_id: id,
        ephemeral: true,
        capacity: EVENT_LOG_CAPACITY,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_of(key: &crate::auth::RateKey) -> String {
        match key {
            crate::auth::RateKey::Named { bucket, key } => format!("{bucket}/{key}"),
            other => format!("{other:?}"),
        }
    }

    #[test]
    fn the_rate_limit_key_is_per_plugin_and_per_client() {
        assert_eq!(
            key_of(&rate_limit_key("cal", Some("user-1"), Some("1.2.3.4"))),
            key_of(&rate_limit_key("cal", Some("user-1"), Some("5.6.7.8"))),
        );
        assert_ne!(
            key_of(&rate_limit_key("cal", Some("user-1"), None)),
            key_of(&rate_limit_key("cal", Some("user-2"), None)),
        );
        assert_ne!(
            key_of(&rate_limit_key("cal", Some("user-1"), None)),
            key_of(&rate_limit_key("other", Some("user-1"), None)),
        );
        assert_ne!(
            key_of(&rate_limit_key("cal", None, Some("1.2.3.4"))),
            key_of(&rate_limit_key("cal", None, Some("1.2.3.5"))),
        );
        assert_eq!(
            key_of(&rate_limit_key("cal", None, None)),
            key_of(&rate_limit_key("cal", None, None)),
        );
        assert_eq!(
            key_of(&rate_limit_key("cal", None, None)),
            key_of(&rate_limit_key("cal", None, None)),
        );
    }

    #[test]
    fn a_plugin_response_is_never_a_scripted_document_on_this_origin() {
        for scripted in [
            "text/html",
            "text/html; charset=utf-8",
            "TEXT/HTML",
            "application/xhtml+xml",
            "image/svg+xml",
        ] {
            assert!(
                !is_inline_safe_response(scripted),
                "{scripted} must download rather than render here"
            );
        }
        for safe in [
            "application/json",
            "application/json; charset=utf-8",
            "text/csv",
        ] {
            assert!(is_inline_safe_response(safe), "{safe} should render inline");
        }
        assert!(!is_inline_safe_response(""));
        assert!(!is_inline_safe_response("application/x-shockwave-flash"));
    }

    #[test]
    fn to_response_hardens_whatever_the_plugin_chose() {
        let html = to_response(abi::http::HttpRouteResponse {
            status: 200,
            headers: BTreeMap::from([(
                "content-type".to_string(),
                serde_json::Value::String("text/html".to_string()),
            )]),
            body_base64: Some(base64::Engine::encode(
                &base64::prelude::BASE64_STANDARD,
                b"<script>alert(1)</script>",
            )),
        })
        .expect("a response");
        let headers = html.headers();
        assert_eq!(
            headers
                .get(axum::http::header::CONTENT_SECURITY_POLICY)
                .and_then(|value| value.to_str().ok()),
            Some("sandbox; default-src 'none'"),
            "an opaque origin is what keeps this off the app's cookies and API"
        );
        assert_eq!(
            headers
                .get(axum::http::header::CONTENT_DISPOSITION)
                .and_then(|value| value.to_str().ok()),
            Some("attachment")
        );
        assert_eq!(
            headers
                .get(axum::http::header::X_CONTENT_TYPE_OPTIONS)
                .and_then(|value| value.to_str().ok()),
            Some("nosniff")
        );

        let json = to_response(abi::http::HttpRouteResponse {
            status: 200,
            headers: BTreeMap::from([(
                "content-type".to_string(),
                serde_json::Value::String("application/json".to_string()),
            )]),
            body_base64: None,
        })
        .expect("a response");
        assert!(
            json.headers()
                .get(axum::http::header::CONTENT_SECURITY_POLICY)
                .is_some()
        );
        assert!(
            json.headers()
                .get(axum::http::header::CONTENT_DISPOSITION)
                .is_none()
        );
    }
}

#[cfg(test)]
mod admin_surface_tests {
    use super::*;

    fn record(json: serde_json::Value) -> PluginRecord {
        let mut base = serde_json::json!({
            "_id": "calendar",
            "version": "1.0.0",
            "state": "enabled",
            "manifest": { "id": "calendar", "version": "1.0.0", "kernel": "^2.0" },
            "source": { "kind": "upload", "filename": "calendar-1.0.0.zip" },
            "installed_at": "2026-09-24T00:00:00Z",
        });
        let (Some(object), Some(overrides)) = (base.as_object_mut(), json.as_object()) else {
            panic!("both have to be objects");
        };
        for (key, value) in overrides {
            object.insert(key.clone(), value.clone());
        }
        serde_json::from_value(base).expect("a valid plugin record")
    }

    #[test]
    fn an_enabled_plugin_has_no_breaker_state_to_report() {
        let view = breaker_view(&record(serde_json::json!({})));
        assert!(!view.open);
        assert!(!view.by_admin);
        assert_eq!(view.reason, None);
    }

    #[test]
    fn an_admin_switch_off_is_not_a_breaker_trip() {
        let view = breaker_view(&record(serde_json::json!({
            "state": "disabled",
            "disabled_reason": ADMIN_DISABLE_REASON,
        })));
        assert!(
            !view.open,
            "an admin's off switch must not read as a failure"
        );
        assert!(view.by_admin);
    }

    #[test]
    fn any_other_disable_reason_is_the_breaker() {
        let view = breaker_view(&record(serde_json::json!({
            "state": "disabled",
            "disabled_reason": "5 consecutive timeouts",
        })));
        assert!(view.open);
        assert!(!view.by_admin);
        assert_eq!(view.reason.as_deref(), Some("5 consecutive timeouts"));
    }

    #[test]
    fn cron_metrics_aggregate_and_report_the_latest_run() {
        let view = metrics_view(&record(serde_json::json!({
            "manifest": {
                "id": "calendar",
                "version": "1.0.0",
                "kernel": "^2.0",
                "backend": { "module": "backend.wasm", "cron": ["0 6 * * *", "0 18 * * *"] },
            },
            "cron_state": [
                {
                    "index": 0,
                    "expression": "0 6 * * *",
                    "last_run": "2026-09-24T06:00:00Z",
                    "last_status": "ok",
                    "runs": 10,
                    "failures": 1
                },
                {
                    "index": 1,
                    "expression": "0 18 * * *",
                    "last_run": "2026-09-24T18:00:00Z",
                    "last_status": "timeout",
                    "runs": 9,
                    "failures": 2
                }
            ]
        })));
        assert_eq!(view.cron_jobs, 2);
        assert_eq!(view.cron_runs, 19);
        assert_eq!(view.cron_failures, 3);
        assert_eq!(view.last_cron_status.as_deref(), Some("timeout"));
    }

    #[test]
    fn a_plugin_with_no_cron_reports_zeroes_rather_than_nothing() {
        let view = metrics_view(&record(serde_json::json!({})));
        assert_eq!(view.cron_jobs, 0);
        assert_eq!(view.last_cron_run, None);
    }

    #[test]
    fn a_cron_job_that_has_never_run_is_still_reported() {
        let never_run = record(serde_json::json!({
            "manifest": {
                "id": "calendar",
                "version": "1.0.0",
                "kernel": "^2.0",
                "backend": { "module": "backend.wasm", "cron": ["0 6 * * *"] },
            },
        }));

        let cron = cron_view(&never_run);
        assert_eq!(cron.len(), 1, "the declared job is the shape of the list");
        assert_eq!(cron[0].index, 0);
        assert_eq!(cron[0].expression, "0 6 * * *");
        assert_eq!(cron[0].runs, 0);
        assert_eq!(cron[0].last_run, None);
        assert_eq!(metrics_view(&never_run).cron_jobs, 1);
    }

    #[test]
    fn the_declared_schedule_wins_over_a_stale_state_row() {
        let upgraded = record(serde_json::json!({
            "manifest": {
                "id": "calendar",
                "version": "1.1.0",
                "kernel": "^2.0",
                "backend": { "module": "backend.wasm", "cron": ["*/30 * * * *"] },
            },
            "cron_state": [
                { "index": 0, "expression": "0 6 * * *", "runs": 7, "last_status": "ok" },
                { "index": 1, "expression": "0 18 * * *", "runs": 3 },
            ],
        }));

        let cron = cron_view(&upgraded);
        assert_eq!(cron.len(), 1, "the job the new version dropped is gone");
        assert_eq!(cron[0].expression, "*/30 * * * *");
        assert_eq!(cron[0].runs, 7, "its history survives the reschedule");
        assert_eq!(cron[0].last_status.as_deref(), Some("ok"));
    }

    #[test]
    fn the_config_response_carries_one_values_map_not_an_envelope() {
        let schema: BTreeMap<String, ConfigField> = serde_json::from_value(serde_json::json!({
            "feed_url": { "type": "string", "required": true },
            "auth_header": { "type": "string", "secret": true },
        }))
        .expect("a valid config schema");

        let envelope = serde_json::json!({
            "plugin": "calendar",
            "schema": schema,
            "values": { "feed_url": "https://example.com/f.ics", "auth_header": "••••••••" },
            "set": { "feed_url": true, "auth_header": true },
            "missing": [],
            "updatedAt": "2026-09-24T09:10:36.852Z",
            "updatedBy": "01M39A3DE15Z9H1Y9N85CK0Q7R",
        });

        let response = config_response("calendar".to_string(), schema, envelope);
        let json = serde_json::to_value(&response).expect("serializes");

        assert_eq!(
            json["values"]["feed_url"],
            serde_json::json!("https://example.com/f.ics"),
            "the form indexes `values` by key"
        );
        assert!(
            json["values"]["values"].is_null(),
            "no second envelope under `values`"
        );
        assert!(
            json["values"]["schema"].is_null(),
            "the schema appears once, at the top level"
        );
        assert_eq!(json["set"]["auth_header"], serde_json::json!(true));
        assert_eq!(
            json["updated_by"],
            serde_json::json!("01M39A3DE15Z9H1Y9N85CK0Q7R")
        );
        assert_eq!(json["secret_keys"], serde_json::json!(["auth_header"]));
        assert_eq!(
            json["values"]["auth_header"],
            serde_json::json!(plugininstall::config::SECRET_PLACEHOLDER),
            "a secret is never echoed, only masked"
        );
    }

    #[test]
    fn an_approved_view_reports_the_difference_from_what_was_requested() {
        let narrowed = record(serde_json::json!({
            "manifest": {
                "id": "calendar",
                "version": "1.0.0",
                "kernel": "^2.0",
                "capabilities": { "documents": ["read", "write"] }
            },
            "capabilities_approved": { "documents": ["read"] },
        }));
        let view = admin_view(&narrowed, false, true);
        assert!(view.capabilities_differ);
        assert_eq!(view.capabilities_requested.documents, vec!["read", "write"]);
        assert_eq!(view.capabilities_approved.documents, vec!["read"]);

        let pending = record(serde_json::json!({
            "state": "pending",
            "manifest": {
                "id": "calendar",
                "version": "1.0.0",
                "kernel": "^2.0",
                "capabilities": { "documents": ["read"] }
            },
        }));
        assert!(!admin_view(&pending, false, false).capabilities_differ);
        assert!(!admin_view(&pending, false, false).served);
    }

    #[test]
    fn an_uploaded_filename_can_never_escape_the_staging_directory() {
        assert_eq!(
            sanitize_package_name(Some("plugin-1.0.0.zip")),
            "plugin-1.0.0.zip"
        );
        assert_eq!(sanitize_package_name(Some("../../etc/cron.d/x")), "x");
        assert_eq!(sanitize_package_name(Some("/etc/passwd")), "passwd");
        assert_eq!(sanitize_package_name(Some("..\\..\\windows")), "windows");
        assert_eq!(sanitize_package_name(Some("..")), "package.zip");
        assert_eq!(sanitize_package_name(Some("   ")), "package.zip");
        assert_eq!(sanitize_package_name(None), "package.zip");
        assert_eq!(sanitize_package_name(Some("a b;c$.zip")), "abc.zip");
        assert!(!sanitize_package_name(Some("a".repeat(500).as_str())).is_empty());
        assert!(sanitize_package_name(Some("a".repeat(500).as_str())).len() <= 96);
        for name in ["../x", "/x", "a\0b.zip", "x/../y"] {
            let cleaned = sanitize_package_name(Some(name));
            assert!(!cleaned.contains('/') && !cleaned.contains("..") && !cleaned.contains('\0'));
        }
    }

    #[test]
    fn the_event_ring_reports_newest_first_and_only_this_plugin() {
        let plugin = format!("ring-test-{}", new_id());
        let other = format!("other-{}", new_id());
        note(&plugin, "info", "first");
        note(&other, "info", "not mine");
        note(&plugin, "error", "second");

        let events = events_for(&plugin, 10);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].message, "second");
        assert_eq!(events[0].level, "error");
        assert_eq!(events[1].message, "first");
        assert_eq!(events_for(&plugin, 1).len(), 1);
    }

    #[test]
    fn the_event_ring_is_bounded() {
        let plugin = format!("ring-bound-{}", new_id());
        for index in 0..(EVENT_LOG_CAPACITY + 50) {
            note(&plugin, "info", format!("event {index}"));
        }
        let events = events_for(&plugin, EVENT_LOG_CAPACITY);
        assert!(events.len() <= EVENT_LOG_CAPACITY);
        assert_eq!(
            events.first().map(|event| event.message.as_str()),
            Some(format!("event {}", EVENT_LOG_CAPACITY + 49).as_str())
        );
    }
}

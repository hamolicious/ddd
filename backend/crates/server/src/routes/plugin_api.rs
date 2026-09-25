//! `/api/plugins/:id/*` — inbound HTTP into a backend plugin (SPEC §5.1), plus the admin
//! surface for installing, approving and configuring plugins.
//!
//! # The route contract
//!
//! A plugin declares its routes in `backend.routes` (`"POST /webhook"`), and any of them
//! listed in `capabilities.public-routes` is reachable **without a session**. Everything
//! else needs one, which is the default and the reason a plugin's own "sync now" button is
//! safe: an unauthenticated refresh endpoint is a free outbound-request amplifier pointed
//! at whatever host the plugin is allowed to reach.
//!
//! Requests reach the plugin's single `lm_http` export with the path *inside* its
//! namespace (`/api/plugins/<id>/webhook` → `/webhook`).
//!
//! # What the host strips, in both directions
//!
//! - **Inbound:** `cookie` and `authorization` never reach a plugin. A plugin does not need
//!   this app's session credential, and a plugin that could read it could impersonate the
//!   caller against the rest of the API. Identity arrives as
//!   [`abi::http::RequestUser`] instead.
//! - **Outbound:** `set-cookie` is dropped from a plugin's response — a plugin must not
//!   mint cookies for this origin — along with hop-by-hop headers and `content-length`
//!   (axum computes it). And because the answer goes out on the *app's own origin* with a
//!   `Content-Type` the plugin chose, every response carries `nosniff`, a
//!   `Content-Security-Policy: sandbox` (an opaque origin, so nothing rendered here can reach
//!   this origin's cookies or API) and `Content-Disposition: attachment` outside the inline
//!   allowlist. See [`to_response`].
//!
//! # Failure mapping
//!
//! | Cause | Status |
//! |---|---|
//! | no such plugin, or it has no backend half | 404 |
//! | plugin has no matching route | 404 |
//! | route needs a session, none given | 401 |
//! | plugin disabled / breaker open / pool exhausted | 503 |
//! | deadline exceeded | 504 |
//! | plugin trapped, or answered something unreadable | 502 |
//! | plugin refused with a code | that code's status |
//!
//! **Owner:** the `agenda-admin` builder (the admin surface) with the `wasm-host` builder
//! (the dispatch half) — the one file with two owners in M4, because the route table and
//! the admin screens are the same resource. The split inside the file is marked.

use std::collections::{BTreeMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use bson::doc;
use life_manager_plugin_abi as abi;
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

/// Largest body a plugin route accepts (`abi::limits::MAX_ROUTE_BODY_BYTES`).
pub const MAX_ROUTE_BODY: usize = abi::limits::MAX_ROUTE_BODY_BYTES;

/// Per-plugin, per-client request cap (SPEC §5.1: plugin routes are "rate-limited").
pub const ROUTE_RATE_BUCKET: &str = "plugin-route";

// ---------------------------------------------------------------------------
// Dispatch — wasm-host
// ---------------------------------------------------------------------------

/// Headers a plugin may not set on the way out.
///
/// `set-cookie` is the one that matters: a plugin that could mint a cookie for this origin
/// could mint a session. The rest belong to the connection, and `content-length` is axum's.
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

/// The per-plugin, per-client limiter.
///
/// Its own bucket rather than `state.login_limiter`: that one is sized for login backoff
/// (ten attempts in fifteen minutes), and sharing it would let one plugin's webhook traffic
/// lock people out of the application.
fn route_limiter() -> &'static std::sync::Arc<crate::auth::RateLimiter> {
    static LIMITER: OnceLock<std::sync::Arc<crate::auth::RateLimiter>> = OnceLock::new();
    LIMITER.get_or_init(|| {
        std::sync::Arc::new(crate::auth::RateLimiter::new(
            abi::limits::ROUTE_REQUESTS_PER_MINUTE,
            std::time::Duration::from_secs(60),
        ))
    })
}

/// The rate-limit bucket for one request: per plugin, per client.
///
/// Per plugin so one plugin's public webhook cannot exhaust another's budget, and per client so
/// one caller cannot exhaust everybody's.
///
/// **`client_ip` is the only source of the address, never a raw header.** `dispatch` used to
/// read `x-forwarded-for` here itself and take its *leftmost* hop, whatever
/// `TRUST_PROXY_HEADERS` said — so an unauthenticated caller got a fresh bucket per request just
/// by rotating a header they wrote themselves. The cap SPEC §5.1 requires on public routes never
/// engaged, every admitted request cost a Wasm invocation (and, for a webhook plugin, an
/// outbound fetch — the amplifier this module's docs warn about), and `RateLimiter::buckets`
/// grew with each forgery. [`crate::auth::client_ip`] exists for exactly this: it ignores
/// forwarding headers unless `TRUST_PROXY_HEADERS` is set (the default is `false`, because in
/// the Compose deployment the server is published directly), and takes the *rightmost* hop when
/// it is, which is the only one a trusted proxy wrote.
///
/// `None` for both means the listener carries no connect info, and every anonymous caller then
/// shares one bucket for the plugin. That is deliberately the fail-closed direction: a shared
/// cap throttles legitimate senders, a per-request bucket caps nothing at all.
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

/// `/api/plugins/{id}/{*path}`, merged into the `/api/plugins` nest next to
/// `statics::api_router`'s installed-plugin list.
///
/// Two patterns, because axum treats `/{id}` and `/{id}/{*path}` as different ones and a
/// plugin may legally declare the route `/` — reachable as `/api/plugins/calendar`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/{id}", axum::routing::any(dispatch_root))
        .route("/{id}/{*path}", axum::routing::any(dispatch))
        // The `/api` nest's 2 MiB JSON cap is the wrong one for a webhook: the ABI says a
        // plugin route accepts up to `MAX_ROUTE_BODY_BYTES`, and this layer sets that for
        // these paths only.
        .layer(DefaultBodyLimit::max(MAX_ROUTE_BODY))
}

/// `/api/plugins/{id}` — a plugin's `/` route.
// Each parameter is one axum extractor; there is no shorter spelling of "this handler needs the
// session, the client address, the path, the method, the query, the headers and the body".
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

/// One inbound request to one plugin.
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
    // A plugin with no active backend half is a 404, not a 503: there is nothing here, and
    // "temporarily unavailable" would invite a retry that can never work.
    let Some(plugin) = host.get_active(&id) else {
        return Err(AppError::NotFound("plugin"));
    };

    // The path *inside* the plugin's namespace, always leading-slash and never `..`.
    // `RouteSpec::parse` already refused a relative segment in a declared path, so such a
    // request could not match anything — but it is refused explicitly, because "no such
    // route" and "you tried to traverse" are different lines in a log.
    let inner = normalize_route_path(&path)?;
    let Some(route) = plugin
        .routes
        .iter()
        .find(|route| route.method == method.as_str() && route.path == inner)
    else {
        return Err(AppError::NotFound("plugin route"));
    };

    // **Session-authenticated by default** (SPEC §5.1). A plugin's own "sync now" is the
    // reason it matters: an unauthenticated refresh endpoint is a free outbound-request
    // amplifier pointed at whatever host the plugin is allowed to reach.
    if !route.public && user.is_none() {
        return Err(AppError::Unauthorized);
    }

    let limiter = route_limiter();
    let key = rate_limit_key(&id, user.as_ref().map(|user| user.id()), meta.ip.as_deref());
    limiter.check(&key)?;
    // Every request counts, not only the failures: this bucket is a request cap, and
    // `record_failure` is how the limiter is told one happened.
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
        // An `lm_http` that answered with nothing is a plugin bug; a gateway says 502 rather
        // than inventing a body.
        Ok(None) => Ok(gateway_error(
            StatusCode::BAD_GATEWAY,
            "the plugin returned no response",
        )),
        // A plugin's refusal keeps **its** code, so its 404 reads as a 404.
        Err(pluginhost::CallFailure::Refused(error)) => Ok(refusal_response(&error)),
        Err(pluginhost::CallFailure::Host(error)) => Ok(host_failure_response(&id, &error)),
    }
}

/// `""` / `"webhook"` → `/webhook`. Refuses traversal rather than 404ing on it.
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

/// The headers a plugin sees.
///
/// `cookie` and `authorization` are **stripped**: a plugin does not need this app's session
/// credential, and a plugin that could read one could impersonate the caller against the
/// rest of the API. Identity arrives as [`abi::http::RequestUser`] instead.
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

/// Turn a plugin's answer into an axum response, enforcing the status range, the header
/// count and the body cap, and stripping what a plugin may not set.
pub fn to_response(response: abi::http::HttpRouteResponse) -> AppResult<Response> {
    // A status outside 200–599 is not one a gateway can forward, and 502 says the upstream
    // misbehaved — which is what happened (HOST-ABI.md §4.4).
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
    // Plugin output is bytes a third party chose, so it is never sniffed — the same rule
    // attachments follow (SPEC §3.6).
    builder = builder.header(axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff");

    // **This response is on the app's own origin, and the plugin chose its `Content-Type`.**
    // That made `/api/plugins/:id/...` a scripted same-origin context: a route answering
    // `text/html` with a `<script>` — or a *public* route reflecting a query parameter into an
    // error page — ran that script with the session cookie, able to drive the whole
    // authenticated API, and the attacker needed no session of their own. `statics.rs`
    // documents this class ("a document served inline from this origin is a scripted context
    // with the session cookie") and defends `serve_file` against it; the dispatch path did not.
    //
    // Two headers, because they fail independently:
    //
    // - **`Content-Security-Policy: sandbox`** puts the response in an opaque origin, so even
    //   rendered HTML has no access to this origin's cookies, storage or API. `default-src
    //   'none'` means nothing it references loads either. This is the actual defence, and it
    //   costs a plugin nothing: a route serving JSON, a webhook ack or a file has no use for
    //   script.
    // - **`Content-Disposition: attachment`** outside the inline allowlist, the rule SPEC §3.6
    //   already sets for attachments, so a type a browser would render is downloaded instead.
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

/// Structured types a plugin route answers with that a browser does not render as a document.
///
/// Not in [`crate::routes::attachments::INLINE_SAFE_TYPES`] because an *uploaded* file with
/// one of these types is a download, while a plugin route answering `application/json` is an
/// API reply that nothing should be prompted to save.
const INLINE_SAFE_ROUTE_TYPES: &[&str] = &[
    "application/json",
    "application/problem+json",
    "text/csv",
    "text/event-stream",
];

/// May this `Content-Type` be rendered inline on this origin?
///
/// The allowlist attachments use ([`crate::routes::attachments::INLINE_SAFE_TYPES`]) plus
/// [`INLINE_SAFE_ROUTE_TYPES`], read off the media type with parameters (`; charset=utf-8`)
/// stripped. `text/html`, `application/xhtml+xml` and `image/svg+xml` are on neither and never
/// will be — each is a scripted document (`NEVER_INLINE_TYPES`). An unknown or missing type is
/// a download.
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

/// The error envelope every plugin-route failure uses — the application's standard shape, so
/// a client parses one thing whatever answered.
fn route_error_body(code: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "error": { "code": code, "message": message } })
}

fn gateway_error(status: StatusCode, message: &str) -> Response {
    tracing::warn!(%status, %message, "plugin route: the plugin misbehaved");
    nosniff_json(status, route_error_body("bad_gateway", message))
}

/// A JSON response with `nosniff` on it.
///
/// Plugin output is bytes a third party chose, so nothing this route produces is ever
/// sniffed — the same rule attachments follow (SPEC §3.6).
fn nosniff_json(status: StatusCode, body: serde_json::Value) -> Response {
    use axum::response::IntoResponse as _;
    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(
        axum::http::header::X_CONTENT_TYPE_OPTIONS,
        axum::http::HeaderValue::from_static("nosniff"),
    );
    response
}

/// A plugin's refusal, with **its** code mapped to the status that means it.
///
/// A plugin reporting `not_found` for a webhook whose subject does not exist should answer
/// 404, not 500: its refusals are part of its HTTP contract.
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

/// A host-side failure: 404 / 502 / 503 / 504 per HOST-ABI.md §4.4.
///
/// Built here rather than through [`AppError`] because two of those statuses have no
/// `AppError` variant (that file is frozen), and 502-for-a-trap / 504-for-a-deadline are the
/// honest answers for a gateway.
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

// ---------------------------------------------------------------------------
// Admin — agenda-admin
// ---------------------------------------------------------------------------

/// `/api/admin/plugins/*` (SPEC §5.1 "plugin management").
///
/// | Route | Behaviour |
/// |---|---|
/// | `GET /` | every record: state, requested vs approved capabilities, cron state, breaker, last error |
/// | `POST /` | multipart upload → pending |
/// | `POST /:id/:version/approve` | body: the approved capability set → approved + activated |
/// | `POST /:id/:version/reject` | delete the pending package |
/// | `POST /:id/enable`, `/disable` | the admin's off switch; `enable` also clears the breaker |
/// | `DELETE /:id` | uninstall (`?purge=true` for KV + `%%%` stripping) |
/// | `GET /:id/config`, `PUT /:id/config` | schema + values (secrets masked on read) |
/// | `POST /:id/cron/:index/run` | run one cron job now — the "test it" button |
/// | `GET /:id/logs` | the last N host-side events for this plugin (in-memory ring) |
///
/// The upload route must raise its own body limit: the `/api` nest applies
/// [`super::JSON_BODY_LIMIT`] (2 MiB) and a plugin package may be
/// [`zipcheck::MAX_ARCHIVE_BYTES`](crate::plugininstall::zipcheck::MAX_ARCHIVE_BYTES) — the
/// same shape `attachments` uses, streamed to a staging file rather than buffered.
pub fn admin_router() -> Router<AppState> {
    Router::new()
        // The upload shares this `MethodRouter` with the listing, and the body limit is
        // lifted for both: a GET has no body, and a plugin package is streamed to a staging
        // file with its own running cap ([`MAX_UPLOAD_BYTES`]) rather than buffered under
        // axum's. Exactly the shape `attachments::router` uses, for the same reason.
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

/// The cap on an uploaded package, enforced while streaming (SPEC §6.2).
pub const MAX_UPLOAD_BYTES: u64 = zipcheck::MAX_ARCHIVE_BYTES;

/// Multipart field name the upload expects; a part with a filename is also accepted.
pub const PACKAGE_FIELD: &str = "package";

/// Bytes of non-file multipart content tolerated before the request is refused.
const OTHER_FIELDS_BUDGET: u64 = 64 * 1024;

/// What [`disable`] writes as the reason, and therefore the one `disabled_reason` that is
/// **not** the circuit breaker's (see [`BreakerView`]).
pub const ADMIN_DISABLE_REASON: &str = "admin";

/// Host-side events kept per process for the admin screen.
pub const EVENT_LOG_CAPACITY: usize = 400;
/// Default page size for `GET /{id}/logs`.
const LOG_DEFAULT_LIMIT: usize = 50;

// ---------------------------------------------------------------------------
// The event ring
// ---------------------------------------------------------------------------

/// One host-side event about one plugin: an approval, a manual cron run, an activation
/// failure. **Not** the plugin's own `log` output, which goes to `tracing` with the plugin
/// id on the span — this ring is the short, human-readable "what happened to this plugin
/// lately" an admin needs before reaching for the server logs.
#[derive(Debug, Clone, Serialize)]
pub struct PluginEvent {
    pub at: Timestamp,
    pub plugin_id: String,
    /// `info` | `warn` | `error`.
    pub level: String,
    pub message: String,
}

fn event_log() -> &'static Mutex<VecDeque<PluginEvent>> {
    static LOG: OnceLock<Mutex<VecDeque<PluginEvent>>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(VecDeque::with_capacity(EVENT_LOG_CAPACITY)))
}

/// Record one host-side event.
///
/// Deliberately infallible and lock-tolerant: a poisoned mutex or a full ring must never
/// fail the operation being recorded. The ring is in memory and dies with the process — it
/// is a convenience, and [`crate::domain::AuditEntry`] is the record that has to survive
/// (SPEC §5.4), which is why every state change here writes both.
///
/// INTEGRATION (wasm-host, hooks-cron): this is the seam for "the last N host-side events
/// for this plugin". An activation failure (`PluginHost::activate`), a breaker trip
/// (`BreakerTransition::Opened`) and a cron failure (`cron.rs`) are exactly the three
/// things an admin looks for here and none of them passes through this file — one
/// `plugin_api::note(id, "error", …)` at each of those sites makes the screen complete.
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

/// The most recent events for one plugin, newest first.
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

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// What the breaker looks like from outside the host.
///
/// Derived from the **record**, not from the live counter: `disabled_reason` is what the
/// breaker persists when it opens (`BreakerTransition::Opened`), and it is also what
/// survives a restart — which is the state an admin is being asked to act on. Anything but
/// [`ADMIN_DISABLE_REASON`] on a disabled plugin is the breaker's work.
///
/// INTEGRATION (wasm-host): the in-memory half — the *consecutive failure count* of a
/// plugin that is still closed, i.e. "three failures away from tripping" — is
/// `CircuitBreaker::snapshot()` and is private to `PluginHost`. A
/// `PluginHost::breaker_snapshot() -> Vec<(String, BreakerState)>` accessor would let this
/// view show the count before the trip instead of only after it. Nothing else is missing.
#[derive(Debug, Clone, Serialize)]
pub struct BreakerView {
    /// `true` when this plugin is off *because it kept failing*.
    pub open: bool,
    /// The persisted reason, verbatim. `null` when the plugin is not disabled.
    pub reason: Option<String>,
    /// `true` when an admin turned it off by hand; the re-enable button reads differently.
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

/// The per-plugin numbers the server can answer without a metrics scrape.
///
/// Everything here comes off the plugin's own record, so it is per-plugin, durable, and
/// cheap. The per-call series (`lm_plugin_calls_total`, `lm_plugin_call_duration_seconds`,
/// `lm_plugin_call_failures_total`, all labelled by plugin) live on `/metrics` — a
/// Prometheus histogram is not something an admin screen should re-derive, and pointing at
/// it is more honest than inventing a second, disagreeing counter.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PluginMetricsView {
    pub cron_jobs: usize,
    pub cron_runs: u64,
    pub cron_failures: u64,
    pub last_cron_run: Option<Timestamp>,
    pub last_cron_status: Option<String>,
    /// Events in the in-memory ring for this plugin.
    pub recent_events: usize,
}

fn metrics_view(record: &PluginRecord) -> PluginMetricsView {
    let mut view = PluginMetricsView {
        // The *declared* job count, not `cron_state.len()`: state rows only exist once a job
        // has run, so counting them reported "0 cron jobs" for a plugin whose whole purpose
        // is a nightly sync until the night it first fired (see `cron_view`).
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

/// Every cron job the manifest **declares**, carrying the persisted state of the ones that
/// have run.
///
/// `record.cron_state` alone is the wrong source, and was the bug: the scheduler writes a
/// state row the first time a job runs, so a freshly approved plugin with a nightly
/// `0 6 * * *` had an empty list — the admin screen hid its cron table entirely, which also
/// hid the "run now" button that is the only way to test the job before waiting for 06:00.
/// The declared list is the shape; the state rows are an overlay on it.
///
/// A state row whose index no longer exists (the plugin was upgraded and dropped a job) is
/// deliberately dropped rather than shown: the schedule that matters is the installed one.
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
                // The expression comes from the manifest even when a state row exists, so an
                // upgrade that changed the schedule reports the schedule in force.
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

/// One plugin, as the admin screen needs it: the record, what it asked for, what it was
/// granted, and everything about how it is behaving.
#[derive(Debug, Clone, Serialize)]
pub struct PluginAdminView {
    pub id: String,
    pub version: String,
    pub state: PluginState,
    /// Part of the base distribution — `?safe=1` boots these (SPEC §6.1).
    pub base: bool,
    /// Its frontend half is being served to clients.
    pub served: bool,
    /// Its backend half is loaded in the host right now.
    pub active: bool,
    pub manifest: plugins::PluginManifest,
    /// What the package asked for. **This is the list an approval screen shows.**
    pub capabilities_requested: PluginCapabilities,
    /// What an admin granted. Empty until approval.
    pub capabilities_approved: PluginCapabilities,
    /// `true` when the granted set is not the requested one — worth saying out loud, since
    /// a narrowed plugin can fail in ways its author never tested.
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
    /// The manifest's config schema — a key name is not a secret, and the UI draws the form
    /// from it. Values are a separate, explicitly-masked read ([`read_config`]).
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
        // A manifest whose routes do not parse cannot be installed, so an empty list here
        // means "declares none" rather than "could not be read".
        //
        // `public` is the *live* answer, so the screen never shows a route as open that the
        // approval declined: before approval there is no grant yet and the request is what
        // the operator is being asked about, after it the grant is what the dispatcher uses.
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

/// The limits this server applies, so the screen can say "5 s" instead of "the default".
#[derive(Debug, Clone, Serialize)]
pub struct LimitsView {
    pub call_timeout_ms: u64,
    pub cron_timeout_ms: u64,
    pub memory_bytes: u64,
    pub max_instances: usize,
    pub breaker_threshold: u32,
    pub http_timeout_ms: u64,
    pub max_http_response_bytes: u64,
    /// `PLUGIN_HTTP_ALLOW_CIDRS` — the operator's holes in the outbound IP policy
    /// (SPEC §6.2: "loopback/link-local/RFC1918/metadata destinations blocked by default,
    /// **admin-configurable allowlist**"). Usually empty.
    ///
    /// It is here because the capability-approval screen has to be able to tell the truth.
    /// That screen warns, next to the `http` hosts field, that private and loopback
    /// addresses "stay blocked regardless" — which is exactly right on a default server and
    /// exactly wrong on one where this list is non-empty, and the screen had no way to know
    /// which it was looking at. An approval UI that overstates the sandbox is worse than one
    /// that says nothing: an admin widens `http.hosts` believing an internal name cannot
    /// resolve anywhere sensitive, and on this server it can.
    ///
    /// Admin-only, like everything else on this response. Rendered as CIDR strings.
    pub http_allow_cidrs: Vec<String>,
    pub cron_enabled: bool,
    pub max_package_bytes: u64,
}

/// `GET /api/admin/plugins`.
#[derive(Debug, Serialize)]
pub struct PluginListResponse {
    pub plugins: Vec<PluginAdminView>,
    /// Directories the registry refused — "installed and broken" is not "not installed".
    pub problems: Vec<plugins::PluginProblem>,
    pub host: pluginhost::PluginHostStats,
    pub limits: LimitsView,
    /// `DISABLE_PLUGINS=1`: the server-side half of safe mode (SPEC §6.1).
    pub plugins_disabled: bool,
    /// Who holds the install lock, when an install is in flight.
    pub install_lock: Option<String>,
    pub abi_version: u32,
    pub pending_count: usize,
    /// What a secret reads back as, so the form can tell "unchanged" from "cleared".
    pub secret_placeholder: &'static str,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Every admin action here writes an [`crate::domain::AuditEntry`] (SPEC §5.4): install,
/// approve, reject, enable, disable, uninstall, config change (**never the value**), and a
/// manual cron run.
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

/// `POST /api/admin/plugins` — a multipart upload, landing **pending** (SPEC §6.2).
///
/// An upgrade is the same request: a package whose id is already installed lands pending
/// too, and approval replaces the served version. There is no "upgrade" endpoint, because
/// an upgrade that skipped the capability screen would be the way to widen a capability
/// without anyone looking at it.
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
            // Never from an upload. Activation is an explicit admin click, always
            // (SPEC §6.2) — `auto_approve` exists for the base distribution at first boot.
            auto_approve: false,
        },
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            // The pipeline consumes the archive on success; a failure before that point
            // leaves it in staging, and nothing else will ever look at it.
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

/// An IO failure while staging an upload. 500 with a message that names the step, because
/// "permission denied" on `PLUGIN_STAGING_DIR` is an operator problem and a bare 500 sends
/// them to the wrong place.
fn io_error(step: &str, error: std::io::Error) -> AppError {
    AppError::Internal(anyhow::anyhow!("{step}: {error}"))
}

struct StagedUpload {
    path: PathBuf,
    filename: String,
}

/// Stream one multipart file into the staging directory, capped while it is written.
///
/// The bytes land **next to** the install pipeline's own working directory
/// (`PLUGIN_STAGING_DIR`) rather than in `/tmp`, for the reason the installer documents: the
/// final step is an atomic rename into `PLUGINS_DIR`, and a rename across filesystems is a
/// copy that can be interrupted half-way.
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
        // fsync before the installer opens it: the rename at the end of the pipeline is
        // atomic, and a package whose bytes are still in a page cache is not.
        file.sync_all()
            .await
            .map_err(|error| io_error("syncing the staged package", error))?;
        drop(file);

        return Ok(StagedUpload { path, filename });
    }
}

/// A filename safe to build a path from: basename only, conservative characters, bounded.
///
/// The name is cosmetic — it is recorded on the install so an operator can tell two uploads
/// apart — so anything questionable becomes `package.zip` rather than an error.
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
    /// The capability set the admin granted. Omitted ⇒ exactly what the package requested.
    #[serde(default)]
    pub capabilities: Option<PluginCapabilities>,
}

/// `POST /api/admin/plugins/{id}/{version}/approve`.
///
/// The approval rule is checked here as well as in the installer, so a bad grant is a 400
/// naming the field rather than a 500 from deeper in the pipeline. The rule itself lives in
/// one place — [`PluginCapabilities::approval_is_legal`] — so the two cannot disagree: an
/// approval may narrow anything and may extend only `http.hosts` (`HOST-ABI.md` §7.2).
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

/// `POST /api/admin/plugins/{id}/{version}/reject` — delete the pending package.
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
    /// Shown on the admin screen. The stored reason is always [`ADMIN_DISABLE_REASON`] —
    /// see [`BreakerView`] for why that string is load-bearing.
    #[serde(default)]
    pub note: Option<String>,
}

/// `POST /api/admin/plugins/{id}/disable` — the admin's off switch.
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

/// `POST /api/admin/plugins/{id}/enable` — re-enable, **and clear the breaker**.
///
/// The breaker reset is the whole point of the button for a plugin the host turned off: a
/// re-enable that left the counter open would refuse the next call and look like the
/// re-enable had silently failed (SPEC §6.3: "manual re-enable"). `plugininstall::enable`
/// owns the persisted half; [`PluginHost::reset_breaker`] is idempotent, and calling it here
/// makes the in-memory half true at the boundary the admin clicked.
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
    /// The explicit checkbox of SPEC §6.2: purge KV **and** strip the plugin's `%%%`
    /// sections. Default `false` — a reinstall is lossless unless an admin says otherwise.
    #[serde(default)]
    pub purge: bool,
}

/// `DELETE /api/admin/plugins/{id}`.
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

/// `GET /api/admin/plugins/{id}/config` — the schema and the values, secrets masked.
///
/// The shape is **flat**, and that is load-bearing:
/// [`plugininstall::config::for_admin`] already returns a complete envelope
/// (`{plugin, schema, values, set, missing, updatedAt, updatedBy}`), so putting it under a
/// `values` key produced `response.values.values` and a `schema` at two depths. The admin
/// form reads `response.values[key]`, which was then always `undefined` — every field
/// rendered as "not stored" no matter what was saved, and a secret showed no
/// "leave blank to keep it" hint. One envelope, one `values`.
#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    pub plugin_id: String,
    pub schema: BTreeMap<String, ConfigField>,
    /// Key → value, with every `secret: true` value replaced by
    /// [`plugininstall::config::SECRET_PLACEHOLDER`]. Keys with no stored value are absent.
    pub values: serde_json::Value,
    /// Key → `true` when a value is stored. The form needs this separately from `values`,
    /// because a masked secret looks identical whether it is set or not.
    pub set: serde_json::Value,
    /// Declared keys with no stored value (and no usable default).
    pub missing: serde_json::Value,
    pub updated_at: serde_json::Value,
    pub updated_by: serde_json::Value,
    pub secret_keys: Vec<String>,
    pub secret_placeholder: &'static str,
}

/// Build the response from `for_admin`'s envelope, taking each field out of it exactly once.
///
/// Written as one function because [`read_config`] and [`write_config`] both return this and
/// a shape that differed between "read" and "read after write" would be its own bug.
fn config_response(
    plugin_id: String,
    schema: BTreeMap<String, ConfigField>,
    envelope: serde_json::Value,
) -> ConfigResponse {
    // `for_admin` is the only producer of this value and always returns an object; `take`
    // on a missing key yields `Null`, which serializes as `null` rather than panicking on a
    // shape this code does not control.
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
    /// Key → value. A secret submitted as the placeholder means "unchanged"; `null` clears
    /// a key.
    pub values: serde_json::Map<String, serde_json::Value>,
}

/// `PUT /api/admin/plugins/{id}/config`.
///
/// **The audit entry records the keys, never the values** (SPEC §6.2): the point of a
/// `secret: true` field is that nothing but the plugin ever reads it back, and an audit log
/// is a place people paste into chat.
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

    // A key the manifest does not declare is refused rather than stored: an unknown key
    // would never be read by the plugin and would sit in Mongo looking like configuration.
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

    // Answer with the stored state rather than with what was submitted: a secret that came
    // in as the placeholder was *not* written, and the form has to see that.
    read_config(State(state), admin, Path(id)).await
}

/// `POST /api/admin/plugins/{id}/cron/{index}/run` — the "test it" button.
///
/// Runs one declared cron expression **now**, with the cron budget, and reports what the
/// call did. It does not touch the schedule: `last_run` moving because an admin pressed a
/// button would make the next scheduled firing skip (SPEC §6.3: missed runs are skipped),
/// so a manual run is deliberately invisible to the *schedule*.
///
/// It is **not** invisible to the no-overlap rule. SPEC §6.3 says a cron job has "no
/// overlapping executions", and a manual run is an execution of that job: it takes the same
/// [`pluginhost::cron::CronClaim`] the scheduler does and answers 409 when the job is already
/// running. Skipping that claim let a button press run concurrently with the 06:00 tick — for
/// the calendar, two reconciliations that each read the pre-write state, each planned a create
/// for every new uid, and left two permanent documents per event behind.
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

    // Held for the whole run, released when it returns (or unwinds).
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

/// `GET /api/admin/plugins/{id}/logs` — the in-memory ring, newest first.
#[derive(Debug, Serialize)]
pub struct LogResponse {
    pub plugin_id: String,
    pub events: Vec<PluginEvent>,
    /// The ring is per-process and dies with it; the audit log is the durable record.
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
    // Router-level, alongside the other `crates/server/tests/**` suites: a public route
    // reachable without a session; the same path 401ing when it is not public; `cookie`
    // and `authorization` absent from what the plugin receives; `set-cookie` stripped from
    // what it returns; an over-cap body 413; an unknown plugin 404; a disabled plugin 503.
    //
    // What is here is what can be wrong without a server: the two pure derivations that decide
    // how a request is counted and how a response is presented.
    use super::*;

    fn key_of(key: &crate::auth::RateKey) -> String {
        match key {
            crate::auth::RateKey::Named { bucket, key } => format!("{bucket}/{key}"),
            other => format!("{other:?}"),
        }
    }

    /// The limiter key is per plugin and per client, and the *client* is a user id or an address
    /// the server established — never something a caller can vary at will.
    #[test]
    fn the_rate_limit_key_is_per_plugin_and_per_client() {
        // A session keys on the user, whatever address they arrive from.
        assert_eq!(
            key_of(&rate_limit_key("cal", Some("user-1"), Some("1.2.3.4"))),
            key_of(&rate_limit_key("cal", Some("user-1"), Some("5.6.7.8"))),
        );
        assert_ne!(
            key_of(&rate_limit_key("cal", Some("user-1"), None)),
            key_of(&rate_limit_key("cal", Some("user-2"), None)),
        );
        // One plugin's budget is its own.
        assert_ne!(
            key_of(&rate_limit_key("cal", Some("user-1"), None)),
            key_of(&rate_limit_key("other", Some("user-1"), None)),
        );
        // Anonymous callers key on the address the server established…
        assert_ne!(
            key_of(&rate_limit_key("cal", None, Some("1.2.3.4"))),
            key_of(&rate_limit_key("cal", None, Some("1.2.3.5"))),
        );
        // …and when there is none, they share one bucket rather than getting one each. That is
        // the fail-closed direction: it throttles, where a bucket per request caps nothing.
        assert_eq!(
            key_of(&rate_limit_key("cal", None, None)),
            key_of(&rate_limit_key("cal", None, None)),
        );
        // The forged-header bypass, restated as the property that replaced it: an untrusted
        // `X-Forwarded-For` never reaches this function — `auth::client_ip` returns `None` for
        // it unless `TRUST_PROXY_HEADERS` is set — so every such request lands in one bucket.
        assert_eq!(
            key_of(&rate_limit_key("cal", None, None)),
            key_of(&rate_limit_key("cal", None, None)),
        );
    }

    /// A plugin route answers on the app's own origin with a `Content-Type` the plugin picked,
    /// so nothing it returns may be a scripted document there.
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
        // An API reply is not a download prompt.
        for safe in [
            "application/json",
            "application/json; charset=utf-8",
            "text/csv",
        ] {
            assert!(is_inline_safe_response(safe), "{safe} should render inline");
        }
        // Unknown or absent types are downloads: the allowlist is the allowlist.
        assert!(!is_inline_safe_response(""));
        assert!(!is_inline_safe_response("application/x-shockwave-flash"));
    }

    /// Every response carries the sandbox policy, and a scripted type also carries the
    /// attachment disposition.
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

        // JSON keeps the policy and loses the download prompt.
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

/// The admin surface's own unit tests: the pure derivations and the event ring.
///
/// The *routes* need a database and an activated plugin, so they belong in
/// `crates/server/tests/` next to the other integration suites. What is here is what can be
/// wrong without a server: the breaker derivation (which reads a string), the cron
/// aggregation, and the filename sanitiser (which builds a filesystem path out of a header a
/// client controls).
#[cfg(test)]
mod admin_surface_tests {
    use super::*;

    fn record(json: serde_json::Value) -> PluginRecord {
        let mut base = serde_json::json!({
            "_id": "calendar",
            "version": "1.0.0",
            "state": "enabled",
            "manifest": { "id": "calendar", "version": "1.0.0", "kernel": "^1.0" },
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
                "kernel": "^1.0",
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
        // The *latest* run, not the last element: the order of `cron_state` is the manifest's.
        assert_eq!(view.last_cron_status.as_deref(), Some("timeout"));
    }

    #[test]
    fn a_plugin_with_no_cron_reports_zeroes_rather_than_nothing() {
        let view = metrics_view(&record(serde_json::json!({})));
        assert_eq!(view.cron_jobs, 0);
        assert_eq!(view.last_cron_run, None);
    }

    /// The integration bug this guards: a freshly approved plugin has no `cron_state` rows,
    /// because the scheduler writes one when a job first *runs*. Reporting only those rows
    /// hid the whole cron table in the admin screen — and with it the "run now" button,
    /// which is the only way to test a nightly job without waiting until 06:00.
    #[test]
    fn a_cron_job_that_has_never_run_is_still_reported() {
        let never_run = record(serde_json::json!({
            "manifest": {
                "id": "calendar",
                "version": "1.0.0",
                "kernel": "^1.0",
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

    /// An upgrade that changed the schedule reports the schedule in force, and a state row
    /// left over from a job the new version dropped is not resurrected.
    #[test]
    fn the_declared_schedule_wins_over_a_stale_state_row() {
        let upgraded = record(serde_json::json!({
            "manifest": {
                "id": "calendar",
                "version": "1.1.0",
                "kernel": "^1.0",
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

    /// The config response is one flat envelope. It was two nested ones, and the admin form
    /// reads `response.values[key]` — so `values.values` meant every field rendered as "not
    /// stored" however many times it had been saved.
    #[test]
    fn the_config_response_carries_one_values_map_not_an_envelope() {
        let schema: BTreeMap<String, ConfigField> = serde_json::from_value(serde_json::json!({
            "feed_url": { "type": "string", "required": true },
            "auth_header": { "type": "string", "secret": true },
        }))
        .expect("a valid config schema");

        // Exactly what `plugininstall::config::for_admin` returns.
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
                "kernel": "^1.0",
                "capabilities": { "documents": ["read", "write"] }
            },
            "capabilities_approved": { "documents": ["read"] },
        }));
        let view = admin_view(&narrowed, false, true);
        assert!(view.capabilities_differ);
        assert_eq!(view.capabilities_requested.documents, vec!["read", "write"]);
        assert_eq!(view.capabilities_approved.documents, vec!["read"]);

        // A pending record has an empty approved set by definition, which is not a diff.
        let pending = record(serde_json::json!({
            "state": "pending",
            "manifest": {
                "id": "calendar",
                "version": "1.0.0",
                "kernel": "^1.0",
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
        // The newest survives; the oldest is what gets dropped.
        assert_eq!(
            events.first().map(|event| event.message.as_str()),
            Some(format!("event {}", EVENT_LOG_CAPACITY + 49).as_str())
        );
    }
}

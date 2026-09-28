//! Environment configuration. Read once at boot; everything downstream takes
//! `&Config` or `Arc<Config>` — no `std::env` reads outside this file.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use thiserror::Error;

/// Default Mongo database name.
pub const DEFAULT_DATABASE: &str = "life_manager";
/// Default attachment size cap (SPEC §3.5). `0` in the environment means no cap.
pub const DEFAULT_MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;
/// Minimum `SESSION_SECRET` length in bytes (SPEC §5.2). No default value exists.
pub const MIN_SESSION_SECRET_BYTES: usize = 32;
/// Default listen address.
pub const DEFAULT_BIND_ADDR: &str = "0.0.0.0:8080";
/// Default graceful-shutdown budget in seconds (SPEC §8: exit ≤ 30 s).
pub const DEFAULT_SHUTDOWN_GRACE_SECS: u64 = 30;
/// Default `PLUGINS_DIR` — where `mise run plugins` writes the base distribution.
pub const DEFAULT_PLUGINS_DIR: &str = "plugins/base/dist";
/// Default `KERNEL_DTS_PATH` — where `npm run kernel:dts` writes the contract.
pub const DEFAULT_KERNEL_DTS_PATH: &str = "web/kernel-api/dist/kernel.d.ts";
/// `CONFIG_KEY` length in raw bytes — XChaCha20-Poly1305's key size
/// ([`crate::plugininstall::config::ConfigCipher`] uses a 32-byte value verbatim).
pub const CONFIG_KEY_BYTES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    /// Human-readable, for local dev.
    Pretty,
    /// JSON with request ids (SPEC §8).
    Json,
}

/// Fully validated server configuration.
#[derive(Debug, Clone)]
pub struct Config {
    // ---- required ----
    /// `MONGO_URI`
    pub mongo_uri: String,
    /// `BIND_ADDR`, default `0.0.0.0:8080`
    pub bind_addr: SocketAddr,
    /// `SESSION_SECRET`, ≥ 32 bytes, no default (SPEC §5.2).
    ///
    /// Keys the derivation of every stored credential id
    /// ([`crate::auth::hash_token`]), so rotating it really does log everyone out
    /// — that is the documented promise in `dev-docs/resolved/OPERATIONS.md`, and it only
    /// holds because the secret is in the derivation.
    pub session_secret: SessionSecret,

    // ---- optional, with defaults ----
    /// `MONGO_DATABASE`, default [`DEFAULT_DATABASE`].
    pub mongo_database: String,
    /// `MAX_ATTACHMENT_BYTES`, default 100 MiB (SPEC §3.5); `0` is no cap. Read it
    /// through [`Config::attachment_limit`].
    pub max_attachment_bytes: u64,
    /// `MAX_DOCUMENT_BYTES`, default 1 MiB (SPEC §3.5); clamped to the shared
    /// core's hard cap.
    pub max_document_bytes: usize,
    /// `APP_ORIGIN` — comma-separated allowlist, used for CORS and the WebSocket
    /// upgrade — plus what the server derives for itself: `http://localhost:<port>` and
    /// `http://127.0.0.1:<port>` for its own `BIND_ADDR` port, and the same for every
    /// host in `APP_ORIGIN_HOSTS`. The port is therefore defined once, in `BIND_ADDR`,
    /// and a moved port does not have to be repeated here.
    pub app_origins: Vec<String>,
    /// `PUBLIC_URL` — the **single** origin clients reach this server at, e.g.
    /// `https://notes.example.com`. Optional; `None` is the default and changes
    /// nothing.
    ///
    /// It is not an allowlist and it is not `APP_ORIGIN`. `APP_ORIGIN` answers
    /// "which origins may talk to me" (a set, checked against a request's
    /// `Origin` header); this answers "what URL am I reached at" — a single
    /// value the server otherwise has no way to know, since it is TLS-unaware
    /// and sits behind an ingress that rewrites the host (SPEC §8).
    ///
    /// Today exactly one thing consumes it: the CSP the Flutter shell's bundle
    /// carries (`routes::shell::shell_csp`). That document is served by the
    /// device's own loopback origin, so *every* API call and the sync socket are
    /// cross-origin to it, and without a name for the server the only policy
    /// that works is scheme-wide (`connect-src … https: http: wss: ws:`).
    /// Setting this names the server and the policy narrows to it.
    pub public_url: Option<String>,
    /// `LOG_FORMAT` = `json` | `pretty`.
    pub log_format: LogFormat,
    /// `COOKIE_SECURE`, default true; only settable to false for local http dev.
    pub cookie_secure: bool,
    /// `TRUST_PROXY_HEADERS`, default **false**.
    ///
    /// `false` — the client IP is the socket address, and `X-Forwarded-For` /
    /// `X-Real-IP` are ignored. This is correct for the Compose deployment of
    /// SPEC §8, where the server is published directly and any forwarding header
    /// is attacker-written.
    ///
    /// `true` — the server sits behind exactly one trusted reverse proxy
    /// (ingress, Caddy) that *appends* the real client address to
    /// `X-Forwarded-For`; the **rightmost** hop is then used. Set this only when
    /// such a proxy is the only way to reach the server, because it hands the
    /// rate-limit key and the audit-log IP to whoever writes that header.
    pub trust_proxy_headers: bool,
    /// `TRASH_RETENTION_DAYS`, default 30 (SPEC §3.5).
    pub trash_retention_days: u32,
    /// `CHECKPOINT_EVERY_CHANGES`, default 1000: a full-text checkpoint of a document
    /// after this many changes, so any point in its history is at most this many steps
    /// from one (`dev-docs/resolved/HISTORY.md`).
    pub checkpoint_every_changes: u32,
    /// `RAW_CHANGE_DAYS`, default 30: raw changes older than this are squashed into one
    /// record per group.
    pub raw_change_days: u32,
    /// `HISTORY_SQUASH_INTERVAL_SECS`, default 3600: how often the squash job runs.
    pub history_squash_interval: Duration,
    /// `INVITE_TTL_DAYS`, default 7 (SPEC §5.1).
    pub invite_ttl_days: u32,
    /// `SESSION_IDLE_DAYS`, default 30 (SPEC §5.2).
    pub session_idle_days: u32,
    /// `SESSION_ABSOLUTE_DAYS`, default 180 (SPEC §5.2).
    pub session_absolute_days: u32,
    /// `MATERIALIZE_DEBOUNCE_MS`, default 500 (SPEC §3.5).
    pub materialize_debounce: Duration,
    /// `ROOM_IDLE_TIMEOUT_SECS`, default 600 — hot doc eviction (SPEC §4.3).
    pub room_idle_timeout: Duration,
    /// `UPDATE_LOG_KEEP_BYTES`, default 1 MiB per document (SPEC §3.5 trimming).
    pub update_log_keep_bytes: u64,
    /// `UPDATE_LOG_KEEP_COUNT`, default 200 per document.
    pub update_log_keep_count: u32,
    /// `CRDT_COMPACT_THRESHOLD_BYTES`, default 4 MiB (SPEC §3.5).
    pub crdt_compact_threshold_bytes: u64,
    /// `CRDT_ALERT_THRESHOLD_BYTES`, default 8 MiB (SPEC §3.5).
    pub crdt_alert_threshold_bytes: u64,
    /// `LOGIN_MAX_ATTEMPTS`, default 10 per window (SPEC §5.2).
    pub login_max_attempts: u32,
    /// `LOGIN_ATTEMPT_WINDOW_SECS`, default 900.
    pub login_attempt_window: Duration,
    /// `SHUTDOWN_GRACE_SECS`, default 30 (SPEC §8).
    pub shutdown_grace: Duration,

    // ---- M3: serving the PWA and the plugin distribution (SPEC §6.4, §8) ----
    /// `WEB_DIST_DIR` — the built PWA (`web/app/dist`). Unset ⇒ the server serves
    /// no frontend at all, which is the right shape for a dev setup where Vite
    /// serves it and proxies `/api` here.
    pub web_dist_dir: Option<PathBuf>,
    /// `PLUGINS_DIR`, default `plugins/base/dist` — one directory per installed
    /// plugin per version (`<id>/<version>/manifest.json`), served at
    /// `/plugins/<id>/<version>/…`. In M4 this is where the zip installer
    /// extracts; in M3 the base distribution's build writes it.
    pub plugins_dir: PathBuf,
    /// `KERNEL_DTS_PATH`, default `web/kernel-api/dist/kernel.d.ts` — the
    /// generated plugin contract, served at `/kernel.d.ts` (SPEC §6.4).
    pub kernel_dts_path: Option<PathBuf>,
    /// `DISABLE_PLUGINS`, default false. The server-side half of safe mode
    /// (SPEC §6.1): every client is told the installed plugin list is empty.
    ///
    /// M4 widens its meaning: it also stops the **backend** host — nothing is compiled, no
    /// cron fires, no hook is delivered, every `/api/plugins/:id/*` route 404s. Safe mode
    /// has to mean "no plugin code runs anywhere", or a broken backend half would still be
    /// running while the operator is looking at a bare client.
    pub disable_plugins: bool,

    // ---- M4: the backend plugin host and the install flow (SPEC §6.2, §6.3) ----
    /// `PLUGIN_STAGING_DIR`, default `<PLUGINS_DIR>.staging`. Extraction and the
    /// *pending* set live here — a sibling of the served root, same filesystem, so the
    /// install and the approval are both atomic renames.
    pub plugin_staging_dir: PathBuf,
    /// `PLUGIN_INBOX_DIR`, unset by default. A directory to watch for dropped `.zip`
    /// packages (SPEC §6.2's second install path). Unset ⇒ no watcher, deliberately: a
    /// guessed relative default is how M3 learned that `backend/plugins/…` silently exists.
    pub plugin_inbox_dir: Option<PathBuf>,
    /// `CONFIG_KEY` — 32 bytes, hex or base64, for encrypting `secret: true` config values.
    /// Unset ⇒ derived from `SESSION_SECRET` (SPEC §6.2), with the consequence documented
    /// in `plugininstall::config`: rotating the session secret then makes stored secrets
    /// unreadable and they must be re-entered.
    pub plugin_config_key: Option<SessionSecret>,
    /// `PLUGIN_CALL_TIMEOUT_MS`, default 5 000 (SPEC §6.3). Clamped down only.
    pub plugin_call_timeout: Duration,
    /// `PLUGIN_CRON_TIMEOUT_MS`, default 60 000.
    pub plugin_cron_timeout: Duration,
    /// `PLUGIN_MEMORY_BYTES`, default 128 MiB.
    pub plugin_memory_bytes: u64,
    /// `PLUGIN_MAX_INSTANCES`, default 4 — per plugin, and therefore its concurrency.
    pub plugin_max_instances: usize,
    /// `PLUGIN_BREAKER_THRESHOLD`, default 5 consecutive failures.
    pub plugin_breaker_threshold: u32,
    /// `PLUGIN_HTTP_TIMEOUT_MS`, default 10 000.
    pub plugin_http_timeout: Duration,
    /// `PLUGIN_HTTP_MAX_RESPONSE_BYTES`, default 10 MiB.
    pub plugin_http_max_response_bytes: u64,
    /// `PLUGIN_HTTP_ALLOW_CIDRS` — comma-separated CIDRs an operator deliberately allows
    /// outbound, on top of the default-deny for private, loopback, link-local and metadata
    /// addresses (SPEC §6.2: "admin-configurable allowlist"). This is how a self-hosted LAN
    /// service becomes reachable, and it is the one knob that *widens* the sandbox — so it
    /// is spelled as CIDRs an operator has to type, never as a boolean.
    pub plugin_http_allow_cidrs: Vec<ipnet::IpNet>,
    /// `PLUGIN_ENABLE_CRON`, default true. Off is the "why is this job running twice"
    /// switch for a second server pointed at one database (HA is v2, SPEC §8) and for
    /// local debugging.
    pub plugin_enable_cron: bool,
}

/// `SESSION_SECRET` bytes. Never logged, never serialized.
#[derive(Clone)]
pub struct SessionSecret(Vec<u8>);

impl SessionSecret {
    /// Validate and wrap. Rejects anything shorter than
    /// [`MIN_SESSION_SECRET_BYTES`].
    pub fn new(bytes: Vec<u8>) -> Result<Self, ConfigError> {
        if bytes.len() < MIN_SESSION_SECRET_BYTES {
            return Err(ConfigError::SessionSecretTooShort { len: bytes.len() });
        }
        Ok(Self(bytes))
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl std::fmt::Debug for SessionSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionSecret(<redacted>)")
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("{0} is required but not set")]
    Missing(&'static str),
    #[error("{var} is invalid: {reason}")]
    Invalid { var: &'static str, reason: String },
    #[error("SESSION_SECRET must be at least 32 bytes, got {len}")]
    SessionSecretTooShort { len: usize },
}

impl Config {
    /// The largest attachment accepted, or `None` when `MAX_ATTACHMENT_BYTES` is `0`.
    pub fn attachment_limit(&self) -> Option<u64> {
        (self.max_attachment_bytes > 0).then_some(self.max_attachment_bytes)
    }

    /// Read and validate the environment. Loads a `.env` file first when present
    /// (dev convenience; never overrides real env vars).
    ///
    /// Every failure mode is a boot failure: a server that starts with a
    /// half-understood environment is worse than one that refuses to start
    /// (SPEC §5.2 — `SESSION_SECRET` has no default, ever).
    pub fn from_env() -> Result<Config, ConfigError> {
        // `dotenvy::dotenv` never overrides variables that are already set.
        let _ = dotenvy::dotenv();

        let session_secret = SessionSecret::new(required("SESSION_SECRET")?.into_bytes())?;

        let bind_addr: SocketAddr = parse_var(
            "BIND_ADDR",
            DEFAULT_BIND_ADDR
                .parse()
                .expect("DEFAULT_BIND_ADDR is a valid socket address"),
        )?;

        let max_document_bytes = parse_var::<usize>(
            "MAX_DOCUMENT_BYTES",
            life_manager_core::limits::MAX_DOCUMENT_BYTES,
        )?
        // The shared core's cap is a hard ceiling: client and server must agree
        // on what is too large, so configuration may only lower it.
        .min(life_manager_core::limits::MAX_DOCUMENT_BYTES);
        if max_document_bytes == 0 {
            return Err(ConfigError::Invalid {
                var: "MAX_DOCUMENT_BYTES",
                reason: "must be greater than zero".to_string(),
            });
        }

        let mut app_origins = parse_origins("APP_ORIGIN")?;
        for origin in derived_origins(bind_addr.port(), var("APP_ORIGIN_HOSTS").as_deref()) {
            if !app_origins.iter().any(|o| o.eq_ignore_ascii_case(&origin)) {
                app_origins.push(origin);
            }
        }

        // Validated by exactly the same parser as `APP_ORIGIN`, then required to be one
        // value: a `PUBLIC_URL` with a path, a trailing junk segment or two entries would
        // otherwise be pasted straight into a CSP, where a malformed source silently
        // *widens* nothing but does silently fail to match — the app would look broken for
        // no visible reason. A bad variable is a boot failure here, like every other.
        let public_url = match parse_origins("PUBLIC_URL")?.as_slice() {
            [] => None,
            [origin] => Some(origin.clone()),
            many => {
                return Err(ConfigError::Invalid {
                    var: "PUBLIC_URL",
                    reason: format!(
                        "expected one origin, got {} — this is the URL this server is reached \
                         at, not an allowlist (that is APP_ORIGIN)",
                        many.len()
                    ),
                });
            }
        };

        // Hoisted out of the struct literal because `PLUGIN_STAGING_DIR`'s default is
        // derived from it (`<PLUGINS_DIR>.staging`, a sibling of the served root).
        let plugins_dir = var("PLUGINS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_PLUGINS_DIR));

        let config = Config {
            mongo_uri: required("MONGO_URI")?,
            bind_addr,
            session_secret,

            mongo_database: var("MONGO_DATABASE").unwrap_or_else(|| DEFAULT_DATABASE.to_string()),
            max_attachment_bytes: parse_var("MAX_ATTACHMENT_BYTES", DEFAULT_MAX_ATTACHMENT_BYTES)?,
            max_document_bytes,
            app_origins,
            public_url,
            log_format: parse_log_format("LOG_FORMAT")?,
            cookie_secure: parse_bool("COOKIE_SECURE", true)?,
            // Off by default: trusting a forwarding header that no proxy
            // rewrites lets a client pick its own rate-limit bucket and its own
            // audit-log origin (SPEC §5.2, §5.4).
            trust_proxy_headers: parse_bool("TRUST_PROXY_HEADERS", false)?,
            trash_retention_days: parse_var("TRASH_RETENTION_DAYS", 30u32)?,
            checkpoint_every_changes: parse_var("CHECKPOINT_EVERY_CHANGES", 1000u32)?,
            raw_change_days: parse_var("RAW_CHANGE_DAYS", 30u32)?,
            history_squash_interval: Duration::from_secs(parse_var(
                "HISTORY_SQUASH_INTERVAL_SECS",
                3600u64,
            )?),
            invite_ttl_days: parse_var("INVITE_TTL_DAYS", 7u32)?,
            session_idle_days: parse_var("SESSION_IDLE_DAYS", 30u32)?,
            session_absolute_days: parse_var("SESSION_ABSOLUTE_DAYS", 180u32)?,
            materialize_debounce: parse_millis("MATERIALIZE_DEBOUNCE_MS", 500)?,
            room_idle_timeout: parse_secs("ROOM_IDLE_TIMEOUT_SECS", 600)?,
            update_log_keep_bytes: parse_var("UPDATE_LOG_KEEP_BYTES", 1024 * 1024u64)?,
            update_log_keep_count: parse_var("UPDATE_LOG_KEEP_COUNT", 200u32)?,
            crdt_compact_threshold_bytes: parse_var(
                "CRDT_COMPACT_THRESHOLD_BYTES",
                4 * 1024 * 1024u64,
            )?,
            crdt_alert_threshold_bytes: parse_var(
                "CRDT_ALERT_THRESHOLD_BYTES",
                8 * 1024 * 1024u64,
            )?,
            login_max_attempts: parse_var("LOGIN_MAX_ATTEMPTS", 10u32)?,
            login_attempt_window: parse_secs("LOGIN_ATTEMPT_WINDOW_SECS", 900)?,
            shutdown_grace: parse_secs("SHUTDOWN_GRACE_SECS", DEFAULT_SHUTDOWN_GRACE_SECS)?,

            web_dist_dir: var("WEB_DIST_DIR").map(PathBuf::from),
            plugins_dir: plugins_dir.clone(),
            // Unlike `WEB_DIST_DIR` this has a default, because it is generated
            // from this repository and the route reports its absence clearly.
            kernel_dts_path: Some(
                var("KERNEL_DTS_PATH")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from(DEFAULT_KERNEL_DTS_PATH)),
            ),
            disable_plugins: parse_bool("DISABLE_PLUGINS", false)?,

            plugin_staging_dir: var("PLUGIN_STAGING_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| default_staging_dir(&plugins_dir)),
            plugin_inbox_dir: var("PLUGIN_INBOX_DIR").map(PathBuf::from),
            plugin_config_key: parse_config_key("CONFIG_KEY")?,
            plugin_call_timeout: parse_millis(
                "PLUGIN_CALL_TIMEOUT_MS",
                life_manager_plugin_abi::limits::CALL_TIMEOUT_MS,
            )?,
            plugin_cron_timeout: parse_millis(
                "PLUGIN_CRON_TIMEOUT_MS",
                life_manager_plugin_abi::limits::CRON_CALL_TIMEOUT_MS,
            )?,
            plugin_memory_bytes: parse_var(
                "PLUGIN_MEMORY_BYTES",
                life_manager_plugin_abi::limits::MEMORY_BYTES,
            )?,
            plugin_max_instances: parse_var(
                "PLUGIN_MAX_INSTANCES",
                life_manager_plugin_abi::limits::MAX_INSTANCES_PER_PLUGIN,
            )?,
            plugin_breaker_threshold: parse_var(
                "PLUGIN_BREAKER_THRESHOLD",
                life_manager_plugin_abi::limits::BREAKER_FAILURE_THRESHOLD,
            )?,
            plugin_http_timeout: parse_millis(
                "PLUGIN_HTTP_TIMEOUT_MS",
                life_manager_plugin_abi::limits::HTTP_TIMEOUT_MS,
            )?,
            plugin_http_max_response_bytes: parse_var(
                "PLUGIN_HTTP_MAX_RESPONSE_BYTES",
                life_manager_plugin_abi::limits::MAX_HTTP_RESPONSE_BYTES,
            )?,
            plugin_http_allow_cidrs: parse_cidrs("PLUGIN_HTTP_ALLOW_CIDRS")?,
            plugin_enable_cron: parse_bool("PLUGIN_ENABLE_CRON", true)?,
        };

        if config.session_absolute_days < config.session_idle_days {
            return Err(ConfigError::Invalid {
                var: "SESSION_ABSOLUTE_DAYS",
                reason: "must be at least SESSION_IDLE_DAYS".to_string(),
            });
        }
        if config.crdt_alert_threshold_bytes < config.crdt_compact_threshold_bytes {
            return Err(ConfigError::Invalid {
                var: "CRDT_ALERT_THRESHOLD_BYTES",
                reason: "must be at least CRDT_COMPACT_THRESHOLD_BYTES".to_string(),
            });
        }
        if config.checkpoint_every_changes == 0 {
            return Err(ConfigError::Invalid {
                var: "CHECKPOINT_EVERY_CHANGES",
                reason: "must be greater than zero".to_string(),
            });
        }
        if config.login_max_attempts == 0 {
            return Err(ConfigError::Invalid {
                var: "LOGIN_MAX_ATTEMPTS",
                reason: "must be greater than zero".to_string(),
            });
        }

        Ok(config)
    }

    /// Cookie name for browser sessions.
    pub fn session_cookie_name(&self) -> &'static str {
        "lm_session"
    }

    /// [`Config::public_url`] as a WebSocket origin. See [`ws_origin`].
    pub fn public_ws_origin(&self) -> Option<String> {
        ws_origin(self.public_url.as_deref()?)
    }

    /// `true` when `origin` is allowed to talk to this server.
    ///
    /// Exact, case-insensitive match against the allowlist (`APP_ORIGIN` plus the
    /// server's own loopback origins, see [`Config::app_origins`]). No wildcards and no
    /// suffix matching: the allowlist gates CORS and the WebSocket upgrade (SPEC §4.3),
    /// where a sloppy match is a cross-origin hole.
    pub fn origin_allowed(&self, origin: &str) -> bool {
        let origin = origin.trim_end_matches('/');
        self.app_origins
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(origin))
    }
}

// ---------------------------------------------------------------------------
// env helpers — the only place in the server that reads `std::env`
// ---------------------------------------------------------------------------

/// A set, non-empty variable, trimmed. Empty or whitespace-only reads as unset
/// (compose and Kubernetes both turn "unset" into "" often enough).
fn var(key: &'static str) -> Option<String> {
    match std::env::var(key) {
        Ok(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Err(_) => None,
    }
}

fn required(key: &'static str) -> Result<String, ConfigError> {
    var(key).ok_or(ConfigError::Missing(key))
}

fn parse_var<T>(key: &'static str, default: T) -> Result<T, ConfigError>
where
    T: FromStr,
    T::Err: std::fmt::Display,
{
    match var(key) {
        None => Ok(default),
        Some(raw) => raw.parse::<T>().map_err(|err| ConfigError::Invalid {
            var: key,
            reason: err.to_string(),
        }),
    }
}

fn parse_bool(key: &'static str, default: bool) -> Result<bool, ConfigError> {
    match var(key) {
        None => Ok(default),
        Some(raw) => match raw.to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            other => Err(ConfigError::Invalid {
                var: key,
                reason: format!("expected a boolean, got `{other}`"),
            }),
        },
    }
}

fn parse_secs(key: &'static str, default_secs: u64) -> Result<Duration, ConfigError> {
    parse_var(key, default_secs).map(Duration::from_secs)
}

fn parse_millis(key: &'static str, default_millis: u64) -> Result<Duration, ConfigError> {
    parse_var(key, default_millis).map(Duration::from_millis)
}

fn parse_log_format(key: &'static str) -> Result<LogFormat, ConfigError> {
    match var(key) {
        None => Ok(LogFormat::Json),
        Some(raw) => match raw.to_ascii_lowercase().as_str() {
            "json" => Ok(LogFormat::Json),
            "pretty" | "text" | "compact" => Ok(LogFormat::Pretty),
            other => Err(ConfigError::Invalid {
                var: key,
                reason: format!("expected `json` or `pretty`, got `{other}`"),
            }),
        },
    }
}

/// `<PLUGINS_DIR>.staging` — a sibling directory, so the pending set is outside the tree
/// the registry scans while staying on the same filesystem as the final rename.
fn default_staging_dir(plugins_dir: &std::path::Path) -> PathBuf {
    let mut name = plugins_dir.as_os_str().to_os_string();
    name.push(".staging");
    PathBuf::from(name)
}

/// `CONFIG_KEY` as 32 raw bytes: 64 hex characters, or base64.
///
/// Reuses [`SessionSecret`] as the container for one reason worth stating — it is the type
/// in this file that refuses to print itself, and a key that can reach a log line is not a
/// key.
fn parse_config_key(key: &'static str) -> Result<Option<SessionSecret>, ConfigError> {
    let Some(raw) = var(key) else {
        return Ok(None);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        // An empty value is the same as unset, not a boot failure: it is what a
        // Compose file with `CONFIG_KEY: ${CONFIG_KEY}` and nothing exported does.
        return Ok(None);
    }

    // Hex first, because a 64-character hex string is also valid base64 — decoding
    // it as base64 would silently yield 48 bytes of the wrong key, and a key that is
    // wrong-but-accepted makes every stored secret unreadable with no error to read.
    let bytes = if raw.len() == CONFIG_KEY_BYTES * 2 && raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        hex::decode(raw).map_err(|err| ConfigError::Invalid {
            var: key,
            reason: format!("not valid hex: {err}"),
        })?
    } else {
        decode_base64_any(raw).ok_or_else(|| ConfigError::Invalid {
            var: key,
            reason: format!(
                "expected {} bytes as {} hex characters or base64",
                CONFIG_KEY_BYTES,
                CONFIG_KEY_BYTES * 2
            ),
        })?
    };

    if bytes.len() != CONFIG_KEY_BYTES {
        return Err(ConfigError::Invalid {
            var: key,
            reason: format!(
                "decoded to {} bytes, expected {CONFIG_KEY_BYTES}",
                bytes.len()
            ),
        });
    }

    // `SessionSecret` is the wrapper because it is the type in this file that refuses
    // to print itself; its 32-byte floor is exactly `CONFIG_KEY_BYTES`, so the check
    // above has already passed it.
    SessionSecret::new(bytes).map(Some)
}

/// Decode base64 in any of the four spellings an operator might paste: standard or
/// URL-safe alphabet, padded or not.
fn decode_base64_any(raw: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};

    STANDARD
        .decode(raw)
        .or_else(|_| STANDARD_NO_PAD.decode(raw))
        .or_else(|_| URL_SAFE.decode(raw))
        .or_else(|_| URL_SAFE_NO_PAD.decode(raw))
        .ok()
}

/// `PLUGIN_HTTP_ALLOW_CIDRS` — comma-separated CIDRs (`10.1.2.0/24`, `fd00::/8`).
fn parse_cidrs(key: &'static str) -> Result<Vec<ipnet::IpNet>, ConfigError> {
    let Some(raw) = var(key) else {
        return Ok(Vec::new());
    };

    let mut nets = Vec::new();
    for entry in raw.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        // A bare address is accepted and read as a single-host CIDR — `10.1.2.3` is
        // what an operator writes when they mean one internal service, and refusing it
        // over a missing `/32` is pedantry that gets worked around with a wider mask.
        let net = match entry.parse::<ipnet::IpNet>() {
            Ok(net) => net,
            Err(_) => match entry.parse::<std::net::IpAddr>() {
                Ok(addr) => ipnet::IpNet::from(addr),
                Err(_) => {
                    return Err(ConfigError::Invalid {
                        var: key,
                        reason: format!("`{entry}` is not a CIDR block or IP address"),
                    });
                }
            },
        };
        nets.push(net);
    }
    Ok(nets)
}

/// An http(s) origin with its scheme swapped for the WebSocket one
/// (`https` → `wss`, `http` → `ws`). `None` for anything else.
///
/// A CSP source is matched scheme-and-all, and `/api/sync` is opened as a
/// `wss://` URL: listing only the `https://` origin in `connect-src` would admit
/// every REST call and refuse the socket. Both spellings of the same host have
/// to be named, which is why this exists rather than each caller doing string
/// surgery on an origin.
pub fn ws_origin(origin: &str) -> Option<String> {
    match origin.split_once("://") {
        Some(("https", rest)) if !rest.is_empty() => Some(format!("wss://{rest}")),
        Some(("http", rest)) if !rest.is_empty() => Some(format!("ws://{rest}")),
        _ => None,
    }
}

/// The origins this server is its own page at: `http://localhost:<port>` and
/// `http://127.0.0.1:<port>` on its listen port, plus one `http://<host>:<port>` per
/// comma-separated host in `hosts` (`APP_ORIGIN_HOSTS`: a LAN address the phone opens,
/// for example). Plain http only, because the server is TLS-unaware; anything behind
/// a proxy is named in full in `APP_ORIGIN`.
///
/// Safe to allow without being asked: a page at the server's own loopback origin *is*
/// the app, and a page on any other port (or any other host) is a different origin.
fn derived_origins(port: u16, hosts: Option<&str>) -> Vec<String> {
    let extra = hosts
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|host| !host.is_empty());
    let mut origins = Vec::new();
    for host in ["localhost", "127.0.0.1"].into_iter().chain(extra) {
        let origin = format!("http://{host}:{port}");
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    origins
}

/// Parse `APP_ORIGIN` — comma separated, each entry `scheme://host[:port]` with
/// no path and no trailing slash (that is what a browser sends in `Origin`).
fn parse_origins(key: &'static str) -> Result<Vec<String>, ConfigError> {
    let Some(raw) = var(key) else {
        return Ok(Vec::new());
    };

    let mut origins = Vec::new();
    for entry in raw.split(',') {
        let entry = entry.trim().trim_end_matches('/');
        if entry.is_empty() {
            continue;
        }
        let Some((scheme, rest)) = entry.split_once("://") else {
            return Err(ConfigError::Invalid {
                var: key,
                reason: format!("`{entry}` is not an origin (expected scheme://host[:port])"),
            });
        };
        if !matches!(scheme, "http" | "https") || rest.is_empty() || rest.contains('/') {
            return Err(ConfigError::Invalid {
                var: key,
                reason: format!("`{entry}` is not an http(s) origin without a path"),
            });
        }
        if !origins.iter().any(|o: &String| o == entry) {
            origins.push(entry.to_string());
        }
    }
    Ok(origins)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_secret_enforces_the_minimum_length() {
        assert!(SessionSecret::new(vec![b'x'; 31]).is_err());
        assert!(SessionSecret::new(vec![b'x'; 32]).is_ok());
    }

    #[test]
    fn session_secret_never_prints_itself() {
        let secret = SessionSecret::new(vec![b'a'; 32]).expect("valid");
        assert_eq!(format!("{secret:?}"), "SessionSecret(<redacted>)");
        assert!(!format!("{secret:?}").contains("aaaa"));
    }

    #[test]
    fn a_zero_attachment_limit_means_no_limit() {
        let mut config = config_with_origins(&[]);
        assert_eq!(config.attachment_limit(), Some(100 * 1024 * 1024));
        config.max_attachment_bytes = 0;
        assert_eq!(config.attachment_limit(), None);
    }

    fn config_with_origins(origins: &[&str]) -> Config {
        Config {
            mongo_uri: "mongodb://127.0.0.1:27017".to_string(),
            bind_addr: DEFAULT_BIND_ADDR.parse().expect("valid default"),
            session_secret: SessionSecret::new(vec![b'k'; 32]).expect("valid"),
            mongo_database: DEFAULT_DATABASE.to_string(),
            max_attachment_bytes: DEFAULT_MAX_ATTACHMENT_BYTES,
            max_document_bytes: life_manager_core::limits::MAX_DOCUMENT_BYTES,
            app_origins: origins.iter().map(|o| o.to_string()).collect(),
            public_url: None,
            log_format: LogFormat::Json,
            cookie_secure: true,
            trust_proxy_headers: false,
            trash_retention_days: 30,
            checkpoint_every_changes: 1000,
            raw_change_days: 30,
            history_squash_interval: Duration::from_secs(3600),
            invite_ttl_days: 7,
            session_idle_days: 30,
            session_absolute_days: 180,
            materialize_debounce: Duration::from_millis(500),
            room_idle_timeout: Duration::from_secs(600),
            update_log_keep_bytes: 1024 * 1024,
            update_log_keep_count: 200,
            crdt_compact_threshold_bytes: 4 * 1024 * 1024,
            crdt_alert_threshold_bytes: 8 * 1024 * 1024,
            login_max_attempts: 10,
            login_attempt_window: Duration::from_secs(900),
            shutdown_grace: Duration::from_secs(DEFAULT_SHUTDOWN_GRACE_SECS),
            web_dist_dir: None,
            plugins_dir: PathBuf::from(DEFAULT_PLUGINS_DIR),
            kernel_dts_path: None,
            disable_plugins: false,
            plugin_staging_dir: default_staging_dir(&PathBuf::from(DEFAULT_PLUGINS_DIR)),
            plugin_inbox_dir: None,
            plugin_config_key: None,
            plugin_call_timeout: Duration::from_millis(
                life_manager_plugin_abi::limits::CALL_TIMEOUT_MS,
            ),
            plugin_cron_timeout: Duration::from_millis(
                life_manager_plugin_abi::limits::CRON_CALL_TIMEOUT_MS,
            ),
            plugin_memory_bytes: life_manager_plugin_abi::limits::MEMORY_BYTES,
            plugin_max_instances: life_manager_plugin_abi::limits::MAX_INSTANCES_PER_PLUGIN,
            plugin_breaker_threshold: life_manager_plugin_abi::limits::BREAKER_FAILURE_THRESHOLD,
            plugin_http_timeout: Duration::from_millis(
                life_manager_plugin_abi::limits::HTTP_TIMEOUT_MS,
            ),
            plugin_http_max_response_bytes:
                life_manager_plugin_abi::limits::MAX_HTTP_RESPONSE_BYTES,
            plugin_http_allow_cidrs: Vec::new(),
            plugin_enable_cron: true,
        }
    }

    #[test]
    fn the_server_allows_its_own_loopback_origins_and_the_listed_hosts() {
        assert_eq!(
            derived_origins(8081, None),
            vec!["http://localhost:8081", "http://127.0.0.1:8081"]
        );
        // Hosts are trimmed, empties skipped, duplicates dropped; the port is the
        // server's own, so it is defined once.
        assert_eq!(
            derived_origins(8080, Some(" 192.168.0.69, ,localhost,notes.lan ")),
            vec![
                "http://localhost:8080",
                "http://127.0.0.1:8080",
                "http://192.168.0.69:8080",
                "http://notes.lan:8080",
            ]
        );
    }

    #[test]
    fn origin_allowlist_is_exact_and_case_insensitive() {
        let config = config_with_origins(&["https://notes.example.com"]);
        assert!(config.origin_allowed("https://notes.example.com"));
        assert!(config.origin_allowed("https://NOTES.example.com"));
        assert!(config.origin_allowed("https://notes.example.com/"));
        // No suffix or scheme fuzzing.
        assert!(!config.origin_allowed("http://notes.example.com"));
        assert!(!config.origin_allowed("https://evil-notes.example.com"));
        assert!(!config.origin_allowed("https://notes.example.com.evil.test"));
    }

    #[test]
    fn empty_allowlist_allows_nothing() {
        let config = config_with_origins(&[]);
        assert!(!config.origin_allowed("https://notes.example.com"));
    }

    #[test]
    fn a_public_url_yields_both_spellings_of_its_origin() {
        // The pair a CSP `connect-src` needs: the REST origin and the socket origin.
        assert_eq!(
            ws_origin("https://notes.example.com").as_deref(),
            Some("wss://notes.example.com")
        );
        assert_eq!(
            ws_origin("http://192.168.1.10:8080").as_deref(),
            Some("ws://192.168.1.10:8080")
        );
        // Anything `parse_origins` would already have refused has no WebSocket form.
        assert_eq!(ws_origin("notes.example.com"), None);
        assert_eq!(ws_origin("ftp://notes.example.com"), None);
        assert_eq!(ws_origin("https://"), None);

        let mut config = config_with_origins(&[]);
        assert_eq!(config.public_ws_origin(), None);
        config.public_url = Some("https://notes.example.com".to_string());
        assert_eq!(
            config.public_ws_origin().as_deref(),
            Some("wss://notes.example.com")
        );
    }
}

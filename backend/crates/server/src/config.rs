//! Environment configuration. Read once at boot; everything downstream takes
//! `&Config` or `Arc<Config>` — no `std::env` reads outside this file.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use thiserror::Error;

/// Default Mongo database name.
pub const DEFAULT_DATABASE: &str = "life_manager";
/// Default attachment size cap (SPEC §3.5).
pub const DEFAULT_MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
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
    /// — that is the documented promise in `docs/OPERATIONS.md`, and it only
    /// holds because the secret is in the derivation.
    pub session_secret: SessionSecret,

    // ---- optional, with defaults ----
    /// `MONGO_DATABASE`, default [`DEFAULT_DATABASE`].
    pub mongo_database: String,
    /// `MAX_ATTACHMENT_BYTES`, default 25 MiB (SPEC §3.5).
    pub max_attachment_bytes: u64,
    /// `MAX_DOCUMENT_BYTES`, default 1 MiB (SPEC §3.5); clamped to the shared
    /// core's hard cap.
    pub max_document_bytes: usize,
    /// `APP_ORIGIN` — comma-separated allowlist. Required by the WS upgrade in
    /// M2; used for CORS in M1. Empty = same-origin only.
    pub app_origins: Vec<String>,
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
    /// `SEED_WELCOME_DOCS`, default true (SPEC §6.5 first run).
    pub seed_welcome_docs: bool,

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
    pub disable_plugins: bool,
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

        let app_origins = parse_origins("APP_ORIGIN")?;

        let config = Config {
            mongo_uri: required("MONGO_URI")?,
            bind_addr,
            session_secret,

            mongo_database: var("MONGO_DATABASE").unwrap_or_else(|| DEFAULT_DATABASE.to_string()),
            max_attachment_bytes: parse_var("MAX_ATTACHMENT_BYTES", DEFAULT_MAX_ATTACHMENT_BYTES)?,
            max_document_bytes,
            app_origins,
            log_format: parse_log_format("LOG_FORMAT")?,
            cookie_secure: parse_bool("COOKIE_SECURE", true)?,
            // Off by default: trusting a forwarding header that no proxy
            // rewrites lets a client pick its own rate-limit bucket and its own
            // audit-log origin (SPEC §5.2, §5.4).
            trust_proxy_headers: parse_bool("TRUST_PROXY_HEADERS", false)?,
            trash_retention_days: parse_var("TRASH_RETENTION_DAYS", 30u32)?,
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
            seed_welcome_docs: parse_bool("SEED_WELCOME_DOCS", true)?,

            web_dist_dir: var("WEB_DIST_DIR").map(PathBuf::from),
            plugins_dir: var("PLUGINS_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(DEFAULT_PLUGINS_DIR)),
            // Unlike `WEB_DIST_DIR` this has a default, because it is generated
            // from this repository and the route reports its absence clearly.
            kernel_dts_path: Some(
                var("KERNEL_DTS_PATH")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from(DEFAULT_KERNEL_DTS_PATH)),
            ),
            disable_plugins: parse_bool("DISABLE_PLUGINS", false)?,
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

    /// `true` when `origin` is allowed to talk to this server.
    ///
    /// Exact, case-insensitive match against `APP_ORIGIN`. No wildcards and no
    /// suffix matching: the allowlist gates CORS today and the WebSocket upgrade
    /// in M2 (SPEC §4.3), where a sloppy match is a cross-origin hole. An empty
    /// allowlist allows nothing — same-origin requests carry no `Origin` the
    /// server has to approve.
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

    fn config_with_origins(origins: &[&str]) -> Config {
        Config {
            mongo_uri: "mongodb://127.0.0.1:27017".to_string(),
            bind_addr: DEFAULT_BIND_ADDR.parse().expect("valid default"),
            session_secret: SessionSecret::new(vec![b'k'; 32]).expect("valid"),
            mongo_database: DEFAULT_DATABASE.to_string(),
            max_attachment_bytes: DEFAULT_MAX_ATTACHMENT_BYTES,
            max_document_bytes: life_manager_core::limits::MAX_DOCUMENT_BYTES,
            app_origins: origins.iter().map(|o| o.to_string()).collect(),
            log_format: LogFormat::Json,
            cookie_secure: true,
            trust_proxy_headers: false,
            trash_retention_days: 30,
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
            seed_welcome_docs: true,
            web_dist_dir: None,
            plugins_dir: PathBuf::from(DEFAULT_PLUGINS_DIR),
            kernel_dts_path: None,
            disable_plugins: false,
        }
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
}

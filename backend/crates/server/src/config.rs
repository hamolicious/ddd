use std::net::SocketAddr;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use thiserror::Error;

pub const DEFAULT_DATABASE: &str = "ddd";
pub const DEFAULT_MAX_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;
pub const MIN_SESSION_SECRET_BYTES: usize = 32;
pub const DEFAULT_BIND_ADDR: &str = "0.0.0.0:8080";
pub const DEFAULT_SHUTDOWN_GRACE_SECS: u64 = 30;
pub const DEFAULT_PLUGINS_DIR: &str = "plugins/base/dist";
pub const DEFAULT_KERNEL_DTS_PATH: &str = "web/kernel-api/dist/kernel.d.ts";
pub const CONFIG_KEY_BYTES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Pretty,
    Json,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub mongo_uri: String,
    pub bind_addr: SocketAddr,
    pub session_secret: SessionSecret,

    pub mongo_database: String,
    pub max_attachment_bytes: u64,
    pub max_document_bytes: usize,
    pub app_origins: Vec<String>,
    pub public_url: Option<String>,
    pub log_format: LogFormat,
    pub cookie_secure: bool,
    pub trust_proxy_headers: bool,
    pub trash_retention_days: u32,
    pub checkpoint_every_changes: u32,
    pub raw_change_days: u32,
    pub history_squash_interval: Duration,
    pub invite_ttl_days: u32,
    pub session_idle_days: u32,
    pub session_absolute_days: u32,
    pub materialize_debounce: Duration,
    pub room_idle_timeout: Duration,
    pub update_log_keep_bytes: u64,
    pub update_log_keep_count: u32,
    pub crdt_compact_threshold_bytes: u64,
    pub crdt_alert_threshold_bytes: u64,
    pub login_max_attempts: u32,
    pub login_attempt_window: Duration,
    pub shutdown_grace: Duration,

    pub web_dist_dir: Option<PathBuf>,
    pub plugins_dir: PathBuf,
    pub kernel_dts_path: Option<PathBuf>,
    pub disable_plugins: bool,

    pub plugin_staging_dir: PathBuf,
    pub plugin_inbox_dir: Option<PathBuf>,
    pub plugin_config_key: Option<SessionSecret>,
    pub plugin_call_timeout: Duration,
    pub plugin_cron_timeout: Duration,
    pub plugin_memory_bytes: u64,
    pub plugin_max_instances: usize,
    pub plugin_breaker_threshold: u32,
    pub plugin_http_timeout: Duration,
    pub plugin_http_max_response_bytes: u64,
    pub plugin_http_allow_cidrs: Vec<ipnet::IpNet>,
    pub plugin_enable_cron: bool,
}

#[derive(Clone)]
pub struct SessionSecret(Vec<u8>);

impl SessionSecret {
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
    pub fn attachment_limit(&self) -> Option<u64> {
        (self.max_attachment_bytes > 0).then_some(self.max_attachment_bytes)
    }

    pub fn from_env() -> Result<Config, ConfigError> {
        let _ = dotenvy::dotenv();

        let session_secret = SessionSecret::new(required("SESSION_SECRET")?.into_bytes())?;

        let bind_addr: SocketAddr = parse_var(
            "BIND_ADDR",
            DEFAULT_BIND_ADDR
                .parse()
                .expect("DEFAULT_BIND_ADDR is a valid socket address"),
        )?;

        let max_document_bytes =
            parse_var::<usize>("MAX_DOCUMENT_BYTES", ddd_core::limits::MAX_DOCUMENT_BYTES)?
                .min(ddd_core::limits::MAX_DOCUMENT_BYTES);
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
                ddd_plugin_abi::limits::CALL_TIMEOUT_MS,
            )?,
            plugin_cron_timeout: parse_millis(
                "PLUGIN_CRON_TIMEOUT_MS",
                ddd_plugin_abi::limits::CRON_CALL_TIMEOUT_MS,
            )?,
            plugin_memory_bytes: parse_var(
                "PLUGIN_MEMORY_BYTES",
                ddd_plugin_abi::limits::MEMORY_BYTES,
            )?,
            plugin_max_instances: parse_var(
                "PLUGIN_MAX_INSTANCES",
                ddd_plugin_abi::limits::MAX_INSTANCES_PER_PLUGIN,
            )?,
            plugin_breaker_threshold: parse_var(
                "PLUGIN_BREAKER_THRESHOLD",
                ddd_plugin_abi::limits::BREAKER_FAILURE_THRESHOLD,
            )?,
            plugin_http_timeout: parse_millis(
                "PLUGIN_HTTP_TIMEOUT_MS",
                ddd_plugin_abi::limits::HTTP_TIMEOUT_MS,
            )?,
            plugin_http_max_response_bytes: parse_var(
                "PLUGIN_HTTP_MAX_RESPONSE_BYTES",
                ddd_plugin_abi::limits::MAX_HTTP_RESPONSE_BYTES,
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

    pub fn session_cookie_name(&self) -> &'static str {
        "ddd_session"
    }

    pub fn public_ws_origin(&self) -> Option<String> {
        ws_origin(self.public_url.as_deref()?)
    }

    pub fn origin_allowed(&self, origin: &str) -> bool {
        let origin = origin.trim_end_matches('/');
        self.app_origins
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(origin))
    }
}

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

fn default_staging_dir(plugins_dir: &std::path::Path) -> PathBuf {
    let mut name = plugins_dir.as_os_str().to_os_string();
    name.push(".staging");
    PathBuf::from(name)
}

fn parse_config_key(key: &'static str) -> Result<Option<SessionSecret>, ConfigError> {
    let Some(raw) = var(key) else {
        return Ok(None);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }

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

    SessionSecret::new(bytes).map(Some)
}

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

pub fn ws_origin(origin: &str) -> Option<String> {
    match origin.split_once("://") {
        Some(("https", rest)) if !rest.is_empty() => Some(format!("wss://{rest}")),
        Some(("http", rest)) if !rest.is_empty() => Some(format!("ws://{rest}")),
        _ => None,
    }
}

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
            max_document_bytes: ddd_core::limits::MAX_DOCUMENT_BYTES,
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
            plugin_call_timeout: Duration::from_millis(ddd_plugin_abi::limits::CALL_TIMEOUT_MS),
            plugin_cron_timeout: Duration::from_millis(
                ddd_plugin_abi::limits::CRON_CALL_TIMEOUT_MS,
            ),
            plugin_memory_bytes: ddd_plugin_abi::limits::MEMORY_BYTES,
            plugin_max_instances: ddd_plugin_abi::limits::MAX_INSTANCES_PER_PLUGIN,
            plugin_breaker_threshold: ddd_plugin_abi::limits::BREAKER_FAILURE_THRESHOLD,
            plugin_http_timeout: Duration::from_millis(ddd_plugin_abi::limits::HTTP_TIMEOUT_MS),
            plugin_http_max_response_bytes: ddd_plugin_abi::limits::MAX_HTTP_RESPONSE_BYTES,
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
        assert_eq!(
            ws_origin("https://notes.example.com").as_deref(),
            Some("wss://notes.example.com")
        );
        assert_eq!(
            ws_origin("http://192.168.1.10:8080").as_deref(),
            Some("ws://192.168.1.10:8080")
        );
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

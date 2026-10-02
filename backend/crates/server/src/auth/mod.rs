use std::cmp::min;
use std::net::SocketAddr;

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bson::{DateTime as BsonDateTime, doc};
use hmac::{Hmac, KeyInit as _, Mac as _};
use rand::Rng;
use sha2::Sha256;
use thiserror::Error;

use crate::config::SessionSecret;
use crate::domain::{LoginAttempt, Session, SessionKind, User, new_id};
use crate::error::AppError;
use crate::state::AppState;

pub mod audit;
pub mod cli;
pub mod invite;
pub mod password;
pub mod rate_limit;
pub mod reset;

pub use rate_limit::{RateKey, RateLimited, RateLimiter};

pub const TOKEN_BYTES: usize = 32;
pub const BEARER_PREFIX: &str = "Bearer ";

const MILLIS_PER_DAY: i64 = 86_400_000;
const MILLIS_PER_HOUR: i64 = 3_600_000;
const MAX_META_LEN: usize = 256;
const MAX_IP_LEN: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthVia {
    Cookie,
    Bearer,
}

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user: User,
    pub session: Session,
    pub via: AuthVia,
}

impl AuthUser {
    pub fn id(&self) -> &str {
        &self.user.id
    }

    pub fn is_admin(&self) -> bool {
        self.user.is_admin
    }

    pub fn actor(&self) -> crate::domain::Actor {
        crate::domain::Actor::User(self.user.id.clone())
    }
}

#[derive(Debug, Clone)]
pub struct AdminUser(pub AuthUser);

impl AdminUser {
    pub fn actor(&self) -> crate::domain::Actor {
        self.0.actor()
    }
}

#[derive(Debug, Clone)]
pub struct MaybeAuthUser(pub Option<AuthUser>);

#[derive(Debug, Clone, Default)]
pub struct ClientMeta {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let (token, via) = credential_from_parts(parts, state.config.session_cookie_name())
            .ok_or(AppError::Unauthorized)?;

        let session = load_session(state, &token)
            .await?
            .ok_or(AppError::Unauthorized)?;

        let user = state
            .collections
            .users()
            .find_one(doc! { "_id": &session.user_id })
            .await?;

        let Some(user) = user.filter(|u| u.is_active) else {
            revoke_session(state, &session.id).await?;
            return Err(AppError::Unauthorized);
        };

        Ok(AuthUser { user, session, via })
    }
}

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = AuthUser::from_request_parts(parts, state).await?;
        if !user.is_admin() {
            return Err(AppError::Forbidden);
        }
        Ok(AdminUser(user))
    }
}

impl FromRequestParts<AppState> for MaybeAuthUser {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        match AuthUser::from_request_parts(parts, state).await {
            Ok(user) => Ok(MaybeAuthUser(Some(user))),
            Err(AppError::Unauthorized) => Ok(MaybeAuthUser(None)),
            Err(err) => Err(err),
        }
    }
}

impl FromRequestParts<AppState> for ClientMeta {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        Ok(ClientMeta {
            ip: client_ip(parts, state.config.trust_proxy_headers),
            user_agent: parts
                .headers
                .get(axum::http::header::USER_AGENT)
                .and_then(|value| value.to_str().ok())
                .map(|value| truncate_meta(value, MAX_META_LEN)),
        })
    }
}

pub fn credential_from_parts(parts: &Parts, cookie_name: &str) -> Option<(String, AuthVia)> {
    if let Some(header) = parts
        .headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        && let Some((scheme, rest)) = header.split_once(' ')
        && scheme.eq_ignore_ascii_case(BEARER_PREFIX.trim())
    {
        let token = rest.trim();
        if !token.is_empty() {
            return Some((token.to_string(), AuthVia::Bearer));
        }
    }

    if let Some(token) = bearer_from_subprotocols(&parts.headers) {
        return Some((token, AuthVia::Bearer));
    }

    let jar = CookieJar::from_headers(&parts.headers);
    let cookie = jar.get(cookie_name)?;
    let value = cookie.value().trim();
    if value.is_empty() {
        None
    } else {
        Some((value.to_string(), AuthVia::Cookie))
    }
}

pub fn bearer_from_subprotocols(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get_all(axum::http::header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|value| {
            value
                .trim()
                .strip_prefix(crate::routes::sync::BEARER_SUBPROTOCOL_PREFIX)
        })
        .find(|token| !token.is_empty())
        .map(str::to_owned)
}

pub fn client_ip(parts: &Parts, trust_proxy_headers: bool) -> Option<String> {
    if trust_proxy_headers {
        if let Some(value) = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            && let Some(last) = value.rsplit(',').map(str::trim).find(|hop| !hop.is_empty())
        {
            return Some(truncate_meta(last, MAX_IP_LEN));
        }

        if let Some(value) = parts
            .headers
            .get("x-real-ip")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(truncate_meta(value, MAX_IP_LEN));
        }
    }

    parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip().to_string())
}

fn truncate_meta(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let end = (0..=max)
        .rev()
        .find(|i| value.is_char_boundary(*i))
        .unwrap_or(0);
    value[..end].to_string()
}

#[derive(Debug, Clone)]
pub struct IssuedToken {
    pub token: String,
    pub hash: String,
}

pub fn mint_token(secret: &SessionSecret) -> IssuedToken {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let hash = hash_token(secret, &token);
    IssuedToken { token, hash }
}

pub fn hash_token(secret: &SessionSecret, token: &str) -> String {
    let mut mac = <Hmac<Sha256>>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts a key of any length");
    mac.update(token.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn days_from_now(days: u32) -> BsonDateTime {
    offset_now(i64::from(days).saturating_mul(MILLIS_PER_DAY))
}

pub fn hours_from_now(hours: i64) -> BsonDateTime {
    offset_now(hours.saturating_mul(MILLIS_PER_HOUR))
}

fn offset_now(millis: i64) -> BsonDateTime {
    BsonDateTime::from_millis(
        BsonDateTime::now()
            .timestamp_millis()
            .saturating_add(millis),
    )
}

pub fn normalize_email(raw: &str) -> String {
    raw.trim().to_lowercase()
}

pub fn email_looks_valid(email: &str) -> bool {
    if email.is_empty() || email.len() > 320 || email.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains("..")
}

pub async fn create_session(
    state: &AppState,
    user: &User,
    kind: SessionKind,
    user_agent: Option<String>,
    ip: Option<String>,
) -> Result<(Session, String), AppError> {
    let issued = mint_token(&state.config.session_secret);
    let now = BsonDateTime::now();

    let session = Session {
        id: issued.hash,
        user_id: user.id.clone(),
        kind,
        created_at: now,
        last_seen_at: now,
        expires_at: days_from_now(state.config.session_idle_days),
        absolute_expires_at: days_from_now(state.config.session_absolute_days),
        user_agent: user_agent.map(|value| truncate_meta(&value, MAX_META_LEN)),
        ip,
    };

    state.collections.sessions().insert_one(&session).await?;
    Ok((session, issued.token))
}

pub async fn load_session(state: &AppState, token: &str) -> Result<Option<Session>, AppError> {
    let id = hash_token(&state.config.session_secret, token);
    let sessions = state.collections.sessions();

    let Some(mut session) = sessions.find_one(doc! { "_id": &id }).await? else {
        return Ok(None);
    };

    let now = BsonDateTime::now();
    if session.expires_at <= now || session.absolute_expires_at <= now {
        sessions.delete_one(doc! { "_id": &id }).await?;
        return Ok(None);
    }

    let next_expiry = min(
        days_from_now(state.config.session_idle_days),
        session.absolute_expires_at,
    );
    sessions
        .update_one(
            doc! { "_id": &id },
            doc! { "$set": { "last_seen_at": now, "expires_at": next_expiry } },
        )
        .await?;
    session.last_seen_at = now;
    session.expires_at = next_expiry;

    Ok(Some(session))
}

pub async fn revoke_session(state: &AppState, session_id: &str) -> Result<(), AppError> {
    state
        .collections
        .sessions()
        .delete_one(doc! { "_id": session_id })
        .await?;
    crate::routes::sync::close_session_sockets(state, session_id);
    Ok(())
}

pub async fn revoke_user_sessions(state: &AppState, user_id: &str) -> Result<u64, AppError> {
    let result = state
        .collections
        .sessions()
        .delete_many(doc! { "user_id": user_id })
        .await?;
    crate::routes::sync::close_user_sockets(state, user_id);
    Ok(result.deleted_count)
}

pub async fn revoke_user_sessions_except(
    state: &AppState,
    user_id: &str,
    keep_session_id: &str,
) -> Result<u64, AppError> {
    let result = state
        .collections
        .sessions()
        .delete_many(doc! { "user_id": user_id, "_id": { "$ne": keep_session_id } })
        .await?;
    crate::routes::sync::close_user_sockets_except(state, user_id, keep_session_id);
    Ok(result.deleted_count)
}

pub fn build_session_cookie(state: &AppState, token: &str) -> Cookie<'static> {
    Cookie::build((state.config.session_cookie_name(), token.to_string()))
        .http_only(true)
        .secure(state.config.cookie_secure)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time::Duration::days(i64::from(
            state.config.session_idle_days,
        )))
        .build()
}

pub fn clear_session_cookie(state: &AppState) -> Cookie<'static> {
    Cookie::build((state.config.session_cookie_name(), String::new()))
        .http_only(true)
        .secure(state.config.cookie_secure)
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(time::Duration::ZERO)
        .expires(time::OffsetDateTime::UNIX_EPOCH)
        .build()
}

pub async fn record_login_attempt(
    state: &AppState,
    email: &str,
    ip: Option<String>,
    succeeded: bool,
) {
    let attempt = LoginAttempt {
        id: new_id(),
        email: email.to_string(),
        ip,
        succeeded,
        created_at: BsonDateTime::now(),
    };
    if let Err(err) = state
        .collections
        .login_attempts()
        .insert_one(&attempt)
        .await
    {
        tracing::warn!(error = ?err, "failed to record login attempt");
    }
}

pub fn is_duplicate_key(err: &mongodb::error::Error) -> bool {
    use mongodb::error::{ErrorKind, WriteFailure};
    match err.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(write_error)) => write_error.code == 11000,
        ErrorKind::InsertMany(insert) => insert
            .write_errors
            .as_ref()
            .is_some_and(|errors| errors.iter().any(|e| e.code == 11000)),
        _ => false,
    }
}

#[derive(Debug, Error)]
pub enum PasswordError {
    #[error("password must be at least {min} characters")]
    TooShort { min: usize },
    #[error("password hashing failed")]
    Hashing,
    #[error("stored password hash is malformed")]
    MalformedHash,
}

impl From<PasswordError> for AppError {
    fn from(err: PasswordError) -> Self {
        match err {
            PasswordError::TooShort { .. } => AppError::Unprocessable(err.to_string()),
            PasswordError::Hashing | PasswordError::MalformedHash => {
                AppError::Internal(anyhow::anyhow!(err))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(byte: u8) -> SessionSecret {
        SessionSecret::new(vec![byte; 32]).expect("32 bytes is the minimum")
    }

    #[test]
    fn minted_tokens_are_unique_and_self_consistent() {
        let key = secret(b'k');
        let a = mint_token(&key);
        let b = mint_token(&key);
        assert_ne!(a.token, b.token, "two mints must not collide");
        assert_eq!(a.hash, hash_token(&key, &a.token));
        assert_eq!(a.hash.len(), 64, "hmac-sha256 hex is 64 chars");
        assert!(a.hash.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(a.token.len(), 43);
        assert!(!a.token.contains('='));
    }

    #[test]
    fn hash_token_is_stable() {
        assert_eq!(
            hash_token(&secret(b'k'), "abc"),
            "af61b693912efc56e2e46f949719ea10a9e80d68f8dcfb84e26cac5330da3c74"
        );
    }

    #[test]
    fn rotating_the_secret_changes_every_stored_id() {
        let token = "same-token";
        assert_ne!(
            hash_token(&secret(b'k'), token),
            hash_token(&secret(b'z'), token)
        );
    }

    #[test]
    fn bearer_header_beats_a_stale_cookie() {
        use axum::http::Request;

        let request = Request::builder()
            .header(AUTHORIZATION, "Bearer bearer-token")
            .header(axum::http::header::COOKIE, "ddd_session=cookie-token")
            .body(())
            .expect("a valid request");
        let (parts, ()) = request.into_parts();

        assert_eq!(
            credential_from_parts(&parts, "ddd_session"),
            Some(("bearer-token".to_string(), AuthVia::Bearer))
        );
    }

    #[test]
    fn the_cookie_is_used_when_no_bearer_header_is_sent() {
        use axum::http::Request;

        let request = Request::builder()
            .header(axum::http::header::COOKIE, "ddd_session=cookie-token")
            .header(AUTHORIZATION, "Basic dXNlcjpwYXNz")
            .body(())
            .expect("a valid request");
        let (parts, ()) = request.into_parts();

        assert_eq!(
            credential_from_parts(&parts, "ddd_session"),
            Some(("cookie-token".to_string(), AuthVia::Cookie))
        );
    }

    #[test]
    fn forwarding_headers_are_ignored_unless_a_proxy_is_trusted() {
        use axum::http::Request;

        let request = Request::builder()
            .header("x-forwarded-for", "10.9.9.9, 203.0.113.7")
            .header("x-real-ip", "10.8.8.8")
            .body(())
            .expect("a valid request");
        let (mut parts, ()) = request.into_parts();

        assert_eq!(client_ip(&parts, false), None);

        let peer: SocketAddr = "198.51.100.4:51234".parse().expect("a valid address");
        parts.extensions.insert(ConnectInfo(peer));
        assert_eq!(
            client_ip(&parts, false),
            Some("198.51.100.4".to_string()),
            "the socket address is the only honest source without a proxy"
        );

        assert_eq!(client_ip(&parts, true), Some("203.0.113.7".to_string()));
    }

    #[test]
    fn email_normalization_and_validation() {
        assert_eq!(
            normalize_email("  Foo.Bar@Example.COM "),
            "foo.bar@example.com"
        );
        assert!(email_looks_valid("a@b.co"));
        assert!(!email_looks_valid("a@b"));
        assert!(!email_looks_valid("@b.co"));
        assert!(!email_looks_valid("a b@c.co"));
        assert!(!email_looks_valid("a@b..co"));
        assert!(!email_looks_valid(""));
    }

    #[test]
    fn truncate_meta_respects_char_boundaries() {
        assert_eq!(truncate_meta("abc", 8), "abc");
        assert_eq!(truncate_meta("abcdefgh", 4), "abcd");
        assert_eq!(truncate_meta("aé", 2), "a");
    }
}

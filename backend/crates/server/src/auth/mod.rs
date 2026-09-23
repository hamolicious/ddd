//! Authentication: extractors, session lifecycle, argon2 helpers, rate limiting
//! (SPEC §5.2, §5.3).
//!
//! Both credential carriers are supported from M1: an HTTP-only cookie for
//! browsers, and a bearer token for the Flutter shell (local-file origins cannot
//! use cookies).
//!
//! Raw tokens are never stored — the `sessions`/`invites`/`password_resets`
//! `_id` is **HMAC-SHA256(`SESSION_SECRET`, token)**, hex. The secret is in the
//! derivation on purpose: rotating it changes every stored id, which is exactly
//! the "rotation logs everyone out" promise of SPEC §5.2 and
//! `docs/OPERATIONS.md`. With an unkeyed hash, rotation would invalidate nothing.

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

/// Bytes of entropy in a session / invite / reset token.
pub const TOKEN_BYTES: usize = 32;
/// Bearer scheme prefix.
pub const BEARER_PREFIX: &str = "Bearer ";

/// Milliseconds in a day — token/session expiry arithmetic.
const MILLIS_PER_DAY: i64 = 86_400_000;
/// Milliseconds in an hour.
const MILLIS_PER_HOUR: i64 = 3_600_000;
/// Longest stored `user_agent` / `ip` string; keeps unbounded headers out of
/// Mongo and out of the rate-limiter's key space.
const MAX_META_LEN: usize = 256;
/// Longest IP string accepted as a rate-limit key (IPv6 with a zone id fits).
const MAX_IP_LEN: usize = 64;

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/// How the request authenticated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthVia {
    Cookie,
    Bearer,
}

/// An authenticated request. Rejects with 401 when there is no valid session.
///
/// Extracting this also refreshes the session's idle expiry (rolling sessions)
/// and re-checks revocation.
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

    /// The actor to stamp on writes and audit entries.
    pub fn actor(&self) -> crate::domain::Actor {
        crate::domain::Actor::User(self.user.id.clone())
    }
}

/// An authenticated **admin**. Rejects with 401 unauthenticated, 403 otherwise.
#[derive(Debug, Clone)]
pub struct AdminUser(pub AuthUser);

impl AdminUser {
    pub fn actor(&self) -> crate::domain::Actor {
        self.0.actor()
    }
}

/// Authentication when present, `None` when absent — for routes that behave
/// differently for anonymous callers (`register`, `login`).
#[derive(Debug, Clone)]
pub struct MaybeAuthUser(pub Option<AuthUser>);

/// Request metadata every auth route wants: the client IP (rate limiting, audit)
/// and the user agent (session list). Never rejects.
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

        // A deleted or deactivated account keeps its attribution ids but must not
        // authenticate; drop the session so the next request is cheap.
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
            // Absence and invalid credentials are not errors here; a real
            // failure (Mongo down) still propagates.
            Err(AppError::Unauthorized) => Ok(MaybeAuthUser(None)),
            Err(err) => Err(err),
        }
    }
}

impl FromRequestParts<AppState> for ClientMeta {
    // Never rejects; `AppState` is taken only to learn whether forwarding
    // headers may be trusted (`TRUST_PROXY_HEADERS`).
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

/// Pull the raw credential out of a request: `Authorization: Bearer …` first,
/// then the session cookie.
///
/// The header wins deliberately (RFC 7235: credentials the client sent
/// explicitly). A bearer client running where a cookie jar also exists — a
/// webview on an https origin, a script in a browser — would otherwise be
/// authenticated as whatever stale `lm_session` cookie the browser still holds:
/// its valid token never consulted on a revoked cookie, and writes attributed to
/// the cookie's user when both are valid.
pub fn credential_from_parts(parts: &Parts, cookie_name: &str) -> Option<(String, AuthVia)> {
    if let Some(header) = parts.headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok())
        && let Some((scheme, rest)) = header.split_once(' ')
        // The scheme name is case-insensitive (RFC 7235); the token is not.
        && scheme.eq_ignore_ascii_case(BEARER_PREFIX.trim())
    {
        let token = rest.trim();
        if !token.is_empty() {
            return Some((token.to_string(), AuthVia::Bearer));
        }
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

/// Client IP for rate limiting (SPEC §5.2) and audit entries (SPEC §5.4).
///
/// `trust_proxy_headers` decides where it may come from, and the default is
/// `false`:
///
/// - **`false`** — the peer address of the connection, and nothing else.
///   Forwarding headers are ignored because in the Compose deployment of SPEC §8
///   the server is published directly, so `X-Forwarded-For` is whatever the
///   attacker typed. This requires the listener to be served with
///   `into_make_service_with_connect_info::<SocketAddr>()` (see `main.rs`);
///   without it there is no IP at all and every IP-keyed control silently
///   becomes a no-op.
/// - **`true`** — the **rightmost** `X-Forwarded-For` hop. Both nginx-ingress
///   (`$proxy_add_x_forwarded_for`) and Caddy's `reverse_proxy` *append* the real
///   peer to whatever the client sent, so the last hop is the one the trusted
///   proxy wrote and every hop left of it is client-authored fiction. Taking the
///   first hop would let one host mint a fresh rate-limit bucket per request and
///   stamp forged origins onto the audit log.
pub fn client_ip(parts: &Parts, trust_proxy_headers: bool) -> Option<String> {
    if trust_proxy_headers {
        if let Some(value) = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            // `rsplit`: the rightmost hop is the one the trusted proxy appended.
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

    // Present only when the listener is served with
    // `into_make_service_with_connect_info::<SocketAddr>()`.
    parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip().to_string())
}

/// Truncate at a char boundary so a hostile header cannot bloat a document or a
/// rate-limit key.
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

// ---------------------------------------------------------------------------
// Tokens & sessions
// ---------------------------------------------------------------------------

/// A freshly minted token: the secret to hand out once, and the hash to store.
#[derive(Debug, Clone)]
pub struct IssuedToken {
    /// URL-safe, unpadded base64 of [`TOKEN_BYTES`] random bytes.
    pub token: String,
    /// Lowercase hex HMAC-SHA256 of `token` under `SESSION_SECRET` — the stored
    /// `_id`.
    pub hash: String,
}

/// Mint a new token, keyed for storage by `secret`.
pub fn mint_token(secret: &SessionSecret) -> IssuedToken {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    let hash = hash_token(secret, &token);
    IssuedToken { token, hash }
}

/// Derive the stored id of a presented token: HMAC-SHA256(`SESSION_SECRET`,
/// token), lowercase hex.
///
/// Keyed, not a bare digest, for one operational reason: `SESSION_SECRET`
/// rotation is the documented incident response for a suspected credential
/// compromise, and it only revokes anything if the stored ids depend on the
/// secret. Change the secret and every `sessions`, `invites` and
/// `password_resets` row stops matching the token it was created for.
///
/// Constant-time comparison is unnecessary: the result is the primary key, and
/// the lookup reveals nothing an attacker can steer.
pub fn hash_token(secret: &SessionSecret, token: &str) -> String {
    let mut mac = <Hmac<Sha256>>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts a key of any length");
    mac.update(token.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// `now + days`, as a bson timestamp.
pub fn days_from_now(days: u32) -> BsonDateTime {
    offset_now(i64::from(days).saturating_mul(MILLIS_PER_DAY))
}

/// `now + hours`, as a bson timestamp.
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

/// Lowercase + trim an email for storage and lookup. The `users.email` unique
/// index is what actually enforces uniqueness.
pub fn normalize_email(raw: &str) -> String {
    raw.trim().to_lowercase()
}

/// Cheap sanity check — not an RFC 5322 validator. Rejects the shapes that would
/// certainly never receive mail.
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

/// Create a session for `user`, returning the session row and the raw token.
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

/// Load a session by raw token, enforcing idle and absolute expiry, and refresh
/// `last_seen_at`/`expires_at` (rolling sessions, SPEC §5.2).
pub async fn load_session(state: &AppState, token: &str) -> Result<Option<Session>, AppError> {
    let id = hash_token(&state.config.session_secret, token);
    let sessions = state.collections.sessions();

    let Some(mut session) = sessions.find_one(doc! { "_id": &id }).await? else {
        return Ok(None);
    };

    let now = BsonDateTime::now();
    if session.expires_at <= now || session.absolute_expires_at <= now {
        // Expired: drop the row rather than leaving it for the TTL index.
        sessions.delete_one(doc! { "_id": &id }).await?;
        return Ok(None);
    }

    // Rolling idle window, never extended past the absolute expiry.
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

/// Revoke one session (logout).
pub async fn revoke_session(state: &AppState, session_id: &str) -> Result<(), AppError> {
    state
        .collections
        .sessions()
        .delete_one(doc! { "_id": session_id })
        .await?;
    Ok(())
}

/// Revoke every session of a user (password change, user deletion, demotion).
pub async fn revoke_user_sessions(state: &AppState, user_id: &str) -> Result<u64, AppError> {
    let result = state
        .collections
        .sessions()
        .delete_many(doc! { "user_id": user_id })
        .await?;
    Ok(result.deleted_count)
}

/// Revoke every session of a user except one — a password change keeps the
/// caller signed in and logs every other device out (SPEC §5.1).
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
    Ok(result.deleted_count)
}

/// Build the session cookie: HTTP-only, `Secure` (per config), `SameSite=Lax`,
/// path `/`, max-age = idle window.
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

/// Build the cookie that clears the session.
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

/// Write a login attempt to `login_attempts` (SPEC §5.2: "attempts logged").
/// Never fails the request — the attempt log is an audit trail, not a gate.
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

/// `true` when a Mongo write failed on a unique-index violation.
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

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

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
        // 32 random bytes -> 43 base64url chars, unpadded.
        assert_eq!(a.token.len(), 43);
        assert!(!a.token.contains('='));
    }

    #[test]
    fn hash_token_is_stable() {
        // Known HMAC-SHA256 of "abc" under 32 'k' bytes, so a dependency swap
        // cannot silently change the stored id derivation and log everyone out.
        assert_eq!(
            hash_token(&secret(b'k'), "abc"),
            "af61b693912efc56e2e46f949719ea10a9e80d68f8dcfb84e26cac5330da3c74"
        );
    }

    #[test]
    fn rotating_the_secret_changes_every_stored_id() {
        // This is the whole point of keying the derivation: rotation is the
        // documented response to a stolen cookie or bearer token, and it only
        // revokes anything if the stored `sessions._id` moves with the secret.
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
            .header(axum::http::header::COOKIE, "lm_session=cookie-token")
            .body(())
            .expect("a valid request");
        let (parts, ()) = request.into_parts();

        assert_eq!(
            credential_from_parts(&parts, "lm_session"),
            Some(("bearer-token".to_string(), AuthVia::Bearer))
        );
    }

    #[test]
    fn the_cookie_is_used_when_no_bearer_header_is_sent() {
        use axum::http::Request;

        let request = Request::builder()
            .header(axum::http::header::COOKIE, "lm_session=cookie-token")
            // A non-bearer scheme must not shadow the cookie either.
            .header(AUTHORIZATION, "Basic dXNlcjpwYXNz")
            .body(())
            .expect("a valid request");
        let (parts, ()) = request.into_parts();

        assert_eq!(
            credential_from_parts(&parts, "lm_session"),
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

        // No proxy: nothing the client wrote is believed, and with no
        // `ConnectInfo` there is simply no IP.
        assert_eq!(client_ip(&parts, false), None);

        let peer: SocketAddr = "198.51.100.4:51234".parse().expect("a valid address");
        parts.extensions.insert(ConnectInfo(peer));
        assert_eq!(
            client_ip(&parts, false),
            Some("198.51.100.4".to_string()),
            "the socket address is the only honest source without a proxy"
        );

        // Behind one trusted proxy the rightmost hop is the one it appended;
        // `10.9.9.9` is the client's own fiction.
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
        // 'é' is two bytes: truncating at 3 bytes must not split it.
        assert_eq!(truncate_meta("aé", 2), "a");
    }
}

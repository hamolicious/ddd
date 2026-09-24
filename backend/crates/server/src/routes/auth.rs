//! `/api/auth/*` — registration, login (cookie **and** bearer), logout, me,
//! password change, password reset redemption (SPEC §5.1, §5.2).
//!
//! First user registers as admin; everyone after needs an invite token.

use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bson::{DateTime as BsonDateTime, doc};
use serde::{Deserialize, Serialize};

use crate::auth::{
    self, AuthUser, ClientMeta, MaybeAuthUser, RateKey, audit, invite, password, reset,
};
use crate::domain::{self, Actor, Invite, Session, SessionKind, User, UserView, new_id};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/register", post(register))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me))
        .route("/password", post(change_password))
        .route("/password/reset", post(redeem_reset))
        .route("/bootstrap", get(bootstrap_state))
}

// ---------------------------------------------------------------------------
// Request / response bodies
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub name: Option<String>,
    /// Required unless this is the very first user (who becomes admin).
    #[serde(default)]
    pub invite: Option<String>,
    /// `true` from the Flutter shell: respond with a bearer token instead of
    /// setting a cookie (SPEC §5.2).
    #[serde(default, alias = "token")]
    pub bearer: bool,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    #[serde(default, alias = "token")]
    pub bearer: bool,
}

/// Login/registration response. `token` is present only for bearer clients and
/// is shown exactly once.
#[derive(Debug, Serialize)]
pub struct SessionResponse {
    pub user: UserView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    pub expires_at: domain::Timestamp,
}

#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Deserialize)]
pub struct RedeemResetRequest {
    pub token: String,
    pub new_password: String,
}

/// What an unauthenticated client needs to render the right first screen: is
/// there any user yet (→ show "create the first account"), is an invite required.
#[derive(Debug, Serialize)]
pub struct BootstrapState {
    pub needs_first_user: bool,
    pub invite_required: bool,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `POST /api/auth/register` — first user becomes admin; otherwise a valid,
/// unused, unexpired invite token is required (single-use, SPEC §5.1).
pub async fn register(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(body): Json<RegisterRequest>,
) -> AppResult<Response> {
    // Registration is an unauthenticated write: rate-limit it even though the
    // invite check already gates it.
    let ip_bucket = meta.ip.clone().map(|key| RateKey::Named {
        bucket: "register",
        key,
    });
    if let Some(bucket) = &ip_bucket {
        state.login_limiter.check(bucket)?;
    }

    let email = auth::normalize_email(&body.email);
    if !auth::email_looks_valid(&email) {
        return Err(AppError::bad_request("email is not a valid address"));
    }
    if body.password.chars().count() > password::MAX_LENGTH {
        return Err(AppError::bad_request(format!(
            "password must be at most {} characters",
            password::MAX_LENGTH
        )));
    }
    password::validate(&body.password)?;

    let users = state.collections.users();

    // The very first account bootstraps the workspace and is the only admin that
    // no other admin created. Two clients racing here would both become admin —
    // harmless, because the *first* registration is open to anyone by design;
    // once one user exists, the invite branch below closes the door.
    let is_first_user = users.count_documents(doc! {}).await? == 0;

    let claimed: Option<Invite> = if is_first_user {
        None
    } else {
        let token = body
            .invite
            .as_deref()
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| AppError::unprocessable("an invite token is required"))?;
        // Claimed *before* the user row exists, so one token can never produce
        // two accounts. Released again if the insert below fails.
        Some(invite::claim(&state, token, &email).await?)
    };

    let now = BsonDateTime::now();
    let user = User {
        id: new_id(),
        name: display_name(body.name.as_deref(), &email),
        email: email.clone(),
        password_hash: password::hash(&body.password)?,
        // An invite always grants a plain account (SPEC §5.1).
        is_admin: is_first_user,
        is_active: true,
        created_at: now,
        updated_at: now,
        last_login_at: None,
        invited_by: claimed.as_ref().map(|invite| invite.created_by.clone()),
    };

    if let Err(err) = users.insert_one(&user).await {
        if let Some(invite) = &claimed {
            invite::release(&state, &invite.id).await;
        }
        if auth::is_duplicate_key(&err) {
            if let Some(bucket) = &ip_bucket {
                state.login_limiter.record_failure(bucket);
            }
            return Err(AppError::conflict(
                "an account with that email already exists",
            ));
        }
        return Err(err.into());
    }

    if let Some(invite) = &claimed {
        invite::mark_used_by(&state, &invite.id, &user.id).await?;
    }
    if let Some(bucket) = &ip_bucket {
        state.login_limiter.record_success(bucket);
    }

    let actor = Actor::User(user.id.clone());
    audit::record(
        &state,
        "user.register",
        Some(&actor),
        audit::TARGET_USER,
        Some(user.id.clone()),
        doc! {
            "email": &user.email,
            "is_admin": user.is_admin,
            "first_user": is_first_user,
            "invite": claimed.as_ref().map(|invite| invite.id.clone()),
        },
        meta.ip.clone(),
    )
    .await;

    issue_session(&state, user, body.bearer, meta).await
}

/// `POST /api/auth/login` — per-IP and per-account backoff on failure; attempts
/// logged (SPEC §5.2). Returns a cookie, or a bearer token when `bearer: true`.
pub async fn login(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(body): Json<LoginRequest>,
) -> AppResult<Response> {
    let email = auth::normalize_email(&body.email);
    let account_key = RateKey::Account(email.clone());
    let ip_key = meta.ip.clone().map(RateKey::Ip);

    // Both backoffs are checked before any work: per-account stops credential
    // stuffing from a botnet, per-IP stops one host spraying many accounts.
    if let Some(key) = &ip_key {
        state.login_limiter.check(key)?;
    }
    state.login_limiter.check(&account_key)?;

    let candidate = state
        .collections
        .users()
        .find_one(doc! { "email": &email })
        .await?;

    let authenticated = match candidate.as_ref() {
        Some(user) if user.is_active => password::verify(&body.password, &user.password_hash)?,
        // Equalize timing: an unknown or deactivated address must not answer
        // faster than a wrong password.
        _ => {
            password::verify_dummy(&body.password);
            false
        }
    };

    auth::record_login_attempt(&state, &email, meta.ip.clone(), authenticated).await;

    let Some(user) = candidate.filter(|_| authenticated) else {
        if let Some(key) = &ip_key {
            state.login_limiter.record_failure(key);
        }
        state.login_limiter.record_failure(&account_key);
        tracing::warn!(%email, ip = ?meta.ip, "failed login");
        return Err(AppError::Unauthorized);
    };

    if let Some(key) = &ip_key {
        state.login_limiter.record_success(key);
    }
    state.login_limiter.record_success(&account_key);

    let now = BsonDateTime::now();
    state
        .collections
        .users()
        .update_one(
            doc! { "_id": &user.id },
            doc! { "$set": { "last_login_at": now } },
        )
        .await?;

    issue_session(&state, user, body.bearer, meta).await
}

/// `POST /api/auth/logout` — revokes this session and clears the cookie.
pub async fn logout(State(state): State<AppState>, user: AuthUser) -> AppResult<Response> {
    auth::revoke_session(&state, &user.session.id).await?;

    let mut response = StatusCode::NO_CONTENT.into_response();
    // Always clear the cookie, even for a bearer session: a stale cookie on the
    // same browser would otherwise outlive the logout the user asked for.
    set_cookie(&mut response, &auth::clear_session_cookie(&state))?;
    Ok(response)
}

/// `GET /api/auth/me`
pub async fn me(user: AuthUser) -> AppResult<Json<UserView>> {
    Ok(Json(UserView::from(user.user)))
}

/// `POST /api/auth/password` — change password; requires the current one and
/// revokes every other session (SPEC §5.1).
pub async fn change_password(
    State(state): State<AppState>,
    user: AuthUser,
    meta: ClientMeta,
    Json(body): Json<ChangePasswordRequest>,
) -> AppResult<Response> {
    let bucket = RateKey::Named {
        bucket: "password_change",
        key: user.id().to_string(),
    };
    state.login_limiter.check(&bucket)?;

    if !password::verify(&body.current_password, &user.user.password_hash)? {
        state.login_limiter.record_failure(&bucket);
        tracing::warn!(user = %user.id(), "password change with a wrong current password");
        // Deliberately **not** 401. The session is valid — only the typed-in
        // current password is wrong — and a 401 here is indistinguishable from an
        // expired session, so a client would log the user out over a typo
        // (SPEC §5.3: a 401 means "re-authenticate"). 422 matches how the rest of
        // this module reports a well-formed request whose content is unusable.
        return Err(AppError::unprocessable("current password is incorrect"));
    }
    state.login_limiter.record_success(&bucket);

    if body.new_password.chars().count() > password::MAX_LENGTH {
        return Err(AppError::bad_request(format!(
            "password must be at most {} characters",
            password::MAX_LENGTH
        )));
    }

    reset::apply_new_password(&state, &user.user.id, &body.new_password).await?;

    // Every other device is logged out; this one stays signed in.
    let revoked =
        auth::revoke_user_sessions_except(&state, &user.user.id, &user.session.id).await?;

    let actor = user.actor();
    audit::record(
        &state,
        "user.password_change",
        Some(&actor),
        audit::TARGET_USER,
        Some(user.user.id.clone()),
        doc! { "sessions_revoked": i64::try_from(revoked).unwrap_or(i64::MAX) },
        meta.ip,
    )
    .await;

    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `POST /api/auth/password/reset` — redeem a one-time reset token issued by an
/// admin or the `reset-password` CLI.
pub async fn redeem_reset(
    State(state): State<AppState>,
    meta: ClientMeta,
    Json(body): Json<RedeemResetRequest>,
) -> AppResult<Response> {
    let ip_bucket = meta.ip.clone().map(|key| RateKey::Named {
        bucket: "password_reset",
        key,
    });
    if let Some(bucket) = &ip_bucket {
        state.login_limiter.check(bucket)?;
    }

    if body.new_password.chars().count() > password::MAX_LENGTH {
        return Err(AppError::bad_request(format!(
            "password must be at most {} characters",
            password::MAX_LENGTH
        )));
    }
    // Validated before the token is spent: a rejected password must not burn a
    // single-use credential.
    password::validate(&body.new_password)?;

    let token = body.token.trim();
    if token.is_empty() {
        return Err(AppError::bad_request("token is required"));
    }

    let consumed = match reset::consume(&state, token).await {
        Ok(consumed) => consumed,
        Err(err) => {
            if let Some(bucket) = &ip_bucket {
                state.login_limiter.record_failure(bucket);
            }
            return Err(err);
        }
    };
    if let Some(bucket) = &ip_bucket {
        state.login_limiter.record_success(bucket);
    }

    reset::apply_new_password(&state, &consumed.user_id, &body.new_password).await?;

    // A reset is a recovery from "someone may hold my credentials": every
    // session goes, including any the attacker holds.
    let revoked = auth::revoke_user_sessions(&state, &consumed.user_id).await?;

    let actor = Actor::User(consumed.user_id.clone());
    audit::record(
        &state,
        "user.password_reset_redeem",
        Some(&actor),
        audit::TARGET_USER,
        Some(consumed.user_id.clone()),
        doc! {
            "sessions_revoked": i64::try_from(revoked).unwrap_or(i64::MAX),
            "issued_by": consumed.created_by.clone(),
        },
        meta.ip,
    )
    .await;

    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `GET /api/auth/bootstrap` — unauthenticated; tells the client which first
/// screen to show.
pub async fn bootstrap_state(
    State(state): State<AppState>,
    _caller: MaybeAuthUser,
) -> AppResult<Json<BootstrapState>> {
    let needs_first_user = state.collections.users().count_documents(doc! {}).await? == 0;
    Ok(Json(BootstrapState {
        needs_first_user,
        invite_required: !needs_first_user,
    }))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Create the session and shape the response for the carrier the client asked
/// for: a bearer token in the body, or an HTTP-only cookie (SPEC §5.2).
async fn issue_session(
    state: &AppState,
    user: User,
    bearer: bool,
    meta: ClientMeta,
) -> AppResult<Response> {
    let kind = if bearer {
        SessionKind::Bearer
    } else {
        SessionKind::Cookie
    };
    let (session, token) =
        auth::create_session(state, &user, kind, meta.user_agent, meta.ip).await?;

    session_response(state, user, &session, token, bearer)
}

fn session_response(
    state: &AppState,
    user: User,
    session: &Session,
    token: String,
    bearer: bool,
) -> AppResult<Response> {
    let body = SessionResponse {
        user: UserView::from(user),
        // The raw token exists in exactly one response, and only for the shell.
        token: if bearer { Some(token.clone()) } else { None },
        expires_at: session.expires_at.into(),
    };

    let mut response = Json(body).into_response();
    if !bearer {
        set_cookie(&mut response, &auth::build_session_cookie(state, &token))?;
    }
    Ok(response)
}

fn set_cookie(
    response: &mut Response,
    cookie: &axum_extra::extract::cookie::Cookie<'_>,
) -> AppResult<()> {
    let value = HeaderValue::from_str(&cookie.to_string())
        .map_err(|err| AppError::Internal(anyhow::anyhow!("invalid Set-Cookie value: {err}")))?;
    response.headers_mut().append(header::SET_COOKIE, value);
    Ok(())
}

/// Display name: what the client sent, else the email local part (SPEC §3.5
/// "defaults to the email local part").
fn display_name(requested: Option<&str>, email: &str) -> String {
    let trimmed = requested.map(str::trim).filter(|name| !name.is_empty());
    match trimmed {
        Some(name) => name.chars().take(120).collect(),
        None => email.split('@').next().unwrap_or(email).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_falls_back_to_the_email_local_part() {
        assert_eq!(display_name(Some("Ada"), "ada@example.com"), "Ada");
        assert_eq!(display_name(Some("  "), "ada@example.com"), "ada");
        assert_eq!(display_name(None, "ada@example.com"), "ada");
        assert_eq!(display_name(None, "not-an-email"), "not-an-email");
    }

    #[test]
    fn display_name_is_bounded() {
        let long = "x".repeat(500);
        assert_eq!(display_name(Some(&long), "a@b.co").chars().count(), 120);
    }

    #[test]
    fn bearer_is_requested_by_either_field_name() {
        // The spec calls the flag `token: true`; the scaffold named it `bearer`.
        // Both are accepted so neither client is wrong.
        let by_bearer: LoginRequest =
            serde_json::from_str(r#"{"email":"a@b.co","password":"x","bearer":true}"#).unwrap();
        let by_token: LoginRequest =
            serde_json::from_str(r#"{"email":"a@b.co","password":"x","token":true}"#).unwrap();
        let neither: LoginRequest =
            serde_json::from_str(r#"{"email":"a@b.co","password":"x"}"#).unwrap();

        assert!(by_bearer.bearer);
        assert!(by_token.bearer);
        assert!(!neither.bearer, "cookie is the default carrier");
    }

    #[test]
    fn register_accepts_an_optional_invite_and_name() {
        let body: RegisterRequest =
            serde_json::from_str(r#"{"email":"a@b.co","password":"0123456789"}"#).unwrap();
        assert!(body.invite.is_none());
        assert!(body.name.is_none());
        assert!(!body.bearer);
    }
}

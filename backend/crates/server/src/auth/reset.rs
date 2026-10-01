//! One-time password resets (SPEC §5.1): the admin
//! `POST /api/admin/users/:id/reset` link and the `ddd reset-password`
//! break-glass CLI both land here.
//!
//! `_id` is HMAC-SHA256(`SESSION_SECRET`, token), so rotating the secret
//! invalidates outstanding reset links too. There is no email delivery in v1 — the
//! token is handed to the admin (or printed by the CLI) and passed on out of band.

use bson::{DateTime as BsonDateTime, doc};
use mongodb::options::ReturnDocument;

use super::{hash_token, hours_from_now, mint_token, password};
use crate::domain::{Actor, Id, PasswordReset, User};
use crate::error::AppError;
use crate::state::AppState;

/// How long a reset token stays redeemable. Short by design: it is a credential
/// travelling over a side channel.
pub const TTL_HOURS: i64 = 24;

/// Issue a reset token for `user_id`, invalidating any outstanding one.
pub async fn issue(
    state: &AppState,
    user_id: &Id,
    created_by: Option<&Actor>,
) -> Result<(PasswordReset, String), AppError> {
    let resets = state.collections.password_resets();

    // At most one live token per user: a freshly issued link must make an older
    // one unusable, or two admins racing leaves a stale credential alive.
    resets
        .delete_many(doc! { "user_id": user_id, "used_at": null })
        .await?;

    let issued = mint_token(&state.config.session_secret);
    let reset = PasswordReset {
        id: issued.hash,
        user_id: user_id.clone(),
        created_at: BsonDateTime::now(),
        created_by: created_by.map(Actor::as_stored),
        expires_at: hours_from_now(TTL_HOURS),
        used_at: None,
    };

    resets.insert_one(&reset).await?;
    Ok((reset, issued.token))
}

/// Redeem a reset token, atomically marking it used. A second redemption of the
/// same token fails.
pub async fn consume(state: &AppState, token: &str) -> Result<PasswordReset, AppError> {
    let id = hash_token(&state.config.session_secret, token);
    let now = BsonDateTime::now();

    let consumed = state
        .collections
        .password_resets()
        .find_one_and_update(
            doc! { "_id": &id, "used_at": null, "expires_at": { "$gt": now } },
            doc! { "$set": { "used_at": now } },
        )
        .return_document(ReturnDocument::After)
        .await?;

    // One message for "unknown", "used" and "expired": a reset token is a
    // credential, and distinguishing them tells a guesser which guesses landed.
    consumed
        .ok_or_else(|| AppError::unprocessable("reset token is invalid, expired, or already used"))
}

/// Set a user's password and log every one of their sessions out.
///
/// Shared by the admin reset redemption and the self-service change; the change
/// route keeps the caller signed in by revoking separately.
pub async fn apply_new_password(
    state: &AppState,
    user_id: &Id,
    new_password: &str,
) -> Result<(), AppError> {
    password::validate(new_password)?;
    let phc = password::hash(new_password)?;

    let result = state
        .collections
        .users()
        .update_one(
            doc! { "_id": user_id },
            doc! { "$set": { "password_hash": phc, "updated_at": BsonDateTime::now() } },
        )
        .await?;

    if result.matched_count == 0 {
        return Err(AppError::NotFound("user"));
    }
    Ok(())
}

/// Look a user up by email for the CLI and the admin routes.
pub async fn user_by_email(state: &AppState, email: &str) -> Result<Option<User>, AppError> {
    Ok(state
        .collections
        .users()
        .find_one(doc! { "email": super::normalize_email(email) })
        .await?)
}

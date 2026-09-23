//! Invite tokens (SPEC §5.1): 7-day expiry, single-use, listable, revocable,
//! **always non-admin** — an invite grants a plain account and nothing else, so
//! the admin flag can only ever be set by an existing admin.
//!
//! `_id` is HMAC-SHA256(`SESSION_SECRET`, token); the raw token is shown exactly
//! once, at creation. Rotating the secret therefore also invalidates every
//! outstanding invite.

use bson::{DateTime as BsonDateTime, doc};
use mongodb::options::ReturnDocument;

use super::{days_from_now, hash_token, mint_token};
use crate::domain::{Id, Invite};
use crate::error::AppError;
use crate::state::AppState;

/// Derived invite lifecycle state, in precedence order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Pending,
    Used,
    Revoked,
    Expired,
}

impl Status {
    /// The wire string (`InviteView::status`).
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Used => "used",
            Status::Revoked => "revoked",
            Status::Expired => "expired",
        }
    }
}

/// Classify an invite. Revoked beats used beats expired — the strongest reason it
/// cannot be redeemed.
pub fn status(invite: &Invite, now: BsonDateTime) -> Status {
    if invite.revoked_at.is_some() {
        Status::Revoked
    } else if invite.used_at.is_some() {
        Status::Used
    } else if invite.expires_at <= now {
        Status::Expired
    } else {
        Status::Pending
    }
}

/// Create an invite, returning the row and the raw token (shown once).
pub async fn create(
    state: &AppState,
    created_by: &Id,
    email: Option<String>,
) -> Result<(Invite, String), AppError> {
    let issued = mint_token(&state.config.session_secret);
    let invite = Invite {
        id: issued.hash,
        email: email.map(|value| super::normalize_email(&value)),
        created_at: BsonDateTime::now(),
        created_by: created_by.clone(),
        expires_at: days_from_now(state.config.invite_ttl_days),
        used_at: None,
        used_by: None,
        revoked_at: None,
    };

    state.collections.invites().insert_one(&invite).await?;
    Ok((invite, issued.token))
}

/// Most invites a single listing returns. Invites are never deleted (they stay
/// listable and auditable), so an unbounded list would grow forever.
pub const LIST_LIMIT: i64 = 500;

/// The newest invites, newest first, capped at [`LIST_LIMIT`].
pub async fn list(state: &AppState) -> Result<Vec<Invite>, AppError> {
    use futures::TryStreamExt;

    let cursor = state
        .collections
        .invites()
        .find(doc! {})
        .sort(doc! { "created_at": -1 })
        .limit(LIST_LIMIT)
        .await?;
    Ok(cursor.try_collect().await?)
}

/// Revoke a pending invite. Already-revoked is idempotent; already-used is a
/// domain error (there is nothing left to revoke).
pub async fn revoke(state: &AppState, id: &str) -> Result<Invite, AppError> {
    let invites = state.collections.invites();
    let existing = invites
        .find_one(doc! { "_id": id })
        .await?
        .ok_or(AppError::NotFound("invite"))?;

    if existing.used_at.is_some() {
        return Err(AppError::unprocessable(
            "invite has already been used and cannot be revoked",
        ));
    }
    if existing.revoked_at.is_some() {
        return Ok(existing);
    }

    let revoked = invites
        .find_one_and_update(
            doc! { "_id": id, "used_at": null, "revoked_at": null },
            doc! { "$set": { "revoked_at": BsonDateTime::now() } },
        )
        .return_document(ReturnDocument::After)
        .await?;

    // Lost a race with a redemption between the read and the update.
    revoked.ok_or_else(|| {
        AppError::unprocessable("invite has already been used and cannot be revoked")
    })
}

/// Atomically claim an invite for a registration, before the user row exists.
///
/// Single-use is enforced by the conditional update, not by the read: two
/// concurrent registrations with one token leave exactly one winner. Call
/// [`mark_used_by`] once the user id is known, or [`release`] if the
/// registration then fails.
pub async fn claim(state: &AppState, token: &str, email: &str) -> Result<Invite, AppError> {
    let id = hash_token(&state.config.session_secret, token);
    let invites = state.collections.invites();
    let now = BsonDateTime::now();

    // Read first, purely so the caller gets a precise reason.
    let existing = invites
        .find_one(doc! { "_id": &id })
        .await?
        .ok_or_else(|| AppError::unprocessable("invite token is not valid"))?;

    match status(&existing, now) {
        Status::Revoked => return Err(AppError::unprocessable("invite has been revoked")),
        Status::Used => return Err(AppError::unprocessable("invite has already been used")),
        Status::Expired => return Err(AppError::unprocessable("invite has expired")),
        Status::Pending => {}
    }

    if let Some(expected) = existing.email.as_deref()
        && !expected.eq_ignore_ascii_case(email)
    {
        return Err(AppError::unprocessable(
            "invite was issued for a different email address",
        ));
    }

    let claimed = invites
        .find_one_and_update(
            doc! {
                "_id": &id,
                "used_at": null,
                "revoked_at": null,
                "expires_at": { "$gt": now },
            },
            doc! { "$set": { "used_at": now } },
        )
        .return_document(ReturnDocument::After)
        .await?;

    claimed.ok_or_else(|| AppError::unprocessable("invite has already been used"))
}

/// Attribute a claimed invite to the user that redeemed it.
pub async fn mark_used_by(state: &AppState, id: &str, user_id: &Id) -> Result<(), AppError> {
    state
        .collections
        .invites()
        .update_one(doc! { "_id": id }, doc! { "$set": { "used_by": user_id } })
        .await?;
    Ok(())
}

/// Undo a [`claim`] whose registration failed, so a valid token is not burned by
/// a duplicate-email attempt.
pub async fn release(state: &AppState, id: &str) {
    let result = state
        .collections
        .invites()
        .update_one(
            doc! { "_id": id, "used_by": null },
            doc! { "$unset": { "used_at": "" } },
        )
        .await;
    if let Err(err) = result {
        tracing::warn!(error = ?err, invite = %id, "failed to release claimed invite");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invite(expires_at: BsonDateTime) -> Invite {
        Invite {
            id: "hash".to_string(),
            email: None,
            created_at: BsonDateTime::from_millis(0),
            created_by: "admin".to_string(),
            expires_at,
            used_at: None,
            used_by: None,
            revoked_at: None,
        }
    }

    #[test]
    fn status_precedence() {
        let now = BsonDateTime::from_millis(1_000);
        let future = BsonDateTime::from_millis(2_000);
        let past = BsonDateTime::from_millis(500);

        assert_eq!(status(&invite(future), now), Status::Pending);
        assert_eq!(status(&invite(past), now), Status::Expired);

        let mut used = invite(future);
        used.used_at = Some(now);
        assert_eq!(status(&used, now), Status::Used);

        let mut revoked = used.clone();
        revoked.revoked_at = Some(now);
        assert_eq!(status(&revoked, now), Status::Revoked, "revoked beats used");

        // An expired invite that was used still reads as used.
        let mut used_and_expired = invite(past);
        used_and_expired.used_at = Some(now);
        assert_eq!(status(&used_and_expired, now), Status::Used);
    }

    #[test]
    fn expiry_boundary_is_exclusive() {
        let now = BsonDateTime::from_millis(1_000);
        assert_eq!(
            status(&invite(now), now),
            Status::Expired,
            "an invite expiring exactly now is expired"
        );
    }

    #[test]
    fn status_strings_are_the_documented_set() {
        assert_eq!(Status::Pending.as_str(), "pending");
        assert_eq!(Status::Used.as_str(), "used");
        assert_eq!(Status::Revoked.as_str(), "revoked");
        assert_eq!(Status::Expired.as_str(), "expired");
    }
}

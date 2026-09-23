//! `/api/admin/*` — admin-only (SPEC §5.1, §5.4). Every handler takes
//! [`AdminUser`], so a non-admin gets 403 and an anonymous caller 401.
//!
//! Invariants enforced here, not in the client:
//! - invites: 7-day expiry, single-use, listable, revocable, **non-admin only**;
//! - the last admin can be neither deleted nor demoted;
//! - deleting a user revokes their sessions and keeps attribution ids (rendered
//!   "deleted user");
//! - every action in this file writes an [`crate::domain::AuditEntry`].

use std::io::{self, Write};

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use bson::{DateTime as BsonDateTime, doc};
use bytes::Bytes;
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::auth::{AdminUser, ClientMeta, audit, invite, reset};
use crate::db;
use crate::domain::{AuditEntry, Id, User, UserView};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Page size for the audit log when the client does not ask.
const AUDIT_DEFAULT_LIMIT: u32 = 50;
/// Hard ceiling on an audit page.
const AUDIT_MAX_LIMIT: u32 = 200;
/// Chunk size the export streams in.
const EXPORT_CHUNK_BYTES: usize = 64 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/invites", get(list_invites).post(create_invite))
        .route("/invites/{id}", axum::routing::delete(revoke_invite))
        .route("/users", get(list_users))
        .route(
            "/users/{id}",
            axum::routing::patch(update_user).delete(delete_user),
        )
        .route("/users/{id}/reset", post(create_password_reset))
        .route("/audit", get(list_audit))
        .route("/export", get(export_documents))
        .route("/stats", get(stats))
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateInviteRequest {
    /// Optional pre-filled email; when set, registration must match it.
    #[serde(default)]
    pub email: Option<String>,
}

/// The invite token is returned **once**, at creation.
#[derive(Debug, Serialize)]
pub struct CreateInviteResponse {
    pub invite: InviteView,
    pub token: String,
}

#[derive(Debug, Serialize)]
pub struct InviteView {
    pub id: String,
    pub email: Option<String>,
    pub created_at: bson::DateTime,
    pub created_by: Id,
    pub expires_at: bson::DateTime,
    pub used_at: Option<bson::DateTime>,
    pub used_by: Option<Id>,
    pub revoked_at: Option<bson::DateTime>,
    /// Derived: `pending` | `used` | `revoked` | `expired`.
    pub status: String,
}

impl InviteView {
    fn from_invite(value: crate::domain::Invite, now: BsonDateTime) -> Self {
        let status = invite::status(&value, now).as_str().to_string();
        Self {
            id: value.id,
            email: value.email,
            created_at: value.created_at,
            created_by: value.created_by,
            expires_at: value.expires_at,
            used_at: value.used_at,
            used_by: value.used_by,
            revoked_at: value.revoked_at,
            status,
        }
    }
}

pub async fn list_invites(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> AppResult<Json<Vec<InviteView>>> {
    let now = BsonDateTime::now();
    let invites = invite::list(&state)
        .await?
        .into_iter()
        .map(|value| InviteView::from_invite(value, now))
        .collect();
    Ok(Json(invites))
}

pub async fn create_invite(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Json(body): Json<CreateInviteRequest>,
) -> AppResult<Json<CreateInviteResponse>> {
    // An email on the invite is a binding, not a hint: registration must match.
    let email = match body
        .email
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
    {
        Some(raw) => {
            let normalized = crate::auth::normalize_email(raw);
            if !crate::auth::email_looks_valid(&normalized) {
                return Err(AppError::bad_request("email is not a valid address"));
            }
            Some(normalized)
        }
        None => None,
    };

    let (created, token) = invite::create(&state, &admin.0.user.id, email).await?;

    let actor = admin.actor();
    audit::record(
        &state,
        "invite.create",
        Some(&actor),
        audit::TARGET_INVITE,
        Some(created.id.clone()),
        doc! {
            "email": created.email.clone(),
            "expires_at": created.expires_at,
        },
        meta.ip,
    )
    .await;

    let now = BsonDateTime::now();
    Ok(Json(CreateInviteResponse {
        invite: InviteView::from_invite(created, now),
        token,
    }))
}

pub async fn revoke_invite(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let revoked = invite::revoke(&state, &id).await?;

    let actor = admin.actor();
    audit::record(
        &state,
        "invite.revoke",
        Some(&actor),
        audit::TARGET_INVITE,
        Some(revoked.id.clone()),
        doc! { "email": revoked.email.clone() },
        meta.ip,
    )
    .await;

    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct UpdateUserRequest {
    /// Toggle the admin flag. The last admin cannot be demoted.
    #[serde(default)]
    pub is_admin: Option<bool>,
    #[serde(default)]
    pub name: Option<String>,
}

/// One-time reset link for a user (SPEC §5.1). The token is returned once.
#[derive(Debug, Serialize)]
pub struct PasswordResetResponse {
    pub user_id: Id,
    pub token: String,
    pub expires_at: bson::DateTime,
}

pub async fn list_users(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> AppResult<Json<Vec<UserView>>> {
    let users: Vec<User> = state
        .collections
        .users()
        .find(doc! {})
        .sort(doc! { "created_at": 1 })
        .await?
        .try_collect()
        .await?;

    Ok(Json(users.into_iter().map(UserView::from).collect()))
}

pub async fn update_user(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Path(id): Path<String>,
    Json(body): Json<UpdateUserRequest>,
) -> AppResult<Json<UserView>> {
    let users = state.collections.users();
    let target = users
        .find_one(doc! { "_id": &id })
        .await?
        .ok_or(AppError::NotFound("user"))?;

    let mut changes = doc! { "updated_at": BsonDateTime::now() };
    let mut actions: Vec<&'static str> = Vec::new();
    // Set when this request is the one that takes the admin flag away, so the
    // invariant can be re-checked once the write has landed.
    let mut demoted_an_active_admin = false;

    if let Some(name) = body.name.as_deref().map(str::trim) {
        if name.is_empty() {
            return Err(AppError::bad_request("name cannot be empty"));
        }
        let name: String = name.chars().take(120).collect();
        if name != target.name {
            changes.insert("name", name);
            actions.push("user.rename");
        }
    }

    if let Some(is_admin) = body.is_admin
        && is_admin != target.is_admin
    {
        if !target.is_active {
            // A deleted account cannot be handed the admin flag; undeleting is
            // not a v1 operation, so there is nothing sensible to toggle.
            return Err(AppError::unprocessable(
                "cannot change the admin flag of a deleted account",
            ));
        }
        if !is_admin {
            // The workspace must never end up with nobody who can administer it.
            ensure_not_last_admin(&state, &target, "demoted").await?;
            demoted_an_active_admin = true;
        }
        changes.insert("is_admin", is_admin);
        actions.push(if is_admin {
            "user.promote"
        } else {
            "user.demote"
        });
    }

    if actions.is_empty() {
        // Nothing to do; report the current state rather than inventing an
        // audit entry for a no-op.
        return Ok(Json(UserView::from(target)));
    }

    users
        .update_one(doc! { "_id": &id }, doc! { "$set": changes })
        .await?;

    if demoted_an_active_admin {
        // Two admins demoting each other concurrently both passed the read above;
        // the one that finds no admin left puts the flag back.
        undo_unless_an_admin_remains(&state, &id, doc! { "is_admin": true }, "demoted").await?;
    }

    let updated = users
        .find_one(doc! { "_id": &id })
        .await?
        .ok_or(AppError::NotFound("user"))?;

    let actor = admin.actor();
    for action in actions {
        audit::record(
            &state,
            action,
            Some(&actor),
            audit::TARGET_USER,
            Some(id.clone()),
            doc! { "email": &updated.email, "is_admin": updated.is_admin },
            meta.ip.clone(),
        )
        .await;
    }

    Ok(Json(UserView::from(updated)))
}

/// Deactivates the user and revokes their sessions; attribution ids stay.
pub async fn delete_user(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Path(id): Path<String>,
) -> AppResult<Response> {
    let users = state.collections.users();
    let target = users
        .find_one(doc! { "_id": &id })
        .await?
        .ok_or(AppError::NotFound("user"))?;

    if target.is_admin {
        ensure_not_last_admin(&state, &target, "deleted").await?;
    }

    if target.is_active {
        users
            .update_one(
                doc! { "_id": &id },
                // Attribution ids stay in documents and are rendered "deleted
                // user" (SPEC §5.1); only the ability to sign in goes away. The
                // admin flag goes with it so the last-admin count stays honest.
                doc! { "$set": {
                    "is_active": false,
                    "is_admin": false,
                    "updated_at": BsonDateTime::now(),
                } },
            )
            .await?;

        if target.is_admin {
            // Re-checked after the write, and rolled back if two admins deleted
            // each other at once — before any session is revoked, so an undone
            // deletion leaves the account exactly as it was.
            undo_unless_an_admin_remains(
                &state,
                &id,
                doc! { "is_active": true, "is_admin": true },
                "deleted",
            )
            .await?;
        }
    }

    // Sessions *and* bearer tokens: both live in `sessions`, so one delete
    // covers every carrier.
    let revoked = crate::auth::revoke_user_sessions(&state, &id).await?;

    // An outstanding reset link would let the deleted account back in.
    state
        .collections
        .password_resets()
        .delete_many(doc! { "user_id": &id, "used_at": null })
        .await?;

    let actor = admin.actor();
    audit::record(
        &state,
        "user.delete",
        Some(&actor),
        audit::TARGET_USER,
        Some(id.clone()),
        doc! {
            "email": &target.email,
            "was_admin": target.is_admin,
            "sessions_revoked": i64::try_from(revoked).unwrap_or(i64::MAX),
        },
        meta.ip,
    )
    .await;

    Ok(StatusCode::NO_CONTENT.into_response())
}

pub async fn create_password_reset(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Path(id): Path<String>,
) -> AppResult<Json<PasswordResetResponse>> {
    let target = state
        .collections
        .users()
        .find_one(doc! { "_id": &id })
        .await?
        .ok_or(AppError::NotFound("user"))?;

    if !target.is_active {
        return Err(AppError::unprocessable(
            "cannot issue a reset for a deleted account",
        ));
    }

    let actor = admin.actor();
    let (issued, token) = reset::issue(&state, &target.id, Some(&actor)).await?;

    audit::record(
        &state,
        "user.password_reset_issue",
        Some(&actor),
        audit::TARGET_USER,
        Some(target.id.clone()),
        // The token itself is never written to the audit log.
        doc! { "email": &target.email, "expires_at": issued.expires_at },
        meta.ip,
    )
    .await;

    Ok(Json(PasswordResetResponse {
        user_id: target.id,
        token,
        expires_at: issued.expires_at,
    }))
}

/// Active admins other than `target_id`.
async fn other_active_admins(state: &AppState, target_id: &str) -> Result<u64, AppError> {
    Ok(state
        .collections
        .users()
        .count_documents(doc! {
            "_id": { "$ne": target_id },
            "is_admin": true,
            "is_active": true,
        })
        .await?)
}

/// Reject an operation that would leave the workspace with no active admin
/// (SPEC §5.1), before any work is done. `verb` is used in the client-visible
/// message.
///
/// This is only the fast, friendly half of the invariant: it is a read, and the
/// write happens after it. [`undo_unless_an_admin_remains`] is the half that
/// actually holds under concurrency.
async fn ensure_not_last_admin(
    state: &AppState,
    target: &User,
    verb: &str,
) -> Result<(), AppError> {
    if !target.is_admin {
        return Ok(());
    }
    if other_active_admins(state, &target.id).await? == 0 {
        return Err(AppError::unprocessable(format!(
            "the last admin cannot be {verb}"
        )));
    }
    Ok(())
}

/// Re-check "an active admin still exists" **after** a write that removed one,
/// and undo the write when it no longer holds.
///
/// [`ensure_not_last_admin`] alone is a read-then-write with nothing in between:
/// admins A and B deleting (or demoting) each other at the same moment both read
/// "one other admin remains", both proceed, and the workspace is left with nobody
/// who can administer it — with no supported way back, because registration needs
/// an invite only an admin can mint and the break-glass
/// `life-manager reset-password` CLI issues a password reset, not an admin flag.
/// Mongo here is standalone (SPEC §8 pins a single replica, and Compose runs a
/// standalone mongod), so there is no multi-document transaction to wrap the pair
/// in; instead whoever notices the empty result repairs the row it just changed.
///
/// Both racers can roll back — both keep the flag, both callers get 422 — which
/// is the safe direction to fail in. `restore` is applied only while the account
/// is still the one we changed.
async fn undo_unless_an_admin_remains(
    state: &AppState,
    target_id: &str,
    restore: bson::Document,
    verb: &str,
) -> Result<(), AppError> {
    if other_active_admins(state, target_id).await? > 0 {
        return Ok(());
    }

    let mut set = restore;
    set.insert("updated_at", BsonDateTime::now());
    state
        .collections
        .users()
        .update_one(doc! { "_id": target_id }, doc! { "$set": set })
        .await?;
    tracing::warn!(
        user = %target_id,
        "rolled back: a concurrent change meant this {verb} would have left no active admin"
    );

    Err(AppError::unprocessable(format!(
        "the last admin cannot be {verb}"
    )))
}

// ---------------------------------------------------------------------------
// Audit log, export, stats
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
pub struct AuditParams {
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct AuditResponse {
    pub entries: Vec<AuditEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

pub async fn list_audit(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(params): Query<AuditParams>,
) -> AppResult<Json<AuditResponse>> {
    let limit = params
        .limit
        .unwrap_or(AUDIT_DEFAULT_LIMIT)
        .clamp(1, AUDIT_MAX_LIMIT);

    let mut filter = doc! {};
    if let Some(action) = params
        .action
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        filter.insert("action", action);
    }
    if let Some(actor) = params
        .actor
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
    {
        filter.insert("actor", actor);
    }
    if let Some(target) = params
        .target_id
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        filter.insert("target_id", target);
    }
    // Entry ids are ULIDs, so `_id` descending *is* newest-first and paginating
    // on it is stable under concurrent writes (an offset would not be).
    if let Some(cursor) = params
        .cursor
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        filter.insert("_id", doc! { "$lt": cursor });
    }

    let entries: Vec<AuditEntry> = state
        .collections
        .audit_log()
        .find(filter)
        .sort(doc! { "_id": -1 })
        // One extra row answers "is there a next page?" without a count.
        .limit(i64::from(limit) + 1)
        .await?
        .try_collect()
        .await?;

    let (entries, next_cursor) = if entries.len() > limit as usize {
        let page: Vec<AuditEntry> = entries.into_iter().take(limit as usize).collect();
        let cursor = page.last().map(|entry| entry.id.clone());
        (page, cursor)
    } else {
        (entries, None)
    };

    Ok(Json(AuditResponse {
        entries,
        next_cursor,
    }))
}

/// `GET /api/admin/export` — a zip of every document as plain markdown: the
/// no-Mongo disaster-recovery path (SPEC §5.1). Streamed, never fully buffered;
/// filenames derive from title + id and are sanitized.
pub async fn export_documents(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
) -> AppResult<Response> {
    let actor = admin.actor();
    audit::record_simple(
        &state,
        "workspace.export",
        Some(&actor),
        audit::TARGET_WORKSPACE,
        None,
        meta.ip,
    )
    .await;

    // Two hops so neither side blocks the other: an async producer reads Mongo,
    // a blocking zipper compresses, and the response body pulls bytes out.
    let (entry_tx, entry_rx) = mpsc::channel::<(String, String)>(8);
    let (byte_tx, byte_rx) = mpsc::channel::<Result<Bytes, io::Error>>(4);

    let collections = state.collections.clone();
    tokio::spawn(async move {
        if let Err(err) = stream_export_entries(collections, entry_tx).await {
            tracing::error!(error = ?err, "export: reading documents failed");
        }
    });

    tokio::task::spawn_blocking(move || {
        if let Err(err) = write_export_zip(entry_rx, byte_tx) {
            tracing::error!(error = ?err, "export: writing the zip failed");
        }
    });

    let filename = format!(
        "life-manager-export-{}.zip",
        BsonDateTime::now().timestamp_millis()
    );
    let body = Body::from_stream(tokio_stream_from(byte_rx));

    Ok((
        [
            (header::CONTENT_TYPE, "application/zip".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
        ],
        body,
    )
        .into_response())
}

/// Read every live document's materialized text, newest id first, and hand
/// `(filename, content)` pairs to the zipper.
async fn stream_export_entries(
    collections: crate::db::Collections,
    entry_tx: mpsc::Sender<(String, String)>,
) -> AppResult<()> {
    let mut cursor = collections
        .raw(db::DOCUMENTS)
        .find(doc! { "deleted_at": null })
        // The CRDT blobs are the one thing an export must not carry.
        .projection(doc! { "_id": 1, "title": 1, "content": 1 })
        .sort(doc! { "_id": 1 })
        .await?;

    let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    while let Some(row) = cursor.try_next().await? {
        let id = row.get_str("_id").unwrap_or_default().to_string();
        let title = row.get_str("title").unwrap_or_default();
        let content = row.get_str("content").unwrap_or_default().to_string();

        let mut name = export_filename(title, &id);
        // Distinct documents may share a title; the id suffix already differs,
        // but be defensive about a collision after sanitization.
        if !used_names.insert(name.clone()) {
            name = format!("{id}.md");
            used_names.insert(name.clone());
        }

        if entry_tx.send((name, content)).await.is_err() {
            // The client hung up.
            break;
        }
    }
    Ok(())
}

/// Compress entries into a zip, pushing chunks to `byte_tx`. Runs on a blocking
/// thread: the `zip` crate is synchronous.
fn write_export_zip(
    mut entry_rx: mpsc::Receiver<(String, String)>,
    byte_tx: mpsc::Sender<Result<Bytes, io::Error>>,
) -> io::Result<()> {
    let writer = ChannelWriter {
        tx: byte_tx,
        buffer: Vec::with_capacity(EXPORT_CHUNK_BYTES),
    };
    let mut zip = zip::ZipWriter::new_stream(writer);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    while let Some((name, content)) = entry_rx.blocking_recv() {
        zip.start_file(name, options)
            .map_err(|err| io::Error::other(err.to_string()))?;
        zip.write_all(content.as_bytes())?;
    }

    let mut inner = zip
        .finish()
        .map_err(|err| io::Error::other(err.to_string()))?;
    inner.flush()
}

/// A `Write` sink that forwards buffered chunks into a tokio channel.
struct ChannelWriter {
    tx: mpsc::Sender<Result<Bytes, io::Error>>,
    buffer: Vec<u8>,
}

impl Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buffer.extend_from_slice(data);
        if self.buffer.len() >= EXPORT_CHUNK_BYTES {
            self.flush()?;
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let chunk = Bytes::from(std::mem::take(&mut self.buffer));
        self.tx
            .blocking_send(Ok(chunk))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "export receiver dropped"))
    }
}

/// Bridge an mpsc receiver into the stream `Body::from_stream` wants.
fn tokio_stream_from(
    rx: mpsc::Receiver<Result<Bytes, io::Error>>,
) -> impl futures::Stream<Item = Result<Bytes, io::Error>> {
    futures::stream::unfold(rx, |mut rx| async move {
        let item = rx.recv().await?;
        Some((item, rx))
    })
}

/// `<sanitized title>-<id>.md`, safe on every filesystem and free of traversal.
fn export_filename(title: &str, id: &str) -> String {
    let mut slug = String::with_capacity(48);
    let mut last_was_dash = true;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash && slug.len() < 60 {
            slug.push('-');
            last_was_dash = true;
        }
        if slug.len() >= 60 {
            break;
        }
    }
    let slug = slug.trim_matches('-');

    if slug.is_empty() {
        format!("{id}.md")
    } else {
        format!("{slug}-{id}.md")
    }
}

/// Workspace counters for the admin dashboard (documents, trashed, attachments,
/// users, storage sizes).
#[derive(Debug, Serialize)]
pub struct AdminStats {
    pub documents: u64,
    pub trashed_documents: u64,
    pub graveyard_entries: u64,
    pub attachments: u64,
    pub attachment_bytes: u64,
    pub users: u64,
    pub schema_version: i32,
    pub oversized_documents: u64,
}

pub async fn stats(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> AppResult<Json<AdminStats>> {
    let documents = state
        .collections
        .documents()
        .count_documents(doc! { "deleted_at": null })
        .await?;
    let trashed_documents = state
        .collections
        .documents()
        .count_documents(doc! { "deleted_at": { "$ne": null } })
        .await?;
    let graveyard_entries = state
        .collections
        .deleted_ids()
        .count_documents(doc! {})
        .await?;
    let attachments = state
        .collections
        .attachments()
        .count_documents(doc! { "deleted_at": null })
        .await?;
    let users = state.collections.users().count_documents(doc! {}).await?;
    let attachment_bytes = sum_attachment_bytes(&state).await?;

    Ok(Json(AdminStats {
        documents,
        trashed_documents,
        graveyard_entries,
        attachments,
        attachment_bytes,
        users,
        schema_version: state
            .readiness
            .schema_version
            .load(std::sync::atomic::Ordering::Relaxed),
        oversized_documents: state.docs.stats().oversized_docs as u64,
    }))
}

async fn sum_attachment_bytes(state: &AppState) -> AppResult<u64> {
    let mut cursor = state
        .collections
        .raw(db::ATTACHMENTS)
        .aggregate(vec![
            doc! { "$match": { "deleted_at": null } },
            doc! { "$group": { "_id": null, "bytes": { "$sum": "$size" } } },
        ])
        .await?;

    let Some(row) = cursor.try_next().await? else {
        return Ok(0);
    };
    // `$sum` yields an int32, int64 or double depending on the inputs.
    let bytes = match row.get("bytes") {
        Some(bson::Bson::Int64(value)) => *value,
        Some(bson::Bson::Int32(value)) => i64::from(*value),
        Some(bson::Bson::Double(value)) => *value as i64,
        _ => 0,
    };
    Ok(u64::try_from(bytes).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    /// The export path is the disaster-recovery path: a zip that streams but does
    /// not open is worse than no zip at all, so drive the real writer and read the
    /// bytes back with a zip reader.
    #[test]
    fn export_zip_streams_a_readable_archive() {
        let (entry_tx, entry_rx) = mpsc::channel::<(String, String)>(8);
        let (byte_tx, mut byte_rx) = mpsc::channel::<Result<Bytes, io::Error>>(64);

        entry_tx
            .blocking_send((
                "groceries-A.md".to_string(),
                "# Groceries\n- milk".to_string(),
            ))
            .expect("queue first entry");
        entry_tx
            .blocking_send(("notes-B.md".to_string(), "# Notes".to_string()))
            .expect("queue second entry");
        drop(entry_tx);

        write_export_zip(entry_rx, byte_tx).expect("zip written");

        let mut bytes = Vec::new();
        while let Some(chunk) = byte_rx.blocking_recv() {
            bytes.extend_from_slice(&chunk.expect("chunk"));
        }
        assert!(!bytes.is_empty(), "the stream produced nothing");

        let mut archive =
            zip::ZipArchive::new(io::Cursor::new(bytes)).expect("a well-formed archive");
        assert_eq!(archive.len(), 2);

        let mut first = String::new();
        archive
            .by_index(0)
            .expect("first entry")
            .read_to_string(&mut first)
            .expect("readable");
        assert_eq!(first, "# Groceries\n- milk");

        let names: Vec<String> = archive.file_names().map(str::to_string).collect();
        assert!(names.contains(&"notes-B.md".to_string()), "{names:?}");
    }

    #[test]
    fn export_zip_of_an_empty_workspace_is_still_valid() {
        let (entry_tx, entry_rx) = mpsc::channel::<(String, String)>(1);
        let (byte_tx, mut byte_rx) = mpsc::channel::<Result<Bytes, io::Error>>(8);
        drop(entry_tx);

        write_export_zip(entry_rx, byte_tx).expect("zip written");

        let mut bytes = Vec::new();
        while let Some(chunk) = byte_rx.blocking_recv() {
            bytes.extend_from_slice(&chunk.expect("chunk"));
        }
        let archive = zip::ZipArchive::new(io::Cursor::new(bytes)).expect("a well-formed archive");
        assert_eq!(archive.len(), 0);
    }

    #[test]
    fn export_filenames_are_safe() {
        assert_eq!(export_filename("Groceries", "ID1"), "groceries-ID1.md");
        assert_eq!(
            export_filename("../../etc/passwd", "ID1"),
            "etc-passwd-ID1.md",
            "no path separators, no traversal"
        );
        assert_eq!(
            export_filename("  ", "ID1"),
            "ID1.md",
            "an untitled document still gets a name"
        );
        assert_eq!(export_filename("", "ID1"), "ID1.md");
        assert_eq!(
            export_filename("Hello, World!", "ID1"),
            "hello-world-ID1.md",
            "runs of punctuation collapse to one dash"
        );
    }

    #[test]
    fn export_filenames_are_bounded_and_ascii() {
        let name = export_filename(&"long title ".repeat(30), "ID1");
        assert!(name.len() <= 60 + 1 + 3 + 4, "unexpectedly long: {name}");
        assert!(name.is_ascii());
        assert!(!name.contains('/') && !name.contains('\\'));
        assert!(name.ends_with(".md"));

        // Non-ASCII titles degrade to the id rather than to mojibake.
        assert_eq!(export_filename("日本語", "ID1"), "ID1.md");
    }

    #[test]
    fn audit_params_default_to_an_unfiltered_first_page() {
        let params: AuditParams = serde_json::from_str("{}").unwrap();
        assert!(params.action.is_none());
        assert!(params.cursor.is_none());
        assert_eq!(
            params.limit.unwrap_or(AUDIT_DEFAULT_LIMIT),
            AUDIT_DEFAULT_LIMIT
        );
        // A client asking for a million rows gets the ceiling.
        assert_eq!(1_000_000u32.clamp(1, AUDIT_MAX_LIMIT), AUDIT_MAX_LIMIT);
        assert_eq!(0u32.clamp(1, AUDIT_MAX_LIMIT), 1);
    }
}

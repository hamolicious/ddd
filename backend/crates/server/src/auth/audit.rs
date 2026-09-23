//! The audit-log helper (SPEC §5.4).
//!
//! Every destructive or administrative action goes through [`record`]: document
//! deletes and restores, user/invite operations, plugin operations. It never
//! fails a request — a lost audit row is logged, not surfaced.
//!
//! **Call sites outside `auth/` are expected**: the document, attachment and
//! admin routes all use this one helper so the `action` vocabulary stays in one
//! place.

use bson::Document as BsonDocument;

use crate::domain::{Actor, AuditEntry};
use crate::state::AppState;

/// `target_kind` values. Use these rather than string literals so the admin view
/// can filter on a closed set.
pub const TARGET_DOCUMENT: &str = "document";
pub const TARGET_USER: &str = "user";
pub const TARGET_INVITE: &str = "invite";
pub const TARGET_ATTACHMENT: &str = "attachment";
pub const TARGET_SESSION: &str = "session";
pub const TARGET_SNAPSHOT: &str = "snapshot";
pub const TARGET_WORKSPACE: &str = "workspace";
pub const TARGET_PLUGIN: &str = "plugin";

/// Record an audit entry.
///
/// `detail` must never contain a secret: tokens, password hashes, or raw
/// credentials. Pass `bson::Document::new()` when there is nothing to add.
pub async fn record(
    state: &AppState,
    action: &str,
    actor: Option<&Actor>,
    target_kind: &str,
    target_id: Option<String>,
    detail: BsonDocument,
    ip: Option<String>,
) {
    state
        .audit(
            AuditEntry::new(action, actor, target_kind, target_id)
                .with_detail(detail)
                .with_ip(ip),
        )
        .await;
}

/// [`record`] without a detail document — the common case.
pub async fn record_simple(
    state: &AppState,
    action: &str,
    actor: Option<&Actor>,
    target_kind: &str,
    target_id: Option<String>,
    ip: Option<String>,
) {
    record(
        state,
        action,
        actor,
        target_kind,
        target_id,
        BsonDocument::new(),
        ip,
    )
    .await;
}

use bson::Document as BsonDocument;

use crate::domain::{Actor, AuditEntry};
use crate::state::AppState;

pub const TARGET_DOCUMENT: &str = "document";
pub const TARGET_USER: &str = "user";
pub const TARGET_INVITE: &str = "invite";
pub const TARGET_ATTACHMENT: &str = "attachment";
pub const TARGET_SESSION: &str = "session";
pub const TARGET_SNAPSHOT: &str = "snapshot";
pub const TARGET_WORKSPACE: &str = "workspace";
pub const TARGET_PLUGIN: &str = "plugin";

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

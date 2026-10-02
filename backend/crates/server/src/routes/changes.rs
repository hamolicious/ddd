use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, Query, State};
use bson::doc;
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};

use crate::auth::{AdminUser, AuthUser};
use crate::changes::{self, Change, RevertError};
use crate::domain::{AuditEntry, DocumentChange, DocumentView, RevertNote, StoredHunk, Timestamp};
use crate::error::{AppError, AppResult};
use crate::routes::documents::{check_id, map_docstore};
use crate::state::AppState;

const FETCH: i64 = 1000;
const DEFAULT_GROUPS: usize = 30;
const EXCERPT_CHARS: usize = 120;

#[derive(Debug, Deserialize)]
pub struct ChangesParams {
    pub before: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct ChangeGroupView {
    pub from_seq: i64,
    pub to_seq: i64,
    pub started_at: Timestamp,
    pub ended_at: Timestamp,
    pub by: Option<String>,
    pub by_label: String,
    pub changes: usize,
    pub inserted_chars: usize,
    pub removed_chars: usize,
    pub inserted_excerpt: String,
    pub removed_excerpt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reverts: Option<RevertedRange>,
    pub squashed: bool,
    pub offline: bool,
}

#[derive(Debug, Serialize)]
pub struct RevertedRange {
    pub from_seq: i64,
    pub to_seq: i64,
}

#[derive(Debug, Serialize)]
pub struct ChangesPage {
    pub groups: Vec<ChangeGroupView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_before: Option<i64>,
}

pub async fn list_changes(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
    Query(params): Query<ChangesParams>,
) -> AppResult<Json<ChangesPage>> {
    check_id(&id)?;
    let limit = params.limit.unwrap_or(DEFAULT_GROUPS).clamp(1, 200);

    let records = state
        .docs
        .changes(&id, params.before, FETCH)
        .await
        .map_err(map_docstore)?;
    let full_page = records.len() as i64 == FETCH;
    let newest_first: Vec<Change> = records.iter().map(DocumentChange::to_change).collect();
    let mut raw_groups = changes::group(&newest_first, changes::GROUP_GAP_MS);
    if full_page && raw_groups.len() > 1 {
        raw_groups.pop();
    }
    let by_seq: HashMap<i64, &DocumentChange> =
        records.iter().map(|record| (record.seq, record)).collect();
    let mut drafts: Vec<Draft> = raw_groups
        .into_iter()
        .map(|group| {
            let members: Vec<&DocumentChange> = (group.from_seq..=group.to_seq)
                .filter_map(|seq| by_seq.get(&seq).copied())
                .collect();
            let reverts = match members.as_slice() {
                [only] => only.reverts.clone(),
                _ => None,
            };
            Draft {
                hunks: members
                    .iter()
                    .flat_map(|change| change.hunks.iter().cloned())
                    .collect(),
                reverts,
                squashed: false,
                offline: members.iter().any(|change| change.offline),
                group,
            }
        })
        .collect();

    let squashed = state
        .docs
        .squashed(&id, params.before, limit as i64 + 1)
        .await
        .map_err(map_docstore)?;
    let squashed_full = squashed.len() > limit;
    drafts.extend(squashed.into_iter().map(|record| {
        Draft {
            group: changes::Group {
                from_seq: record.from_seq,
                to_seq: record.to_seq,
                started_ms: record.started_at.timestamp_millis(),
                ended_ms: record.ended_at.timestamp_millis(),
                by: record.created_by.clone(),
                changes: record.changes.max(0) as usize,
                inserted_chars: record
                    .hunks
                    .iter()
                    .map(|hunk| hunk.inserted.chars().count())
                    .sum(),
                removed_chars: record
                    .hunks
                    .iter()
                    .map(|hunk| hunk.removed.chars().count())
                    .sum(),
            },
            hunks: record.hunks,
            reverts: record.reverts,
            squashed: true,
            offline: record.offline,
        }
    }));

    drafts.sort_by_key(|draft| std::cmp::Reverse(draft.group.to_seq));
    let more = drafts.len() > limit || full_page || squashed_full;
    drafts.truncate(limit);
    let next_before = if more {
        drafts.last().map(|draft| draft.group.from_seq)
    } else {
        None
    };

    let labels = labels(
        &state,
        drafts.iter().filter_map(|draft| draft.group.by.clone()),
    )
    .await?;
    let views = drafts
        .into_iter()
        .map(|draft| {
            let inserted = pieces(&draft.hunks, |hunk| hunk.inserted.as_str());
            let removed = pieces(&draft.hunks, |hunk| hunk.removed.as_str());
            let group = draft.group;
            ChangeGroupView {
                from_seq: group.from_seq,
                to_seq: group.to_seq,
                started_at: Timestamp::from_millis(group.started_ms),
                ended_at: Timestamp::from_millis(group.ended_ms),
                by_label: label_of(group.by.as_deref(), &labels),
                by: group.by,
                changes: group.changes,
                inserted_chars: group.inserted_chars,
                removed_chars: group.removed_chars,
                inserted_excerpt: excerpt(&inserted),
                removed_excerpt: excerpt(&removed),
                reverts: draft.reverts.map(|note| RevertedRange {
                    from_seq: note.from_seq,
                    to_seq: note.to_seq,
                }),
                squashed: draft.squashed,
                offline: draft.offline,
            }
        })
        .collect();

    Ok(Json(ChangesPage {
        groups: views,
        next_before,
    }))
}

struct Draft {
    group: changes::Group,
    hunks: Vec<StoredHunk>,
    reverts: Option<RevertNote>,
    squashed: bool,
    offline: bool,
}

fn pieces(hunks: &[StoredHunk], pick: fn(&StoredHunk) -> &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut last_end: Option<i64> = None;
    for hunk in hunks {
        let text = pick(hunk);
        if text.trim().is_empty() {
            continue;
        }
        match (out.last_mut(), last_end) {
            (Some(open), Some(end)) if end == hunk.pos => open.push_str(text),
            _ => out.push(text.to_string()),
        }
        last_end = Some(hunk.pos + hunk.inserted.len() as i64);
    }
    out.join(" … ")
}

#[derive(Debug, Serialize)]
pub struct ShownHunkView {
    pub before: String,
    pub removed: String,
    pub inserted: String,
    pub after: String,
}

#[derive(Debug, Serialize)]
pub struct ChangeDetail {
    pub from_seq: i64,
    pub to_seq: i64,
    pub started_at: Timestamp,
    pub ended_at: Timestamp,
    pub by: Option<String>,
    pub by_label: String,
    pub changes: usize,
    pub hunks: Vec<ShownHunkView>,
}

pub async fn get_change(
    State(state): State<AppState>,
    _user: AuthUser,
    Path((id, from, to)): Path<(String, i64, i64)>,
) -> AppResult<Json<ChangeDetail>> {
    check_id(&id)?;
    let (group, _later) = load_group(&state, &id, from, to).await?;
    let before = state
        .docs
        .text_at(&id, from - 1)
        .await
        .map_err(map_docstore)?;
    let after = state.docs.text_at(&id, to).await.map_err(map_docstore)?;

    let first = group.first().expect("load_group returns a non-empty group");
    let last = group.last().expect("load_group returns a non-empty group");
    let squashed = state
        .collections
        .document_history()
        .find_one(doc! { "document_id": &id, "from_seq": from, "to_seq": to })
        .await?;
    let labels = labels(&state, first.by.clone()).await?;
    Ok(Json(ChangeDetail {
        from_seq: from,
        to_seq: to,
        started_at: Timestamp::from_millis(
            squashed
                .as_ref()
                .map_or(first.at_ms, |record| record.started_at.timestamp_millis()),
        ),
        ended_at: Timestamp::from_millis(last.at_ms),
        by_label: label_of(first.by.as_deref(), &labels),
        by: first.by.clone(),
        changes: squashed
            .as_ref()
            .map_or(group.len(), |record| record.changes.max(0) as usize),
        hunks: changes::shown_hunks(&before, &after)
            .into_iter()
            .map(|hunk| ShownHunkView {
                before: hunk.before,
                removed: hunk.removed,
                inserted: hunk.inserted,
                after: hunk.after,
            })
            .collect(),
    }))
}

pub async fn revert_change(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, from, to)): Path<(String, i64, i64)>,
) -> AppResult<Json<DocumentView>> {
    check_id(&id)?;
    let (_group, later) = load_group(&state, &id, from, to).await?;
    let before = state
        .docs
        .text_at(&id, from - 1)
        .await
        .map_err(map_docstore)?;
    let after = state.docs.text_at(&id, to).await.map_err(map_docstore)?;

    let current = state.docs.text(&id).await.map_err(map_docstore)?;
    if let Err(error) = changes::revert_edits(&current, &before, &after, &later) {
        return Err(refusal(&state, error).await?);
    }

    let compute = |text: &str| {
        changes::revert_edits(text, &before, &after, &later)
            .map_err(|_| "the document changed while reverting; try again".to_string())
    };
    let outcome = state
        .docs
        .splice(&id, &compute, &user.actor())
        .await
        .map_err(|error| match error {
            crate::docstore::DocStoreError::SpliceRefused(message) => AppError::Conflict(message),
            other => map_docstore(other),
        })?;
    state
        .docs
        .note_revert(&id, outcome.seq, from, to)
        .await
        .map_err(map_docstore)?;
    crate::routes::sync::publish_update(&state, &id, &outcome.update);

    state
        .audit(
            AuditEntry::new(
                "change.revert",
                Some(&user.actor()),
                "document",
                Some(id.clone()),
            )
            .with_detail(doc! { "from_seq": from, "to_seq": to })
            .with_ip(user.session.ip.clone()),
        )
        .await;

    let document = state.docs.get(&id).await.map_err(map_docstore)?;
    Ok(Json(DocumentView::from(document)))
}

async fn load_group(
    state: &AppState,
    id: &str,
    from: i64,
    to: i64,
) -> AppResult<(Vec<Change>, Vec<Change>)> {
    if from > to || from < 1 {
        return Err(AppError::bad_request(
            "a change range is from..=to, from at least 1",
        ));
    }
    let units = state
        .docs
        .changes_since(id, from)
        .await
        .map_err(map_docstore)?;
    let (group, later): (Vec<Change>, Vec<Change>) =
        units.into_iter().partition(|change| change.seq <= to);
    if group.is_empty() {
        return Err(AppError::NotFound("change"));
    }
    Ok((group, later))
}

pub async fn forget_history(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
) -> AppResult<axum::http::StatusCode> {
    check_id(&id)?;
    state.docs.forget_history(&id).await.map_err(map_docstore)?;
    state
        .audit(
            AuditEntry::new(
                "history.forget",
                Some(&admin.actor()),
                "document",
                Some(id.clone()),
            )
            .with_ip(admin.0.session.ip.clone()),
        )
        .await;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct TextAtParams {
    pub at: i64,
}

#[derive(Debug, Serialize)]
pub struct TextAtView {
    pub seq: i64,
    pub content: String,
}

pub async fn text_at(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
    Query(params): Query<TextAtParams>,
) -> AppResult<Json<TextAtView>> {
    check_id(&id)?;
    if params.at < 1 {
        return Err(AppError::bad_request("`at` is an update seq, 1 or more"));
    }
    let content = state
        .docs
        .text_at(&id, params.at)
        .await
        .map_err(map_docstore)?;
    Ok(Json(TextAtView {
        seq: params.at,
        content,
    }))
}

fn history_gap() -> AppError {
    AppError::Conflict(
        "this document's history has a gap here (a write from before change history was kept), \
         so this change can no longer be shown or reverted"
            .to_string(),
    )
}

async fn refusal(state: &AppState, error: RevertError) -> AppResult<AppError> {
    Ok(match error {
        RevertError::Gap(_) => history_gap(),
        RevertError::Nothing => {
            AppError::Conflict("this change has nothing left to undo".to_string())
        }
        RevertError::Conflict(conflict) => {
            let labels = labels(state, conflict.by.clone()).await?;
            let who = label_of(conflict.by.as_deref(), &labels);
            AppError::Conflict(format!(
                "{who} changed the same text later. Revert that change first, or restore a snapshot."
            ))
        }
    })
}

fn excerpt(text: &str) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = flat.chars();
    let head: String = chars.by_ref().take(EXCERPT_CHARS).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

async fn labels(
    state: &AppState,
    actors: impl IntoIterator<Item = String>,
) -> AppResult<HashMap<String, String>> {
    let ids: HashSet<String> = actors
        .into_iter()
        .filter(|actor| !actor.starts_with("plugin:") && actor != "system")
        .collect();
    let mut labels = HashMap::new();
    if ids.is_empty() {
        return Ok(labels);
    }
    let ids: Vec<String> = ids.into_iter().collect();
    let mut cursor = state
        .collections
        .users()
        .find(doc! { "_id": { "$in": ids }, "is_active": true })
        .await?;
    while let Some(user) = cursor.try_next().await? {
        let label = if user.name.trim().is_empty() {
            user.email
        } else {
            user.name
        };
        labels.insert(user.id, label);
    }
    Ok(labels)
}

fn label_of(by: Option<&str>, labels: &HashMap<String, String>) -> String {
    match by {
        None | Some("system") => "system".to_string(),
        Some(actor) => match actor.strip_prefix("plugin:") {
            Some(plugin) => format!("plugin {plugin}"),
            None => labels
                .get(actor)
                .cloned()
                .unwrap_or_else(|| "deleted user".to_string()),
        },
    }
}

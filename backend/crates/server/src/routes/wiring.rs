//! `/api/wiring` — the admin's view of the wiring store and the one way to apply a draft
//! (PLUGIN-PROTOCOLS §6c, §9 step 7).
//!
//! | Route | Response |
//! |---|---|
//! | `GET /` | `{ live: LiveWiring, history: [WiringVersionInfo…] }`, history newest first |
//! | `GET /versions/{v}` | the stored version, its wiring included; 404 when there is none |
//! | `POST /apply` | `{ base, wiring, action: "apply" \| "rollback" }` → `{ live }`; 409 when `base` is stale |
//!
//! Every handler takes [`AdminUser`]: a non-admin gets 403, an anonymous caller 401.
//!
//! # Apply is the draft's only exit
//!
//! A draft is prepared against the version the editor loaded (`base`), and the store
//! refuses it when that version is no longer live ([`WiringError::Conflict`], a 409): a
//! change prepared against N is never applied on top of N+1 without the person seeing N+1
//! first. A rollback is an apply whose wiring is an older version's, recorded as
//! `rollback` so the history says what happened.
//!
//! # Unplug is disable
//!
//! `PluginState` stays the one gate (`wiring.rs`), so a draft that unplugs a plugin moves
//! its record to `disabled` and a draft that plugs one back in moves it to `enabled`, with
//! its breaker cleared — the same record updates the admin's on/off buttons make, minus the
//! wiring version those write, because this apply *is* the version. The version is
//! committed first: a stale base changes nothing at all.

use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use life_manager_core::wiring::Wiring;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::auth::AdminUser;
use crate::error::{AppError, AppResult};
use crate::plugininstall;
use crate::plugins::PluginState;
use crate::routes::plugin_api::{ADMIN_DISABLE_REASON, note};
use crate::state::AppState;
use crate::wiring::{self, Commit, LiveWiring, WiringError, WiringVersionInfo};

/// History entries returned when the client does not ask.
pub const HISTORY_DEFAULT_LIMIT: i64 = 50;
/// Hard ceiling on a history page.
pub const HISTORY_MAX_LIMIT: i64 = 200;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(show))
        .route("/versions/{v}", get(show_version))
        .route("/apply", post(apply))
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
pub struct HistoryParams {
    #[serde(default)]
    pub limit: Option<i64>,
}

/// `GET /api/wiring`.
#[derive(Debug, Serialize)]
pub struct WiringResponse {
    pub live: LiveWiring,
    pub history: Vec<WiringVersionInfo>,
}

/// `GET /api/wiring/versions/{v}`: a stored version with its wiring. `at` is RFC 3339, not
/// extended JSON — the record's `bson::DateTime` never reaches the wire.
#[derive(Debug, Serialize)]
pub struct WiringVersionView {
    pub version: i64,
    pub wiring: Wiring,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub at: String,
}

impl From<wiring::WiringRecord> for WiringVersionView {
    fn from(record: wiring::WiringRecord) -> Self {
        WiringVersionView {
            version: record.version,
            wiring: record.wiring,
            action: record.action,
            actor: record.actor,
            subject: record.subject,
            at: record.at.try_to_rfc3339_string().unwrap_or_default(),
        }
    }
}

/// What a draft is applied as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyAction {
    Apply,
    Rollback,
}

impl ApplyAction {
    /// `"apply"` or `"rollback"`; anything else is the client's 400. A plain string on
    /// the request rather than a serde enum so the refusal is the standard error body
    /// and not axum's 422.
    pub fn parse(action: &str) -> Option<ApplyAction> {
        match action {
            "apply" => Some(ApplyAction::Apply),
            "rollback" => Some(ApplyAction::Rollback),
            _ => None,
        }
    }

    /// The `action` the version and its audit entry are stored with.
    pub fn as_str(self) -> &'static str {
        match self {
            ApplyAction::Apply => "apply",
            ApplyAction::Rollback => "rollback",
        }
    }
}

/// `POST /api/wiring/apply`.
#[derive(Debug, Deserialize)]
pub struct ApplyRequest {
    /// The version the draft was prepared against — the live version at the time.
    pub base: i64,
    /// The whole wiring, not a delta: the overrides as they should be after the apply.
    pub wiring: Wiring,
    /// `"apply"` or `"rollback"` ([`ApplyAction::parse`]).
    pub action: String,
}

#[derive(Debug, Serialize)]
pub struct ApplyResponse {
    pub live: LiveWiring,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// `GET /api/wiring` — the live version and the history, newest first.
pub async fn show(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(params): Query<HistoryParams>,
) -> AppResult<Json<WiringResponse>> {
    let limit = history_limit(params.limit);
    // `load`, not `current`: the editor is about to draft against this version, so it
    // should be what Mongo says is live, not what this process last saw. Mongo unreachable
    // still answers from the cache, the way the plugin list does.
    let live = wiring::load(&state).await;
    let history = wiring::history(&state, limit).await.map_err(store_error)?;
    Ok(Json(WiringResponse { live, history }))
}

/// `GET /api/wiring/versions/{v}` — one stored version, for rollback and for the diff view.
pub async fn show_version(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(version): Path<i64>,
) -> AppResult<Json<WiringVersionView>> {
    let record = wiring::version(&state, version)
        .await
        .map_err(store_error)?
        .ok_or(AppError::NotFound("wiring version"))?;
    Ok(Json(record.into()))
}

/// `POST /api/wiring/apply` — write version `base + 1`, move the plugin records the new
/// `unplugged` list implies, then broadcast the version.
pub async fn apply(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(request): Json<ApplyRequest>,
) -> AppResult<Json<ApplyResponse>> {
    let action = ApplyAction::parse(&request.action).ok_or_else(|| {
        AppError::bad_request(format!(
            "`action` must be `apply` or `rollback`, not `{}`",
            request.action
        ))
    })?;
    let actor = admin.actor();
    // Written first, broadcast last: a client answers the frame by fetching the plugin
    // list, so the records must already show what the new version says.
    let live = wiring::commit_quietly(
        &state,
        Commit {
            base: Some(request.base),
            wiring: request.wiring,
            action: action.as_str(),
            actor: &actor,
            subject: None,
        },
    )
    .await
    .map_err(store_error)?;

    // The version is written; now the records. Ids in `unplugged` that are not installed
    // stay in the stored wiring as a pin for a plugin that may come back, and a pending
    // plugin cannot be plugged either way.
    let records = plugininstall::records(&state).await?;
    let diff = plug_diff(
        records
            .iter()
            .map(|record| (record.id.as_str(), record.state)),
        &live.wiring.unplugged,
    );
    let mut first_failure = None;
    for id in &diff.unplug {
        match plugininstall::disable_record(&state, id, ADMIN_DISABLE_REASON, &actor).await {
            Ok(()) => note(
                id,
                "warn",
                format!("unplugged by {} (wiring v{})", admin.0.id(), live.version),
            ),
            Err(err) => {
                warn!(plugin = %id, version = live.version, error = %err, "unplug did not reach the record");
                first_failure.get_or_insert(err);
            }
        }
    }
    for id in &diff.plug {
        match plugininstall::enable_record(&state, id, &actor).await {
            Ok(()) => {
                // `enable_record` resets the breaker for a plugin with a backend half; the
                // in-memory counter is cleared here too so the boundary the admin acted on
                // is the one that is true, exactly as `plugin_api::enable` does.
                crate::pluginhost::PluginHost::get(&state).reset_breaker(id);
                note(
                    id,
                    "info",
                    format!(
                        "plugged in by {} (wiring v{}, breaker cleared)",
                        admin.0.id(),
                        live.version
                    ),
                );
            }
            Err(err) => {
                warn!(plugin = %id, version = live.version, error = %err, "plug did not reach the record");
                first_failure.get_or_insert(err);
            }
        }
    }
    info!(
        version = live.version,
        action = action.as_str(),
        unplugged = ?diff.unplug,
        plugged = ?diff.plug,
        "wiring applied by admin"
    );
    wiring::publish(&state, &live, action.as_str());
    // The version is live either way; a record that could not follow it is reported
    // rather than hidden, and the admin screen shows the plugin where it actually is.
    if let Some(err) = first_failure {
        return Err(err.into());
    }
    Ok(Json(ApplyResponse { live }))
}

// ---------------------------------------------------------------------------
// The pure parts
// ---------------------------------------------------------------------------

/// Which records an applied `unplugged` list moves.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PlugDiff {
    /// Installed and switched on, now listed: these become `disabled`.
    pub unplug: Vec<String>,
    /// `disabled` (by an admin or by the breaker) and no longer listed: these become
    /// `enabled`.
    pub plug: Vec<String>,
}

/// Compare the plugin records against an applied `unplugged` list.
///
/// A plugin whose record is `enabled` or `failed` (approved, switched on, its backend half
/// possibly broken — what [`plugininstall::disable`] accepts) and is now listed is
/// unplugged. A `disabled` plugin that is no longer listed is plugged back in. A `pending`
/// plugin is never touched, and a listed id with no record is nobody's business here.
pub fn plug_diff<'a>(
    records: impl IntoIterator<Item = (&'a str, PluginState)>,
    unplugged: &[String],
) -> PlugDiff {
    let listed = |id: &str| unplugged.iter().any(|entry| entry == id);
    let mut diff = PlugDiff::default();
    for (id, state) in records {
        match state {
            PluginState::Enabled | PluginState::Failed if listed(id) => {
                diff.unplug.push(id.to_string());
            }
            PluginState::Disabled if !listed(id) => diff.plug.push(id.to_string()),
            _ => {}
        }
    }
    diff.unplug.sort();
    diff.plug.sort();
    diff
}

/// `?limit=` clamped to `1..=HISTORY_MAX_LIMIT`, defaulting to [`HISTORY_DEFAULT_LIMIT`].
pub fn history_limit(requested: Option<i64>) -> i64 {
    requested
        .unwrap_or(HISTORY_DEFAULT_LIMIT)
        .clamp(1, HISTORY_MAX_LIMIT)
}

/// A stale base is the client's 409; anything else is the store's 500.
fn store_error(err: WiringError) -> AppError {
    match err {
        WiringError::Conflict { .. } => AppError::Conflict(err.to_string()),
        WiringError::Db(err) => AppError::Db(err),
        WiringError::Bson(message) => AppError::Internal(anyhow::anyhow!(message)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn the_diff_moves_only_what_the_list_changes() {
        let records = [
            ("alpha", PluginState::Enabled),
            ("beta", PluginState::Disabled),
            ("gamma", PluginState::Enabled),
            ("delta", PluginState::Disabled),
            ("epsilon", PluginState::Pending),
            ("zeta", PluginState::Failed),
        ];
        // alpha: on → listed, unplug. beta: off → still listed, nothing. gamma: on, not
        // listed, nothing. delta: off → no longer listed, plug. epsilon: pending, listed
        // or not, nothing. zeta: failed → listed, unplug (what `disable` accepts). ghost:
        // no record, ignored.
        let diff = plug_diff(
            records.iter().copied(),
            &ids(&["zeta", "epsilon", "beta", "alpha", "ghost"]),
        );
        assert_eq!(
            diff,
            PlugDiff {
                unplug: ids(&["alpha", "zeta"]),
                plug: ids(&["delta"]),
            }
        );
    }

    #[test]
    fn an_unchanged_list_moves_nothing() {
        let records = [
            ("alpha", PluginState::Enabled),
            ("beta", PluginState::Disabled),
        ];
        let diff = plug_diff(records.iter().copied(), &ids(&["beta"]));
        assert_eq!(diff, PlugDiff::default());
        let diff = plug_diff(std::iter::empty(), &ids(&["anything"]));
        assert_eq!(diff, PlugDiff::default());
    }

    #[test]
    fn the_history_limit_is_defaulted_and_capped() {
        assert_eq!(history_limit(None), HISTORY_DEFAULT_LIMIT);
        assert_eq!(history_limit(Some(10)), 10);
        assert_eq!(history_limit(Some(0)), 1);
        assert_eq!(history_limit(Some(-5)), 1);
        assert_eq!(history_limit(Some(10_000)), HISTORY_MAX_LIMIT);
    }

    #[test]
    fn the_apply_request_parses_both_actions_and_nothing_else() {
        let apply: ApplyRequest = serde_json::from_value(serde_json::json!({
            "base": 3,
            "wiring": { "unplugged": ["alpha"], "cut": ["a:x -> b:y"] },
            "action": "apply"
        }))
        .expect("parses");
        assert_eq!(apply.base, 3);
        assert_eq!(ApplyAction::parse(&apply.action), Some(ApplyAction::Apply));
        assert_eq!(apply.wiring.unplugged, ids(&["alpha"]));
        assert!(apply.wiring.bind.is_empty());

        let rollback: ApplyRequest = serde_json::from_value(serde_json::json!({
            "base": 4,
            "wiring": {},
            "action": "rollback"
        }))
        .expect("parses");
        assert_eq!(
            ApplyAction::parse(&rollback.action),
            Some(ApplyAction::Rollback)
        );
        assert_eq!(ApplyAction::Rollback.as_str(), "rollback");

        for action in ["install", "Apply", "", "breaker"] {
            assert_eq!(
                ApplyAction::parse(action),
                None,
                "`{action}` must be refused"
            );
        }
        for body in [
            serde_json::json!({ "base": 1, "wiring": {} }),
            serde_json::json!({ "wiring": {}, "action": "apply" }),
        ] {
            assert!(
                serde_json::from_value::<ApplyRequest>(body.clone()).is_err(),
                "{body} must be refused"
            );
        }
    }

    #[test]
    fn a_stale_base_is_a_conflict_and_the_store_failing_is_internal() {
        let conflict = store_error(WiringError::Conflict { base: 2, live: 5 });
        assert!(matches!(conflict, AppError::Conflict(_)));
        assert_eq!(conflict.status(), axum::http::StatusCode::CONFLICT);
        assert!(conflict.to_string().contains("version 5, not 2"));

        let bson = store_error(WiringError::Bson("nope".into()));
        assert_eq!(bson.status(), axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn a_version_view_writes_its_timestamp_as_rfc3339() {
        let view: WiringVersionView = wiring::WiringRecord {
            version: 7,
            wiring: Wiring::default(),
            action: "rollback".into(),
            actor: Some("user:abc".into()),
            subject: None,
            at: bson::DateTime::from_millis(1_700_000_000_000),
        }
        .into();
        let json = serde_json::to_value(&view).expect("serializes");
        assert_eq!(json["version"], 7);
        assert_eq!(json["action"], "rollback");
        assert_eq!(json["actor"], "user:abc");
        assert!(json.get("subject").is_none());
        assert_eq!(json["at"], "2023-11-14T22:13:20Z");
        assert!(!json.to_string().contains("$date"));
    }
}

use std::collections::BTreeMap;

use futures::TryStreamExt;
use serde::{Deserialize, Serialize};

use crate::db;
use crate::domain::{Actor, Timestamp, new_id};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::config::{SealedValue, cipher};
use super::sources::validate_source_id;

pub const MAX_NAME_CHARS: usize = 80;
pub const MAX_CONFIG_BYTES: usize = 16 * 1024;
pub const MAX_SECRETS: usize = 16;
pub const MAX_SECRET_BYTES: usize = 8 * 1024;
pub const MAX_SOURCES: u64 = 200;

#[derive(Debug, Clone, Serialize)]
pub struct SourceView {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub config: serde_json::Value,
    pub secrets: BTreeMap<String, String>,
    pub updated_at: String,
    pub updated_by: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewSource {
    pub provider: String,
    #[serde(flatten)]
    pub fields: SourceFields,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SourceFields {
    pub name: String,
    #[serde(default)]
    pub config: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
}

fn sealing_scope(id: &str) -> String {
    format!("package-source:{id}")
}

fn collection(state: &AppState) -> mongodb::Collection<bson::Document> {
    state.collections.raw(db::PACKAGE_SOURCES)
}

fn validate_fields(fields: &SourceFields) -> AppResult<()> {
    let name = fields.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(AppError::bad_request(format!(
            "a source needs a name of 1 to {MAX_NAME_CHARS} characters"
        )));
    }
    let size = serde_json::to_vec(&fields.config).map(|bytes| bytes.len()).unwrap_or(usize::MAX);
    if size > MAX_CONFIG_BYTES {
        return Err(AppError::bad_request(format!(
            "a source's settings may take at most {MAX_CONFIG_BYTES} bytes"
        )));
    }
    if fields.secrets.len() > MAX_SECRETS {
        return Err(AppError::bad_request(format!(
            "a source may keep at most {MAX_SECRETS} secrets"
        )));
    }
    for (key, value) in &fields.secrets {
        if validate_source_id(key).is_err() {
            return Err(AppError::bad_request(format!(
                "`{key}` is not a secret name: use letters, digits, `-`, `_`, `.` or `:`"
            )));
        }
        if value.len() > MAX_SECRET_BYTES {
            return Err(AppError::bad_request(format!(
                "secret `{key}` is over {MAX_SECRET_BYTES} bytes"
            )));
        }
    }
    Ok(())
}

fn opened(state: &AppState, row: &bson::Document) -> AppResult<Option<SourceView>> {
    let Some(mut source) = view(row) else {
        return Ok(None);
    };
    let Ok(sealed) = row.get_document("secrets") else {
        return Ok(Some(source));
    };
    let cipher = cipher(&state.config).map_err(AppError::from)?;
    let scope = sealing_scope(&source.id);
    for (key, value) in sealed {
        let value: SealedValue =
            bson::from_bson(value.clone()).map_err(|error| AppError::Internal(error.into()))?;
        source
            .secrets
            .insert(key.clone(), cipher.open(&scope, key, &value).map_err(AppError::from)?);
    }
    Ok(Some(source))
}

fn view(row: &bson::Document) -> Option<SourceView> {
    let config = row
        .get_document("config")
        .ok()
        .and_then(|config| serde_json::to_value(config).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    Some(SourceView {
        id: row.get_str("_id").ok()?.to_string(),
        provider: row.get_str("provider").ok()?.to_string(),
        name: row.get_str("name").ok()?.to_string(),
        config,
        secrets: BTreeMap::new(),
        updated_at: row
            .get_datetime("updated_at")
            .map(|at| Timestamp::from(*at).to_rfc3339())
            .unwrap_or_default(),
        updated_by: row.get_str("updated_by").ok().map(str::to_string),
    })
}

pub async fn list(state: &AppState) -> AppResult<Vec<SourceView>> {
    let rows: Vec<bson::Document> = collection(state)
        .find(bson::doc! {})
        .sort(bson::doc! { "name": 1 })
        .await?
        .try_collect()
        .await?;
    let mut sources = Vec::with_capacity(rows.len());
    for row in &rows {
        if let Some(source) = opened(state, row)? {
            sources.push(source);
        }
    }
    Ok(sources)
}

pub async fn get(state: &AppState, id: &str) -> AppResult<SourceView> {
    let row = collection(state)
        .find_one(bson::doc! { "_id": id })
        .await?
        .ok_or(AppError::NotFound("package source"))?;
    opened(state, &row)?.ok_or(AppError::NotFound("package source"))
}

fn seal_secrets(
    state: &AppState,
    id: &str,
    submitted: &BTreeMap<String, String>,
) -> AppResult<bson::Document> {
    let cipher = cipher(&state.config).map_err(AppError::from)?;
    let scope = sealing_scope(id);
    let mut sealed = bson::Document::new();
    for (key, value) in submitted {
        if value.is_empty() {
            continue;
        }
        let value = cipher.seal(&scope, key, value).map_err(AppError::from)?;
        sealed.insert(
            key.clone(),
            bson::to_bson(&value).map_err(|error| AppError::Internal(error.into()))?,
        );
    }
    Ok(sealed)
}

fn config_document(config: &serde_json::Map<String, serde_json::Value>) -> AppResult<bson::Document> {
    bson::to_document(config).map_err(|error| AppError::bad_request(format!("settings: {error}")))
}

pub async fn create(state: &AppState, input: NewSource, actor: &Actor) -> AppResult<SourceView> {
    validate_source_id(&input.provider)?;
    validate_fields(&input.fields)?;
    if collection(state).count_documents(bson::doc! {}).await? >= MAX_SOURCES {
        return Err(AppError::conflict(format!(
            "there are already {MAX_SOURCES} package sources"
        )));
    }
    let id = new_id();
    let now = Timestamp::now().to_bson();
    let document = bson::doc! {
        "_id": &id,
        "provider": &input.provider,
        "name": input.fields.name.trim(),
        "config": config_document(&input.fields.config)?,
        "secrets": seal_secrets(state, &id, &input.fields.secrets)?,
        "created_at": now,
        "updated_at": now,
        "updated_by": actor.user_id().map(str::to_string),
    };
    collection(state).insert_one(document).await?;
    get(state, &id).await
}

pub async fn update(
    state: &AppState,
    id: &str,
    fields: SourceFields,
    actor: &Actor,
) -> AppResult<SourceView> {
    validate_fields(&fields)?;
    let secrets = seal_secrets(state, id, &fields.secrets)?;
    let updated = collection(state)
        .update_one(
            bson::doc! { "_id": id },
            bson::doc! { "$set": {
                "name": fields.name.trim(),
                "config": config_document(&fields.config)?,
                "secrets": secrets,
                "updated_at": Timestamp::now().to_bson(),
                "updated_by": actor.user_id().map(str::to_string),
            }},
        )
        .await?;
    if updated.matched_count == 0 {
        return Err(AppError::NotFound("package source"));
    }
    get(state, id).await
}

pub async fn delete(state: &AppState, id: &str) -> AppResult<()> {
    let removed = collection(state).delete_one(bson::doc! { "_id": id }).await?;
    if removed.deleted_count == 0 {
        return Err(AppError::NotFound("package source"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_are_bounded() {
        let fields = |name: &str| SourceFields {
            name: name.to_string(),
            config: serde_json::Map::new(),
            secrets: BTreeMap::new(),
        };
        assert!(validate_fields(&fields("Work GitLab")).is_ok());
        assert!(validate_fields(&fields("  ")).is_err());
        assert!(validate_fields(&fields(&"x".repeat(MAX_NAME_CHARS + 1))).is_err());
        let mut bad_secret = fields("ok");
        bad_secret.secrets.insert("has space".to_string(), "v".to_string());
        assert!(validate_fields(&bad_secret).is_err());
    }
}

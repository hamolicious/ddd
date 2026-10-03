use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use bson::doc;

use crate::auth::{AdminUser, ClientMeta, audit};
use crate::error::AppResult;
use crate::plugininstall::package_sources::{self, NewSource, SourceFields, SourceView};
use crate::state::AppState;

pub const TARGET_PACKAGE_SOURCE: &str = "package_source";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(list).post(create))
        .route("/{id}", put(update).delete(remove))
}

async fn list(State(state): State<AppState>, _admin: AdminUser) -> AppResult<Json<Vec<SourceView>>> {
    Ok(Json(package_sources::list(&state).await?))
}

async fn create(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Json(input): Json<NewSource>,
) -> AppResult<(StatusCode, Json<SourceView>)> {
    let created = package_sources::create(&state, input, &admin.actor()).await?;
    audit::record(
        &state,
        "package_source.create",
        Some(&admin.actor()),
        TARGET_PACKAGE_SOURCE,
        Some(created.id.clone()),
        doc! { "provider": &created.provider, "name": &created.name },
        meta.ip.clone(),
    )
    .await;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn update(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Path(id): Path<String>,
    Json(fields): Json<SourceFields>,
) -> AppResult<Json<SourceView>> {
    let updated = package_sources::update(&state, &id, fields, &admin.actor()).await?;
    audit::record(
        &state,
        "package_source.update",
        Some(&admin.actor()),
        TARGET_PACKAGE_SOURCE,
        Some(id),
        doc! { "provider": &updated.provider, "name": &updated.name },
        meta.ip.clone(),
    )
    .await;
    Ok(Json(updated))
}

async fn remove(
    State(state): State<AppState>,
    admin: AdminUser,
    meta: ClientMeta,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    package_sources::delete(&state, &id).await?;
    audit::record(
        &state,
        "package_source.delete",
        Some(&admin.actor()),
        TARGET_PACKAGE_SOURCE,
        Some(id),
        doc! {},
        meta.ip.clone(),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

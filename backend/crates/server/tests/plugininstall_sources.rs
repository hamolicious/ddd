mod common;

use std::collections::BTreeMap;

use ddd_server::db;
use ddd_server::domain::{Actor, new_id};
use ddd_server::plugininstall::package_sources::{self, NewSource, SourceFields};
use ddd_server::state::AppState;

async fn start() -> Option<AppState> {
    let uri = common::mongo_uri()?;
    let config = common::test_config(uri, format!("ddd_sources_test_{}", new_id()));
    let state = AppState::new(config).await.ok()?;
    state.init_schema().await.ok()?;
    Some(state)
}

fn fields(name: &str, token: &str) -> SourceFields {
    let mut config = serde_json::Map::new();
    config.insert("instance".into(), "https://gitlab.example.com".into());
    config.insert("project".into(), "tools/ddd-plugins".into());
    let mut secrets = BTreeMap::new();
    secrets.insert("token".to_string(), token.to_string());
    SourceFields {
        name: name.to_string(),
        config,
        secrets,
    }
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_saved_source_keeps_its_token_sealed_and_hands_it_back_to_admins() {
    let Some(state) = start().await else {
        return;
    };
    let admin = Actor::User(new_id());

    let created = package_sources::create(
        &state,
        NewSource {
            provider: "gitlab".to_string(),
            fields: fields("Work GitLab", "glpat-first"),
        },
        &admin,
    )
    .await
    .expect("creates");
    assert_eq!(created.provider, "gitlab");
    assert_eq!(created.name, "Work GitLab");
    assert_eq!(created.config["project"], "tools/ddd-plugins");
    assert_eq!(created.secrets["token"], "glpat-first");

    let stored = state
        .collections
        .raw(db::PACKAGE_SOURCES)
        .find_one(bson::doc! { "_id": &created.id })
        .await
        .expect("reads")
        .expect("exists");
    assert!(
        !stored.to_string().contains("glpat-first"),
        "the token is stored in the clear: {stored}"
    );

    let updated = package_sources::update(&state, &created.id, fields("Renamed", "glpat-second"), &admin)
        .await
        .expect("updates");
    assert_eq!(updated.name, "Renamed");
    assert_eq!(updated.secrets["token"], "glpat-second");

    let listed = package_sources::list(&state).await.expect("lists");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].secrets["token"], "glpat-second");

    let cleared = package_sources::update(&state, &created.id, fields("Renamed", ""), &admin)
        .await
        .expect("clears the token");
    assert!(cleared.secrets.is_empty());

    package_sources::delete(&state, &created.id).await.expect("deletes");
    assert!(package_sources::list(&state).await.expect("lists").is_empty());
    assert!(package_sources::delete(&state, &created.id).await.is_err());
    assert!(
        package_sources::update(&state, &created.id, fields("Gone", ""), &admin)
            .await
            .is_err()
    );

    let _ = state.db.drop().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_source_needs_a_provider_id_and_a_name() {
    let Some(state) = start().await else {
        return;
    };
    let admin = Actor::User(new_id());
    for (provider, name) in [("has space", "Ok"), ("gitlab", "  ")] {
        let refused = package_sources::create(
            &state,
            NewSource {
                provider: provider.to_string(),
                fields: fields(name, "t"),
            },
            &admin,
        )
        .await;
        assert!(refused.is_err(), "{provider:?} {name:?} was accepted");
    }
    let _ = state.db.drop().await;
}

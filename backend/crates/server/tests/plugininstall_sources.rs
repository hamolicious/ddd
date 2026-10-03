mod common;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use axum::Router;
use axum::extract::Path as AxumPath;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use ddd_server::config::Config;
use ddd_server::domain::new_id;
use ddd_server::error::AppError;
use ddd_server::plugininstall::InstallSource;
use ddd_server::plugininstall::sources::{self, PackageSource, RemoteLookup, RemotePackage};

const TOKEN: &str = "glpat-test-token";
const PACKAGE: &[u8] = b"PK\x03\x04 not really a zip, staging does not look inside";

async fn serve(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a port");
    let address = listener.local_addr().expect("an address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    address
}

fn holds_token(headers: &HeaderMap) -> bool {
    headers.get("private-token").and_then(|value| value.to_str().ok()) == Some(TOKEN)
}

async fn registry() -> SocketAddr {
    let storage = serve(Router::new().route(
        "/blob/{name}",
        get(|headers: HeaderMap| async move {
            if headers.contains_key("private-token") {
                return (StatusCode::BAD_REQUEST, "a token leaked across origins").into_response();
            }
            PACKAGE.into_response()
        }),
    ))
    .await;

    serve(
        Router::new()
            .route(
                "/packages/{name}",
                get(|headers: HeaderMap| async move {
                    if !holds_token(&headers) {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    PACKAGE.into_response()
                }),
            )
            .route(
                "/api/packages",
                get(|| async { axum::Json(serde_json::json!([{ "version": "1.3.0" }])) }),
            )
            .route(
                "/stored/{name}",
                get(move |headers: HeaderMap, AxumPath(name): AxumPath<String>| async move {
                    if !holds_token(&headers) {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    Response::builder()
                        .status(StatusCode::FOUND)
                        .header(header::LOCATION, format!("http://{storage}/blob/{name}"))
                        .body(axum::body::Body::empty())
                        .expect("a redirect")
                        .into_response()
                }),
            ),
    )
    .await
}

fn config(staging: &Path, allow_loopback: bool) -> Config {
    let mut config = common::test_config("mongodb://unused".to_string(), "unused".to_string());
    config.plugin_staging_dir = staging.to_path_buf();
    config.plugin_http_allow_cidrs = if allow_loopback {
        vec!["127.0.0.0/8".parse().expect("a cidr")]
    } else {
        Vec::new()
    };
    config
}

fn staging() -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("sources-{}", new_id()));
    std::fs::create_dir_all(&dir).expect("a staging root");
    dir
}

fn staged_files(staging: &Path) -> usize {
    std::fs::read_dir(staging.join("uploads"))
        .map(|entries| entries.count())
        .unwrap_or(0)
}

fn request(url: String, token: Option<&str>) -> RemotePackage {
    let mut headers = BTreeMap::new();
    if let Some(token) = token {
        headers.insert("PRIVATE-TOKEN".to_string(), token.to_string());
    }
    RemotePackage {
        url,
        headers,
        via: "gitlab".to_string(),
    }
}

#[tokio::test]
async fn a_remote_package_is_downloaded_into_staging_with_its_origin_recorded() {
    let upstream = registry().await;
    let dir = staging();

    let staged = request(
        format!("http://{upstream}/packages/tasks-1.2.0.zip?ref=main"),
        Some(TOKEN),
    )
    .stage(&config(&dir, true))
    .await
    .unwrap_or_else(|error| panic!("downloads: {error}"));

    assert_eq!(std::fs::read(&staged.archive).expect("staged"), PACKAGE);
    assert!(staged.archive.starts_with(dir.join("uploads")));
    assert_eq!(
        staged.source,
        InstallSource::Remote {
            url: format!("http://{upstream}/packages/tasks-1.2.0.zip"),
            via: "gitlab".to_string(),
            authenticated: true,
        }
    );
    assert!(staged.source.archive_is_staged_copy());

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_refused_download_says_why_and_leaves_nothing_staged() {
    let upstream = registry().await;
    let dir = staging();

    let Err(error) = request(format!("http://{upstream}/packages/tasks.zip"), None)
        .stage(&config(&dir, true))
        .await
    else {
        panic!("a download without the token succeeded");
    };
    assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
    assert!(error.to_string().contains("401"), "{error}");
    assert_eq!(staged_files(&dir), 0);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_redirect_to_another_origin_does_not_carry_the_token() {
    let upstream = registry().await;
    let dir = staging();

    let staged = request(format!("http://{upstream}/stored/tasks.zip"), Some(TOKEN))
        .stage(&config(&dir, true))
        .await
        .unwrap_or_else(|error| panic!("follows the redirect: {error}"));
    assert_eq!(std::fs::read(&staged.archive).expect("staged"), PACKAGE);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn private_addresses_are_refused_unless_the_operator_allows_them() {
    let upstream = registry().await;
    let dir = staging();

    let Err(error) = request(format!("http://{upstream}/packages/tasks.zip"), Some(TOKEN))
        .stage(&config(&dir, false))
        .await
    else {
        panic!("a loopback download went through without PLUGIN_HTTP_ALLOW_CIDRS");
    };
    assert!(error.to_string().contains("PLUGIN_HTTP_ALLOW_CIDRS"), "{error}");
    assert_eq!(staged_files(&dir), 0);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_lookup_returns_the_status_and_the_json_body() {
    let upstream = registry().await;
    let dir = staging();
    let config = config(&dir, true);

    let found = sources::lookup(
        &config,
        RemoteLookup {
            url: format!("http://{upstream}/api/packages"),
            headers: BTreeMap::new(),
        },
    )
    .await
    .unwrap_or_else(|error| panic!("looks up: {error}"));
    assert_eq!(found.status, 200);
    assert_eq!(found.body, serde_json::json!([{ "version": "1.3.0" }]));

    let refused = sources::lookup(
        &config,
        RemoteLookup {
            url: format!("http://{upstream}/packages/x.zip"),
            headers: BTreeMap::new(),
        },
    )
    .await
    .unwrap_or_else(|error| panic!("a refusal is an answer, not an error: {error}"));
    assert_eq!(refused.status, 401);
    assert_eq!(refused.body, serde_json::Value::Null);

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_anonymous_download_is_recorded_as_checkable_for_updates() {
    let upstream = registry().await;
    let dir = staging();
    let staged = request(format!("http://{upstream}/stored/x.zip"), None)
        .stage(&config(&dir, true))
        .await;
    assert!(staged.is_err(), "the registry needs the token for this path");

    let mut anonymous = request(format!("http://{upstream}/api/packages"), None);
    anonymous.via = "gitlab".to_string();
    let staged = anonymous
        .stage(&config(&dir, true))
        .await
        .unwrap_or_else(|error| panic!("downloads: {error}"));
    assert!(matches!(
        staged.source,
        InstallSource::Remote { authenticated: false, .. }
    ));

    let _ = std::fs::remove_dir_all(&dir);
}

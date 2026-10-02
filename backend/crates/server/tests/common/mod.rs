#![allow(dead_code)]

use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Request, StatusCode, header};
use ddd_core::date::Date;
use ddd_core::filter::ast::{Filter, SortKey};
use ddd_core::filter::evaluator::{self, Row};
use ddd_core::value::{Map, Value};
use ddd_server::config::{Config, LogFormat, SessionSecret};
use ddd_server::domain::{DocumentView, new_id};
use ddd_server::state::AppState;
use ddd_server::{routes, telemetry};
use serde_json::{Value as Json, json};
use tower::ServiceExt as _;

pub const TEST_PASSWORD: &str = "correct-horse-battery";

pub fn mongo_uri() -> Option<String> {
    std::env::var("MONGO_URI")
        .ok()
        .map(|uri| uri.trim().to_string())
        .filter(|uri| !uri.is_empty())
}

pub fn test_config(mongo_uri: String, database: String) -> Config {
    Config {
        mongo_uri,
        bind_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
        session_secret: SessionSecret::new(vec![7u8; 48]).expect("48 bytes is enough"),
        mongo_database: database,
        max_attachment_bytes: 1024 * 1024,
        max_document_bytes: 64 * 1024,
        app_origins: vec!["http://localhost:5173".to_string()],
        public_url: None,
        log_format: LogFormat::Pretty,
        cookie_secure: false,
        trust_proxy_headers: false,
        trash_retention_days: 3,
        checkpoint_every_changes: 3,
        raw_change_days: 30,
        history_squash_interval: Duration::from_secs(3600),
        invite_ttl_days: 7,
        session_idle_days: 30,
        session_absolute_days: 180,
        materialize_debounce: Duration::from_millis(50),
        room_idle_timeout: Duration::from_secs(30),
        update_log_keep_bytes: 4096,
        update_log_keep_count: 5,
        crdt_compact_threshold_bytes: 128 * 1024,
        crdt_alert_threshold_bytes: 256 * 1024,
        login_max_attempts: 50,
        login_attempt_window: Duration::from_secs(60),
        shutdown_grace: Duration::from_secs(5),
        web_dist_dir: None,
        plugins_dir: std::path::PathBuf::from("target/test-plugins-empty"),
        kernel_dts_path: None,
        disable_plugins: false,
        plugin_staging_dir: std::path::PathBuf::from("target/test-plugins-staging"),
        plugin_inbox_dir: None,
        plugin_config_key: None,
        plugin_call_timeout: Duration::from_millis(2_000),
        plugin_cron_timeout: Duration::from_millis(5_000),
        plugin_memory_bytes: 32 * 1024 * 1024,
        plugin_max_instances: 2,
        plugin_breaker_threshold: 3,
        plugin_http_timeout: Duration::from_millis(1_000),
        plugin_http_max_response_bytes: 1024 * 1024,
        plugin_http_allow_cidrs: Vec::new(),
        plugin_enable_cron: false,
    }
}

pub struct ApiResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl ApiResponse {
    pub fn text(&self) -> &str {
        std::str::from_utf8(&self.body).expect("response body is not UTF-8")
    }

    pub fn json(&self) -> Json {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|err| panic!("body is not JSON ({err}): {}", self.text()))
    }

    pub fn error_code(&self) -> String {
        self.json()["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    pub fn expect_status(&self, expected: StatusCode) -> &Self {
        assert_eq!(
            self.status,
            expected,
            "unexpected status; body was {}",
            self.text()
        );
        self
    }
}

pub struct TestApp {
    pub router: Router,
    pub state: AppState,
    pub token: String,
    pub user_id: String,
    pub database: String,
    client: mongodb::Client,
}

impl TestApp {
    pub async fn start() -> Option<TestApp> {
        let uri = mongo_uri()?;
        let database = format!("ddd_router_test_{}", new_id());
        let config = test_config(uri.clone(), database.clone());

        let client = mongodb::Client::with_uri_str(&uri).await.ok()?;
        let state = AppState::new(config.clone()).await.ok()?;
        state.init_schema().await.ok()?;
        let metrics = telemetry::init_metrics(&config).ok()?;
        let router = routes::router(state.clone(), metrics);

        let mut app = TestApp {
            router,
            state,
            token: String::new(),
            user_id: String::new(),
            database,
            client,
        };

        let response = app
            .post_json(
                "/api/auth/register",
                json!({
                    "email": "first@example.com",
                    "password": TEST_PASSWORD,
                    "bearer": true,
                }),
            )
            .await;
        response.expect_status(StatusCode::OK);
        let body = response.json();
        app.token = body["token"]
            .as_str()
            .expect("register returns a bearer token")
            .to_string();
        app.user_id = body["user"]["id"].as_str().unwrap_or_default().to_string();

        Some(app)
    }

    pub async fn cleanup(self) {
        let _ = self.client.database(&self.database).drop().await;
    }

    pub async fn send(&self, request: Request<Body>) -> ApiResponse {
        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("the router is infallible");
        let status = response.status();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), 32 * 1024 * 1024)
            .await
            .expect("reading the response body");
        ApiResponse {
            status,
            headers,
            body,
        }
    }

    pub async fn request_as(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Json>,
    ) -> ApiResponse {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token.filter(|token| !token.is_empty()) {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let request = match body {
            Some(body) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => builder.body(Body::empty()),
        }
        .expect("valid request");
        self.send(request).await
    }

    pub async fn anonymous(&self, method: &str, uri: &str, body: Option<Json>) -> ApiResponse {
        self.request_as(method, uri, None, body).await
    }

    pub async fn get(&self, uri: &str) -> ApiResponse {
        self.request_as("GET", uri, Some(&self.token), None).await
    }

    pub async fn delete(&self, uri: &str) -> ApiResponse {
        self.request_as("DELETE", uri, Some(&self.token), None)
            .await
    }

    pub async fn post_json(&self, uri: &str, body: Json) -> ApiResponse {
        self.request_as("POST", uri, Some(&self.token), Some(body))
            .await
    }

    pub async fn put_json(&self, uri: &str, body: Json) -> ApiResponse {
        self.request_as("PUT", uri, Some(&self.token), Some(body))
            .await
    }

    pub async fn patch_json(&self, uri: &str, body: Json) -> ApiResponse {
        self.request_as("PATCH", uri, Some(&self.token), Some(body))
            .await
    }

    pub async fn create_document(&self, text: &str) -> String {
        let response = self
            .post_json("/api/documents", json!({ "content": text }))
            .await;
        response.expect_status(StatusCode::CREATED);
        response.json()["id"]
            .as_str()
            .expect("the created document carries its id")
            .to_string()
    }

    pub async fn list(&self, query: &str) -> ListPage {
        let uri = if query.is_empty() {
            "/api/documents".to_string()
        } else {
            format!("/api/documents?{query}")
        };
        let response = self.get(&uri).await;
        response.expect_status(StatusCode::OK);
        let raw = response.text().to_string();
        let page: ListPage = serde_json::from_str(&raw)
            .unwrap_or_else(|err| panic!("list response did not deserialize ({err}): {raw}"));
        ListPage { raw, ..page }
    }

    pub async fn list_all_pages(&self, query: &str, page_size: u32) -> Vec<String> {
        let mut ids = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..64 {
            let mut uri = format!("{query}&limit={page_size}");
            if let Some(cursor) = &cursor {
                uri.push_str(&format!("&cursor={cursor}"));
            }
            let page = self.list(uri.trim_start_matches('&')).await;
            ids.extend(page.documents.iter().map(|doc| doc.id.clone()));
            match page.next_cursor {
                Some(next) => cursor = Some(next),
                None => return ids,
            }
        }
        panic!("pagination did not terminate after 64 pages");
    }
}

#[derive(Debug, Default, serde::Deserialize)]
pub struct ListPage {
    pub documents: Vec<DocumentView>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(skip)]
    pub raw: String,
}

impl ListPage {
    pub fn ids(&self) -> Vec<String> {
        self.documents.iter().map(|doc| doc.id.clone()).collect()
    }
}

#[derive(Clone)]
pub struct LocalRow {
    pub id: String,
    pub title: String,
    pub content: String,
    pub fm: Map,
    pub plugins: Map,
    pub created_at: Option<Date>,
    pub updated_at: Option<Date>,
    pub deleted_at: Option<Date>,
    pub deleted: bool,
}

impl LocalRow {
    pub fn from_view(view: &DocumentView) -> Self {
        Self {
            id: view.id.clone(),
            title: view.title.clone(),
            content: view.content.clone(),
            fm: json_to_map(&view.fm),
            plugins: json_to_map(&view.plugins),
            created_at: Date::from_epoch_millis(view.created_at.timestamp_millis()).ok(),
            updated_at: Date::from_epoch_millis(view.updated_at.timestamp_millis()).ok(),
            deleted_at: view
                .deleted_at
                .and_then(|at| Date::from_epoch_millis(at.timestamp_millis()).ok()),
            deleted: view.deleted,
        }
    }

    pub fn as_row(&self) -> Row<'_> {
        Row {
            id: &self.id,
            title: &self.title,
            content: &self.content,
            fm: &self.fm,
            plugins: &self.plugins,
            created_at: self.created_at.as_ref(),
            updated_at: self.updated_at.as_ref(),
            deleted_at: self.deleted_at.as_ref(),
            deleted: self.deleted,
        }
    }
}

pub fn json_to_map(value: &Json) -> Map {
    match Value::from_json(value) {
        Value::Map(map) => map,
        _ => Map::new(),
    }
}

pub fn evaluate_ids(filter: &Filter, rows: &[LocalRow]) -> Vec<String> {
    rows.iter()
        .filter(|row| evaluator::evaluate(filter, &row.as_row()).unwrap_or(false))
        .map(|row| row.id.clone())
        .collect()
}

pub fn sorted_ids(sort: &[SortKey], rows: &[LocalRow]) -> Vec<String> {
    let mut ordered: Vec<&LocalRow> = rows.iter().collect();
    ordered.sort_by(|a, b| evaluator::compare_rows(&a.as_row(), &b.as_row(), sort));
    ordered.iter().map(|row| row.id.clone()).collect()
}

pub fn parse_filter(json: &str) -> Filter {
    Filter::from_json_str(json).unwrap_or_else(|err| panic!("test filter {json} is invalid: {err}"))
}

pub fn parse_sort(spec: &str) -> Vec<SortKey> {
    spec.split(',')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(|token| {
            SortKey::parse(token)
                .unwrap_or_else(|err| panic!("test sort {token} is invalid: {err}"))
        })
        .collect()
}

pub fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 3);
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn assert_no_extended_json(body: &str, what: &str) {
    for marker in ["\"$date\"", "\"$binary\"", "\"$oid\"", "\"$numberLong\""] {
        assert!(
            !body.contains(marker),
            "{what} leaked extended JSON ({marker}): {body}"
        );
    }
}

pub fn assert_rfc3339(value: &Json, what: &str) {
    let raw = value
        .as_str()
        .unwrap_or_else(|| panic!("{what} is not a string: {value}"));
    bson::DateTime::parse_rfc3339_str(raw)
        .unwrap_or_else(|err| panic!("{what} is not RFC 3339 ({err}): {raw}"));
}

//! `http_request` end to end: the host allowlist, the IP policy, resolve-then-pin, the
//! per-hop redirect re-check and the response cap — driven by a real plugin against a real
//! HTTP server (HOST-ABI.md §3.11, SPEC §6.2).
//!
//! This is the SSRF surface, so it is tested from the outside rather than by asserting about
//! `address_allowed` alone (which `pluginhost/host_fns.rs` already does exhaustively as a
//! unit). What only an end-to-end test can show:
//!
//! 1. **A host the manifest never declared is `blocked`, not `capability_denied`.** The
//!    difference is the whole diagnostic value of those two codes: one means *my manifest is
//!    wrong*, the other means *my URL is wrong*.
//! 2. **The IP policy runs after resolution, on the resolved address.** `localhost` is an
//!    allowed *name* here and still refused, because it resolves to loopback — which is the
//!    check a naive "is the host in the list" implementation skips entirely.
//! 3. **Every redirect hop repeats the check.** A 302 from an approved host to an
//!    unapproved one is refused at the second hop, because a redirect is a destination
//!    chosen by whoever we were just talking to.
//! 4. **A body over the cap is `too_large` and never truncated.** Half an ICS feed makes
//!    confidently wrong documents.
//! 5. **`set-cookie` never reaches a plugin** — a plugin does not run a cookie jar — while
//!    `authorization` on the way *out* is allowed, because outbound HTTP with secrets is the
//!    reason backend plugins exist.
//!
//! Loopback is refused by default, so the fixture server is reachable only because the test
//! sets `PLUGIN_HTTP_ALLOW_CIDRS` to `127.0.0.0/8` — which is exactly the operator escape
//! hatch SPEC §6.2 describes, exercised rather than assumed.
//!
//! ```text
//! docker compose up -d --wait mongo
//! mise run wasm-plugins
//! MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p life-manager-server --test pluginhost_http
//! ```

mod common;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::Path as AxumPath;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use life_manager_plugin_abi as abi;
use life_manager_server::domain::new_id;
use life_manager_server::pluginhost::{CallFailure, CallKind, Invocation, PluginHost};
use life_manager_server::plugininstall::InstallSource;
use life_manager_server::plugins::{
    PluginBackend, PluginCapabilities, PluginManifest, PluginRecord, PluginState,
};
use life_manager_server::state::AppState;
use serde_json::{Value, json};

fn fixture() -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../plugins/target/wasm32-unknown-unknown/release/hello_backend.wasm");
    path.exists().then_some(path)
}

// ---------------------------------------------------------------------------
// The upstream the plugin fetches from
// ---------------------------------------------------------------------------

/// A tiny HTTP server on loopback, with one route per thing worth checking.
async fn upstream() -> SocketAddr {
    let router = Router::new()
        .route(
            "/feed",
            get(|| async {
                (
                    [
                        (header::CONTENT_TYPE, "text/calendar"),
                        (header::ETAG, "W/\"abc\""),
                        // A plugin does not run a cookie jar: the host must drop this before
                        // the plugin ever sees it.
                        (header::SET_COOKIE, "upstream=tracking"),
                    ],
                    "BEGIN:VCALENDAR\nEND:VCALENDAR\n",
                )
            }),
        )
        .route(
            "/echo-headers",
            get(|headers: HeaderMap| async move {
                let seen: Vec<String> = headers
                    .iter()
                    .map(|(name, value)| {
                        format!("{}={}", name.as_str(), value.to_str().unwrap_or_default())
                    })
                    .collect();
                axum::Json(json!({ "headers": seen }))
            }),
        )
        .route(
            "/big/{bytes}",
            get(|AxumPath(bytes): AxumPath<usize>| async move { "x".repeat(bytes) }),
        )
        .route(
            "/redirect/{*target}",
            get(|AxumPath(target): AxumPath<String>| async move {
                // The target is a full URL, so a test can aim a redirect anywhere.
                Response::builder()
                    .status(StatusCode::FOUND)
                    .header(header::LOCATION, target)
                    .body(axum::body::Body::empty())
                    .expect("a valid redirect")
                    .into_response()
            }),
        )
        // The answer to a conditional GET: 3xx, no `Location`, no body. It is the whole
        // reason a plugin stores `ETag`/`Last-Modified` between runs.
        .route(
            "/not-modified",
            get(|| async {
                Response::builder()
                    .status(StatusCode::NOT_MODIFIED)
                    .header(header::ETAG, "W/\"abc\"")
                    .body(axum::body::Body::empty())
                    .expect("a valid 304")
                    .into_response()
            }),
        )
        .route(
            "/slow",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                "never"
            }),
        );

    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .expect("a loopback port");
    let address = listener.local_addr().expect("the bound address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    address
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct HttpHarness {
    state: AppState,
    host: Arc<PluginHost>,
    upstream: SocketAddr,
    plugins_dir: PathBuf,
    client: mongodb::Client,
    database: String,
}

impl HttpHarness {
    /// `approved_hosts` is what an admin approved; `allow_loopback` is the operator's CIDR
    /// escape hatch. Both are parameters because the interesting cases are the combinations.
    async fn start(approved_hosts: &[&str], allow_loopback: bool) -> Option<HttpHarness> {
        let uri = common::mongo_uri()?;
        let wasm = fixture()?;
        let upstream = upstream().await;

        let database = format!("lm_pluginhttp_test_{}", new_id());
        let plugins_dir = std::env::temp_dir().join(format!("lm-pluginhttp-{database}"));
        let dir = plugins_dir.join("hello-backend").join("1.0.0");
        std::fs::create_dir_all(&dir).expect("a temp plugin directory");
        std::fs::copy(&wasm, dir.join("backend.wasm")).expect("copy the fixture");

        let mut config = common::test_config(uri.clone(), database.clone());
        config.plugins_dir = plugins_dir.clone();
        config.plugin_call_timeout = Duration::from_millis(3_000);
        config.plugin_http_timeout = Duration::from_millis(1_200);
        config.plugin_http_max_response_bytes = 4 * 1024;
        if allow_loopback {
            // The one deliberate widening: this is how a self-hosted LAN service becomes
            // reachable (SPEC §6.2's "admin-configurable allowlist").
            config.plugin_http_allow_cidrs = vec!["127.0.0.0/8".parse().expect("a literal CIDR")];
        }

        let client = mongodb::Client::with_uri_str(&uri).await.ok()?;
        let state = AppState::new(config).await.ok()?;
        state.init_schema().await.ok()?;

        let capabilities = PluginCapabilities {
            http: Some(life_manager_server::plugins::HttpCapability {
                hosts: approved_hosts
                    .iter()
                    .map(|host| (*host).to_string())
                    .collect(),
            }),
            ..PluginCapabilities::default()
        };
        let record = PluginRecord {
            id: "hello-backend".to_string(),
            version: "1.0.0".to_string(),
            state: PluginState::Enabled,
            manifest: PluginManifest {
                id: "hello-backend".to_string(),
                version: "1.0.0".to_string(),
                kernel: "^1.0".to_string(),
                dependencies: BTreeMap::new(),
                peer_libraries: BTreeMap::new(),
                frontend: None,
                capabilities: capabilities.clone(),
                config: BTreeMap::new(),
                backend: Some(PluginBackend {
                    module: "backend.wasm".to_string(),
                    hooks: Vec::new(),
                    cron: Vec::new(),
                    routes: Vec::new(),
                    events: Vec::new(),
                }),
                name: None,
                description: None,
                author: None,
                license: None,
                provides: BTreeMap::new(),
                consumes: BTreeMap::new(),
                hot: false,
                extra: BTreeMap::new(),
            },
            capabilities_approved: capabilities,
            source: InstallSource::Base,
            installed_at: life_manager_server::domain::Timestamp::now(),
            installed_by: None,
            approved_at: None,
            approved_by: None,
            disabled_reason: None,
            last_error: None,
            module_sha256: Some("test-fixture".to_string()),
            cron_state: Vec::new(),
        };

        let host = PluginHost::get(&state);
        host.activate(&state, &record)
            .await
            .expect("the fixture activates");

        Some(HttpHarness {
            state,
            host,
            upstream,
            plugins_dir,
            client,
            database,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.upstream)
    }

    /// The same URL through the name `localhost` rather than the literal address, so the
    /// *resolver* path is the one under test.
    fn localhost_url(&self, path: &str) -> String {
        format!("http://localhost:{}{path}", self.upstream.port())
    }

    async fn fetch(&self, url: &str, headers: Value) -> Result<Option<Value>, CallFailure> {
        let invocation = Invocation::top_level(
            "hello-backend",
            CallKind::Invoked {
                caller: "test".to_string(),
                function: "fetch".to_string(),
            },
            json!({ "url": url, "headers": headers }),
            self.host.limits(),
        );
        self.host.call_typed::<Value>(&self.state, invocation).await
    }

    async fn cleanup(self) {
        self.host.shutdown(Duration::from_secs(2)).await;
        let _ = self.client.database(&self.database).drop().await;
        let _ = std::fs::remove_dir_all(&self.plugins_dir);
    }
}

fn refusal(result: Result<Option<Value>, CallFailure>) -> abi::HostError {
    match result {
        Err(CallFailure::Refused(error)) => error,
        Ok(value) => panic!("expected a refusal, got {value:?}"),
        Err(other) => panic!("expected a refusal, got a host failure: {other}"),
    }
}

fn skip() -> bool {
    if common::mongo_uri().is_none() {
        eprintln!("skipping: MONGO_URI is not set");
        return true;
    }
    if fixture().is_none() {
        eprintln!("skipping: run `mise run wasm-plugins` to build the hello-backend fixture");
        return true;
    }
    false
}

macro_rules! harness {
    ($hosts:expr, $loopback:expr) => {
        match HttpHarness::start($hosts, $loopback).await {
            Some(harness) => harness,
            None => return,
        }
    };
}

// ---------------------------------------------------------------------------
// The happy path, and what the host strips on the way back
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_approved_host_on_a_deliberately_allowed_cidr_is_reachable() {
    if skip() {
        return;
    }
    let harness = harness!(&["127.0.0.1"], true);

    let answer = harness
        .fetch(&harness.url("/feed"), json!({}))
        .await
        .expect("the fetch succeeds")
        .expect("a value");
    assert_eq!(answer["status"], json!(200));
    assert!(
        answer["body"]
            .as_str()
            .unwrap_or_default()
            .contains("BEGIN:VCALENDAR")
    );
    assert_eq!(
        answer["body_bytes"].as_u64(),
        answer["body"].as_str().map(|body| body.len() as u64),
        "the reported byte count is the body the plugin received"
    );

    // A header the plugin is meant to see.
    assert_eq!(answer["headers"]["etag"], json!("W/\"abc\""));
    // And the one it must not: a plugin does not run a cookie jar.
    assert!(
        answer["headers"].get("set-cookie").is_none(),
        "set-cookie reached the plugin: {}",
        answer["headers"]
    );

    harness.cleanup().await;
}

/// `authorization` is allowed on the way out — that is the point of the feature (SPEC §6.3:
/// outbound HTTP with secrets) — while `host` is refused, because a request that names one
/// host in the URL and another in the header would pass the allowlist and arrive elsewhere.
#[tokio::test]
async fn authorization_goes_out_and_host_is_refused() {
    if skip() {
        return;
    }
    let harness = harness!(&["127.0.0.1"], true);

    let answer = harness
        .fetch(
            &harness.url("/echo-headers"),
            json!({ "authorization": "Bearer feed-secret", "accept": "application/json" }),
        )
        .await
        .expect("the fetch succeeds")
        .expect("a value");
    let body = answer["body"].as_str().expect("a body");
    assert!(
        body.contains("authorization=Bearer feed-secret"),
        "the secret should have reached the upstream: {body}"
    );

    let refused = refusal(
        harness
            .fetch(
                &harness.url("/echo-headers"),
                json!({ "host": "calendar.google.com" }),
            )
            .await,
    );
    assert_eq!(refused.code, abi::ErrorCode::InvalidArgument);

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// The allowlist and the IP policy
// ---------------------------------------------------------------------------

/// `capability_denied` means *the manifest never asked for `http`*; `blocked` means it did
/// and **this destination** is refused. Collapsing the two is the single most confusing thing
/// this ABI could do to a plugin author, so both are asserted here.
#[tokio::test]
async fn an_undeclared_host_is_blocked_and_no_http_at_all_is_capability_denied() {
    if skip() {
        return;
    }

    // Approved for one host: a different one is `blocked`.
    let harness = harness!(&["127.0.0.1"], true);
    let blocked = refusal(harness.fetch("http://example.test/feed", json!({})).await);
    assert_eq!(blocked.code, abi::ErrorCode::Blocked);
    assert_eq!(
        blocked.detail.as_ref().and_then(|d| d["host"].as_str()),
        Some("example.test")
    );
    // Not a plugin *failure* either — a wrong URL must not disable a plugin.
    assert_eq!(harness.host.breaker_state("hello-backend").failures(), 0);
    harness.cleanup().await;

    // Approved for nothing at all: `capability_denied`, and the plugin can probe for it.
    let none = harness!(&[], true);
    let denied = refusal(none.fetch("http://example.test/feed", json!({})).await);
    assert_eq!(denied.code, abi::ErrorCode::CapabilityDenied);
    none.cleanup().await;
}

/// The check that a naive implementation skips: the name is in the list, and the **address
/// it resolves to** is still refused. Without the operator's CIDR there is no way to reach
/// loopback, whatever the host list says.
#[tokio::test]
async fn an_approved_name_that_resolves_to_a_refused_address_is_still_blocked() {
    if skip() {
        return;
    }
    // `localhost` approved, loopback **not** in the CIDR allowlist.
    let harness = harness!(&["localhost"], false);

    let blocked = refusal(
        harness
            .fetch(&harness.localhost_url("/feed"), json!({}))
            .await,
    );
    assert_eq!(
        blocked.code,
        abi::ErrorCode::Blocked,
        "the resolved address is the thing that is checked"
    );
    let detail = blocked.detail.as_ref().expect("a detail");
    assert_eq!(detail["host"], json!("localhost"));
    assert!(
        detail["address"]
            .as_str()
            .unwrap_or_default()
            .starts_with("127.")
            || detail["address"] == json!("::1"),
        "the refusal names the address it resolved to: {detail}"
    );

    // And the literal form of the same address is refused too, so there is no shortcut
    // around the resolver.
    let literal = refusal(harness.fetch(&harness.url("/feed"), json!({})).await);
    assert_eq!(literal.code, abi::ErrorCode::Blocked);

    harness.cleanup().await;
}

/// A scheme a plugin may not request. `file:` is the interesting one — it is what an SSRF
/// attempt reaches for after the host list refuses it.
#[tokio::test]
async fn only_http_and_https_are_schemes_a_plugin_may_request() {
    if skip() {
        return;
    }
    let harness = harness!(&["127.0.0.1"], true);

    for url in [
        "file:///etc/passwd",
        "gopher://127.0.0.1/",
        "ftp://127.0.0.1/feed",
    ] {
        let refused = refusal(harness.fetch(url, json!({})).await);
        assert!(
            matches!(
                refused.code,
                abi::ErrorCode::Blocked | abi::ErrorCode::InvalidArgument
            ),
            "{url} should be refused, got {refused}"
        );
    }

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

/// A redirect is a destination chosen by whoever we were just talking to, so **every hop**
/// repeats the allowlist and the IP policy. A check that only runs on the first URL is not a
/// check.
#[tokio::test]
async fn a_redirect_to_an_unapproved_host_is_refused_at_the_hop() {
    if skip() {
        return;
    }
    let harness = harness!(&["127.0.0.1"], true);

    // Hop one is approved; hop two is not.
    let target = "http://example.test/feed";
    let refused = refusal(
        harness
            .fetch(&harness.url(&format!("/redirect/{target}")), json!({}))
            .await,
    );
    assert_eq!(refused.code, abi::ErrorCode::Blocked);
    assert_eq!(
        refused.detail.as_ref().and_then(|d| d["host"].as_str()),
        Some("example.test"),
        "the refusal names the host the *redirect* aimed at"
    );

    // A redirect that stays on an approved host is followed, and `final_url` says where it
    // ended up.
    let allowed = harness.url("/feed");
    let answer = harness
        .fetch(&harness.url(&format!("/redirect/{allowed}")), json!({}))
        .await
        .expect("a same-host redirect is followed")
        .expect("a value");
    assert_eq!(answer["status"], json!(200));
    assert!(
        answer["final_url"]
            .as_str()
            .unwrap_or_default()
            .ends_with("/feed"),
        "final_url should be where it ended up: {}",
        answer["final_url"]
    );

    harness.cleanup().await;
}

/// **304 is not a redirect.** It was treated as one, because `StatusCode::is_redirection()`
/// is every 3xx — so the hop loop looked for a `Location` that a 304 never carries and
/// refused the response with `unavailable`.
///
/// The shape of the bug is why this test exists rather than a note: a plugin's *first*
/// fetch has no validator to send and gets a 200, so everything looked right; the failure
/// arrived on the second run, when the plugin did the cheapest and most correct thing it
/// could and sent the `ETag` it had stored. The calendar plugin's conditional GET — SPEC
/// §6.3's "cron while nobody's looking" done politely — was the exact case that broke.
#[tokio::test]
async fn a_conditional_get_answered_304_is_a_response_not_a_redirect() {
    if skip() {
        return;
    }
    let harness = harness!(&["127.0.0.1"], true);

    let answer = harness
        .fetch(&harness.url("/not-modified"), json!({}))
        .await
        .expect("304 is an answer, not a failure")
        .expect("a value");

    assert_eq!(answer["status"], json!(304));
    assert_eq!(
        answer["headers"]["etag"],
        json!("W/\"abc\""),
        "the validator comes back so the plugin can keep storing it"
    );

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/// Over the cap is `too_large`, **never** a truncated body: half an ICS feed would produce
/// confidently wrong documents (HOST-ABI.md §2.3).
#[tokio::test]
async fn a_response_over_the_cap_is_refused_rather_than_truncated() {
    if skip() {
        return;
    }
    let harness = harness!(&["127.0.0.1"], true);
    // The harness configured a 4 KiB cap.
    let cap = 4 * 1024;

    let under = harness
        .fetch(&harness.url(&format!("/big/{}", cap - 1)), json!({}))
        .await
        .expect("under the cap")
        .expect("a value");
    assert_eq!(under["body_bytes"], json!(cap - 1));

    let over = refusal(
        harness
            .fetch(&harness.url(&format!("/big/{}", cap + 1)), json!({}))
            .await,
    );
    assert_eq!(over.code, abi::ErrorCode::TooLarge);
    assert_eq!(
        over.detail.as_ref().and_then(|d| d["limit"].as_u64()),
        Some(cap as u64)
    );

    harness.cleanup().await;
}

/// The outbound timeout is capped by what is left of the invocation, so a slow upstream
/// cannot hold a plugin call open past its deadline.
#[tokio::test]
async fn a_slow_upstream_times_out_inside_the_invocations_budget() {
    if skip() {
        return;
    }
    let harness = harness!(&["127.0.0.1"], true);

    let started = std::time::Instant::now();
    let refused = refusal(harness.fetch(&harness.url("/slow"), json!({})).await);
    let elapsed = started.elapsed();

    assert_eq!(refused.code, abi::ErrorCode::Timeout);
    assert!(
        elapsed < Duration::from_secs(5),
        "the request should have been cut off well before the upstream's 30 s, took {elapsed:?}"
    );
    // A timeout on an *outbound* request is the plugin's destination misbehaving, not the
    // plugin failing — the invocation itself returned a refusal, which is a success.
    assert_eq!(harness.host.breaker_state("hello-backend").failures(), 0);

    harness.cleanup().await;
}

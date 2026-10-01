//! The **real** plugin host, end to end: `PluginHost` over a real `AppState`, a real
//! MongoDB, and the real `hello-backend` module compiled to `wasm32-unknown-unknown`.
//!
//! `pluginhost_smoke.rs` answers "does a plugin built against the SDK load at all" with a
//! *miniature* host and no database. This suite is the other half — everything that only
//! exists in the real one:
//!
//! 1. **Activation is the ABI check, then publication.** A module whose `ddd_abi_version`
//!    disagrees never runs a line of its own code, and a plugin is in the active map only
//!    once every step succeeded.
//! 2. **A capability that was not approved is an erroring stub, not a missing import**
//!    (SPEC §6.2). The plugin can *probe* for one it does not have and read the code.
//! 3. **The document host functions work through a plugin**, with `created_by` as the
//!    ownership record (SPEC §3.3): `create_document` stamps `plugin:<id>`,
//!    `rewrite_document` refuses a document the plugin did not create, and
//!    `splice_section` writes only the caller's own `%%%` section — idempotently.
//! 4. **A refusal is a successful call and a trap is not** — the distinction the circuit
//!    breaker is built on — and five host-side failures in a row disable the plugin.
//! 5. **The deadline is real.** A Wasm loop that never returns to the host is still
//!    interrupted, because the epoch timer does not need the plugin's cooperation.
//! 6. **The pool bounds concurrency**, and unloading waits for what is in flight.
//!
//! Like every other Mongo-backed suite here it **skips silently** when `MONGO_URI` is
//! unset, and it also skips when the fixture has not been built, so a clean checkout with
//! no wasm toolchain still tests green:
//!
//! ```text
//! docker compose up -d --wait mongo
//! mise run wasm-plugins
//! MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p ddd-server --test pluginhost_runtime
//! ```

mod common;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ddd_plugin_abi as abi;
use ddd_server::domain::{Actor, new_id};
use ddd_server::pluginhost::breaker::BreakerState;
use ddd_server::pluginhost::{CallFailure, CallKind, Invocation, PluginHost, PluginHostError};
use ddd_server::plugininstall::InstallSource;
use ddd_server::plugins::{
    PluginBackend, PluginCapabilities, PluginManifest, PluginRecord, PluginState,
};
use ddd_server::state::AppState;
use serde_json::{Value, json};

/// Where `mise run wasm-plugins` leaves the fixture.
fn fixture() -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../plugins/target/wasm32-unknown-unknown/release/hello_backend.wasm");
    path.exists().then_some(path)
}

/// One test's world: its own database, its own plugins directory, its own host.
///
/// The plugins directory is per-test because `PluginHost::activate` reads
/// `<PLUGINS_DIR>/<id>/<version>/<module>` — the installed layout — so "install" here is a
/// file copy, which is exactly what the installer's final rename produces.
struct Harness {
    state: AppState,
    host: Arc<PluginHost>,
    plugins_dir: PathBuf,
    client: mongodb::Client,
    database: String,
}

impl Harness {
    async fn start() -> Option<Harness> {
        let uri = common::mongo_uri()?;
        let wasm = fixture()?;

        let database = format!("ddd_pluginhost_test_{}", new_id());
        let plugins_dir = std::env::temp_dir().join(format!("ddd-pluginhost-{database}"));

        let mut config = common::test_config(uri.clone(), database.clone());
        config.plugins_dir = plugins_dir.clone();
        // Short, so a deadline test does not hold the suite for five seconds.
        config.plugin_call_timeout = Duration::from_millis(1_500);
        config.plugin_cron_timeout = Duration::from_millis(2_500);
        config.plugin_max_instances = 2;
        config.plugin_breaker_threshold = 3;

        let client = mongodb::Client::with_uri_str(&uri).await.ok()?;
        let state = AppState::new(config).await.ok()?;
        state.init_schema().await.ok()?;

        let harness = Harness {
            host: PluginHost::get(&state),
            state,
            plugins_dir,
            client,
            database,
        };
        harness.install("hello-backend", "1.0.0", &wasm);
        Some(harness)
    }

    /// Put a module where the installer would have left it.
    fn install(&self, id: &str, version: &str, wasm: &std::path::Path) {
        let dir = self.plugins_dir.join(id).join(version);
        std::fs::create_dir_all(&dir).expect("a temp plugin directory");
        std::fs::copy(wasm, dir.join("backend.wasm")).expect("copy the fixture");
    }

    async fn cleanup(self) {
        self.host.shutdown(Duration::from_secs(2)).await;
        let _ = self.client.database(&self.database).drop().await;
        let _ = std::fs::remove_dir_all(&self.plugins_dir);
    }

    /// `ddd_call` with a function and payload, as a plugin dependent would.
    async fn invoke(&self, function: &str, payload: Value) -> Result<Option<Value>, CallFailure> {
        let invocation = Invocation::top_level(
            "hello-backend",
            CallKind::Invoked {
                caller: "test".to_string(),
                function: function.to_string(),
            },
            payload,
            self.host.limits(),
        );
        self.host.call_typed::<Value>(&self.state, invocation).await
    }

    /// The raw outcome, for the cases where a refusal is the thing being asserted.
    async fn call(
        &self,
        function: &str,
        payload: Value,
    ) -> Result<ddd_server::pluginhost::CallOutcome, PluginHostError> {
        let invocation = Invocation::top_level(
            "hello-backend",
            CallKind::Invoked {
                caller: "test".to_string(),
                function: function.to_string(),
            },
            payload,
            self.host.limits(),
        );
        self.host.call(&self.state, invocation).await
    }
}

/// A record the way the installer would have written it after an admin approved it.
fn record(capabilities: PluginCapabilities) -> PluginRecord {
    record_with(capabilities, Vec::new(), Vec::new())
}

fn record_with(
    capabilities: PluginCapabilities,
    deps: Vec<String>,
    routes: Vec<String>,
) -> PluginRecord {
    let public_routes = capabilities.public_routes.clone();
    PluginRecord {
        id: "hello-backend".to_string(),
        version: "1.0.0".to_string(),
        state: PluginState::Enabled,
        manifest: PluginManifest {
            id: "hello-backend".to_string(),
            version: "1.0.0".to_string(),
            kernel: "^3.0".to_string(),
            peer_libraries: BTreeMap::new(),
            frontend: None,
            capabilities: PluginCapabilities {
                public_routes,
                ..capabilities.clone()
            },
            config: BTreeMap::new(),
            backend: Some(PluginBackend {
                module: "backend.wasm".to_string(),
                hooks: vec!["document.changed".to_string()],
                cron: vec!["0 6 * * *".to_string()],
                routes,
                events: Vec::new(),
                // `echo` is callable, which is what lets the reentrancy check be reached.
                exports: BTreeMap::from([(
                    "echo".to_string(),
                    ddd_server::plugins::BackendExport {
                        input: None,
                        output: None,
                        description: None,
                    },
                )]),
            }),
            name: None,
            description: None,
            author: None,
            license: None,
            provides: None,
            dependencies: deps.into_iter().map(|id| (id, "*".to_string())).collect(),
            optional_dependencies: BTreeMap::new(),
            extra: BTreeMap::new(),
        },
        capabilities_approved: capabilities,
        source: InstallSource::Base,
        installed_at: ddd_server::domain::Timestamp::now(),
        installed_by: None,
        approved_at: None,
        approved_by: None,
        disabled_reason: None,
        last_error: None,
        module_sha256: Some("test-fixture".to_string()),
        cron_state: Vec::new(),
    }
}

fn read_write() -> PluginCapabilities {
    PluginCapabilities {
        documents: vec!["read".to_string(), "write".to_string()],
        ..PluginCapabilities::default()
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
    () => {
        match Harness::start().await {
            Some(harness) => harness,
            None => return,
        }
    };
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn activation_reads_the_abi_version_and_the_export_list_before_publishing() {
    if skip() {
        return;
    }
    let harness = harness!();

    let plugin = harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("the fixture activates");

    assert_eq!(plugin.abi_version, abi::ABI_VERSION);
    // The export list is read once, at activation, so no hot path asks — and so a hook is
    // never *scheduled* for a plugin that cannot receive it.
    for export in [
        abi::names::ABI_VERSION,
        abi::names::INIT,
        abi::names::CRON,
        abi::names::CALL,
        abi::names::HTTP,
        abi::names::HOOK_DOCUMENT_CHANGED,
    ] {
        assert!(plugin.has_export(export), "{export} should be present");
    }
    assert!(
        !plugin.has_export(abi::names::HOOK_DOCUMENT_DELETED),
        "the fixture does not export it, and the host must not claim it does"
    );
    assert!(plugin.subscribes_to(abi::hooks::HookKind::DocumentChanged));
    assert!(!plugin.subscribes_to(abi::hooks::HookKind::DocumentDeleted));

    assert_eq!(
        harness
            .host
            .active()
            .iter()
            .map(|plugin| plugin.id.clone())
            .collect::<Vec<_>>(),
        vec!["hello-backend".to_string()]
    );
    assert!(harness.host.get_active("hello-backend").is_some());
    assert!(harness.host.get_active("nope").is_none());
    assert_eq!(harness.host.stats().active, 1);

    harness.cleanup().await;
}

/// A missing module is `Instantiate`, not a panic and not a published plugin. The frontend
/// half of such a plugin is still served (SPEC §6.4's rule) — the host's job is to say which
/// half is missing and carry on.
#[tokio::test]
async fn a_missing_module_fails_activation_without_publishing_anything() {
    if skip() {
        return;
    }
    let harness = harness!();

    let mut missing = record(PluginCapabilities::default());
    missing.version = "9.9.9".to_string();
    let err = harness
        .host
        .activate(&harness.state, &missing)
        .await
        .expect_err("there is no 9.9.9 on disk");
    assert!(matches!(err, PluginHostError::Instantiate { .. }), "{err}");
    assert!(harness.host.active().is_empty());

    harness.cleanup().await;
}

/// A plugin with no `backend` in its manifest is not an error worth a breaker entry: most
/// plugins have no backend half — a plugin needs one only for cron, outbound HTTP or a
/// webhook (SPEC §6.3), and today none of the base distribution does.
#[tokio::test]
async fn a_plugin_without_a_backend_half_is_simply_not_active() {
    if skip() {
        return;
    }
    let harness = harness!();

    let mut frontend_only = record(PluginCapabilities::default());
    frontend_only.manifest.backend = None;
    let err = harness
        .host
        .activate(&harness.state, &frontend_only)
        .await
        .expect_err("nothing to load");
    assert!(matches!(err, PluginHostError::NotActive(_)), "{err}");
    assert!(!err.counts_as_failure());

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// Calls, refusals and the envelope
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_payload_reaches_the_plugin_and_a_value_comes_back() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("activates");

    let echoed = harness
        .invoke("echo", json!({ "hello": "world", "n": 7 }))
        .await
        .expect("ddd_call echo");
    assert_eq!(echoed, Some(json!({ "hello": "world", "n": 7 })));

    harness.cleanup().await;
}

/// The distinction the whole breaker rests on: the plugin answered, so the machinery worked.
#[tokio::test]
async fn a_plugin_refusal_is_a_successful_call_and_never_counts_on_the_breaker() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("activates");

    // Ten refusals in a row — twice the configured threshold of three.
    for _ in 0..10 {
        let outcome = harness
            .call("nope", Value::Null)
            .await
            .expect("a refusal is a successful call");
        assert!(outcome.refused());
        assert_eq!(
            outcome.refusal.as_ref().map(|error| error.code),
            Some(abi::ErrorCode::NotFound)
        );
        assert!(outcome.value.is_none());
    }
    assert_eq!(
        harness.host.breaker_state("hello-backend"),
        BreakerState::Closed { failures: 0 },
        "a plugin is never disabled for correctly reporting that something is not there"
    );

    // `call_typed` is the other view of the same call: there, a refusal *is* an error,
    // carrying the plugin's own code.
    match harness.invoke("nope", Value::Null).await {
        Err(CallFailure::Refused(error)) => assert_eq!(error.code, abi::ErrorCode::NotFound),
        other => panic!("expected a forwarded refusal, got {other:?}"),
    }

    harness.cleanup().await;
}

/// `NoExport` is the host's own routing decision, so it must not count on the breaker —
/// otherwise a misconfigured hook would disable a healthy plugin.
#[tokio::test]
async fn an_export_the_module_does_not_have_is_not_a_plugin_failure() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("activates");

    let invocation = Invocation::top_level(
        "hello-backend",
        CallKind::Hook(abi::hooks::HookKind::DocumentDeleted),
        json!({}),
        harness.host.limits(),
    );
    let err = harness
        .host
        .call(&harness.state, invocation)
        .await
        .expect_err("the fixture has no ddd_hook_document_deleted");
    assert!(matches!(err, PluginHostError::NoExport { .. }), "{err}");
    assert_eq!(
        harness.host.breaker_state("hello-backend").failures(),
        0,
        "the host's routing mistake is not the plugin's failure"
    );

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/// SPEC §6.2: "Undeclared host functions are linked as **erroring stubs** (so optional use
/// is possible; instantiation never fails on imports)." The plugin probes and reads a code.
#[tokio::test]
async fn an_unapproved_capability_is_an_erroring_stub_the_plugin_can_probe() {
    if skip() {
        return;
    }
    let harness = harness!();
    // Approved: nothing at all.
    harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("a plugin with no capabilities still activates");

    for host_fn in [
        "get_document",
        "query_documents",
        "query",
        "create_document",
        "http_request",
    ] {
        let code = harness
            .invoke("probe", json!({ "host_fn": host_fn }))
            .await
            .expect("the probe itself succeeds");
        assert_eq!(
            code,
            Some(json!("capability_denied")),
            "`{host_fn}` should be an erroring stub, not a missing import"
        );
    }

    // KV is ungated: it is the plugin's *own* namespace, and SPEC §6.3's archetype is a
    // cron-and-KV plugin with no capabilities at all.
    assert_eq!(
        harness
            .invoke("probe", json!({ "host_fn": "kv_get" }))
            .await
            .expect("probe"),
        Some(json!("ok"))
    );

    harness.cleanup().await;
}

/// Read without write: the split has to be real, or `documents: ["read"]` would be
/// decoration.
#[tokio::test]
async fn read_and_write_are_separate_grants() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(
            &harness.state,
            &record(PluginCapabilities {
                documents: vec!["read".to_string()],
                ..PluginCapabilities::default()
            }),
        )
        .await
        .expect("activates");

    assert_eq!(
        harness
            .invoke("probe", json!({ "host_fn": "query_documents" }))
            .await
            .expect("probe"),
        Some(json!("ok")),
        "read was granted"
    );
    assert_eq!(
        harness
            .invoke("probe", json!({ "host_fn": "query" }))
            .await
            .expect("probe"),
        Some(json!("ok")),
        "`query` is the same read: the SDK's builder, answered by the engine"
    );
    assert_eq!(
        harness
            .invoke("probe", json!({ "host_fn": "create_document" }))
            .await
            .expect("probe"),
        Some(json!("capability_denied")),
        "write was not"
    );

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// Documents: ownership, splices, idempotence
// ---------------------------------------------------------------------------

/// `created_by == "plugin:<id>"` **is** the machine-ownership record (SPEC §3.3), and
/// `rewrite_document` is the thing that checks it.
#[tokio::test]
async fn a_plugin_owns_what_it_created_and_nothing_else() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(read_write()))
        .await
        .expect("activates");

    let created = harness
        .invoke(
            "create",
            json!({ "text": "---\ntitle: Standup\ndate: 2026-09-24\n---\n\n# Standup\n" }),
        )
        .await
        .expect("create_document")
        .expect("a value");
    let id = created["id"].as_str().expect("an id").to_string();
    assert_eq!(created["title"], json!("Standup"));

    let stored = harness.state.docs.get(&id).await.expect("the row");
    assert_eq!(
        stored.created_by.as_deref(),
        Some("plugin:hello-backend"),
        "the ownership record is the actor, not a new column"
    );

    // Its own document: rewriting is legal.
    let rewritten = harness
        .invoke(
            "rewrite",
            json!({ "id": id, "text": "---\ntitle: Standup (moved)\n---\n" }),
        )
        .await
        .expect("rewrite_document")
        .expect("a value");
    assert_eq!(rewritten["title"], json!("Standup (moved)"));

    // A human's document is nobody's to rewrite — which is the intended outcome of using
    // `created_by` as the record.
    let human = harness
        .state
        .docs
        .create(
            None,
            "---\ntitle: Mine\n---\n\nprose\n",
            &Actor::User(new_id()),
        )
        .await
        .expect("a user's document");
    match harness
        .invoke("rewrite", json!({ "id": human.id, "text": "gone" }))
        .await
    {
        Err(CallFailure::Refused(error)) => assert_eq!(error.code, abi::ErrorCode::Forbidden),
        other => panic!("expected forbidden, got {other:?}"),
    }
    // And the text is untouched.
    assert!(
        harness
            .state
            .docs
            .text(&human.id)
            .await
            .expect("still there")
            .contains("prose")
    );

    harness.cleanup().await;
}

/// Two things at once, because they are the same guarantee: a splice touches only the
/// caller's own `%%%` section, and an edit that writes what is already there writes
/// **nothing** — which is what keeps an idempotent daily sync out of the CRDT history
/// (SPEC §3.3, HOST-ABI.md §3.4).
#[tokio::test]
async fn a_splice_writes_only_its_own_section_and_only_when_something_changed() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(read_write()))
        .await
        .expect("activates");

    let human = harness
        .state
        .docs
        .create(
            None,
            "---\ntitle: Groceries\n---\n\n- [ ] milk\n\n%%% other-plugin\nkeep: me\n%%%\n",
            &Actor::User(new_id()),
        )
        .await
        .expect("a human's document");

    let first = harness
        .invoke(
            "splice",
            json!({ "id": human.id, "key": "source_uid", "value": "abc@example.com" }),
        )
        .await
        .expect("splice_section")
        .expect("a value");
    assert_eq!(first["edits_applied"], json!(1));
    assert_eq!(first["changed"], json!(true));

    let text = harness.state.docs.text(&human.id).await.expect("the text");
    assert!(text.contains("%%% hello-backend"));
    assert!(text.contains("source_uid: abc@example.com"));
    // The human's prose and the *other* plugin's section are both untouched: the caller's
    // own section is the only thing a splice can reach.
    assert!(text.contains("- [ ] milk"));
    assert!(text.contains("%%% other-plugin"));
    assert!(text.contains("keep: me"));
    assert!(text.starts_with("---\ntitle: Groceries\n---"));

    // The same edit again: no write, no CRDT history.
    let again = harness
        .invoke(
            "splice",
            json!({ "id": human.id, "key": "source_uid", "value": "abc@example.com" }),
        )
        .await
        .expect("splice_section")
        .expect("a value");
    assert_eq!(again["edits_applied"], json!(0));
    assert_eq!(again["changed"], json!(false));
    assert_eq!(
        harness.state.docs.text(&human.id).await.expect("the text"),
        text,
        "an idempotent sync must not change a byte"
    );

    // A real change does write.
    let changed = harness
        .invoke(
            "splice",
            json!({ "id": human.id, "key": "source_uid", "value": "def@example.com" }),
        )
        .await
        .expect("splice_section")
        .expect("a value");
    assert_eq!(changed["edits_applied"], json!(1));
    let updated = harness.state.docs.text(&human.id).await.expect("the text");
    assert!(updated.contains("source_uid: def@example.com"));
    assert!(!updated.contains("abc@example.com"));

    // **A literal null is a value, and this is the only test that proves it crosses the
    // boundary.** `SectionEdit.value` is an `Option<Value>`, and serde folds a JSON `null`
    // onto `None` — the same thing an absent field produces — so the wire form
    // `HOST-ABI.md` and the ABI's own doc comment specify for "write `k: null`" arrived as
    // "no value at all" and the host refused it with `invalid_argument`. The ABI test beside
    // the type only ever serialized, which is exactly how a lossy read-back survives.
    let nulled = harness
        .invoke(
            "splice",
            json!({ "id": human.id, "key": "source_uid", "value": null }),
        )
        .await
        .expect("splice_section")
        .expect("a value");
    assert_eq!(nulled["edits_applied"], json!(1));
    let nulled_text = harness.state.docs.text(&human.id).await.expect("the text");
    assert!(
        nulled_text.contains("source_uid: null"),
        "a null must be written as the YAML null scalar, not refused: {nulled_text}"
    );

    harness.cleanup().await;
}

/// `get_document` forces a materialization flush, so a plugin that splices and re-reads
/// inside one invocation sees its own write (SPEC §3.5's read-your-writes rule).
#[tokio::test]
async fn a_plugin_reads_its_own_write_back() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(read_write()))
        .await
        .expect("activates");

    let created = harness
        .invoke("create", json!({ "text": "---\ntitle: Event\n---\n" }))
        .await
        .expect("create")
        .expect("a value");
    let id = created["id"].as_str().expect("an id").to_string();

    harness
        .invoke("splice", json!({ "id": id, "key": "sequence", "value": 3 }))
        .await
        .expect("splice");

    let read = harness
        .invoke("read", json!({ "id": id }))
        .await
        .expect("get_document")
        .expect("a value");
    assert_eq!(read["created_by"], json!("plugin:hello-backend"));
    assert_eq!(read["plugins"]["hello-backend"]["sequence"], json!(3));
    assert!(
        read["content"]
            .as_str()
            .expect("content")
            .contains("sequence: 3")
    );

    harness.cleanup().await;
}

/// The per-`(plugin, document)` cap is the loop backstop of SPEC §6.3. It refuses the
/// eleventh write to *one* document in a minute, and it is per document — a plugin importing
/// a thousand events is not looping.
#[tokio::test]
async fn the_per_document_write_cap_stops_a_loop_without_stopping_a_sync() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(read_write()))
        .await
        .expect("activates");

    let created = harness
        .invoke("create", json!({ "text": "---\ntitle: Looping\n---\n" }))
        .await
        .expect("create")
        .expect("a value");
    let id = created["id"].as_str().expect("an id").to_string();

    let cap = abi::limits::MAX_WRITES_PER_DOCUMENT_PER_MINUTE;
    // Each call is a *distinct* value, so none of them is skipped as a no-op.
    for n in 0..cap {
        harness
            .invoke("splice", json!({ "id": id, "key": "sequence", "value": n }))
            .await
            .unwrap_or_else(|err| panic!("write {n} should be allowed: {err:?}"));
    }
    match harness
        .invoke(
            "splice",
            json!({ "id": id, "key": "sequence", "value": 999 }),
        )
        .await
    {
        Err(CallFailure::Refused(error)) => {
            assert_eq!(error.code, abi::ErrorCode::LimitExceeded);
            assert_eq!(
                error.detail.as_ref().and_then(|d| d["document"].as_str()),
                Some(id.as_str()),
                "the refusal names the document being looped on"
            );
        }
        other => panic!("expected limit_exceeded, got {other:?}"),
    }

    // A different document has its own window: the cap is a loop breaker, not a budget.
    let other = harness
        .invoke("create", json!({ "text": "---\ntitle: Elsewhere\n---\n" }))
        .await
        .expect("create")
        .expect("a value");
    harness
        .invoke(
            "splice",
            json!({ "id": other["id"], "key": "sequence", "value": 1 }),
        )
        .await
        .expect("a different document is a different window");

    // And a refused write is not a *plugin* failure: the breaker stays closed.
    assert_eq!(harness.host.breaker_state("hello-backend").failures(), 0);

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// KV
// ---------------------------------------------------------------------------

/// KV needs no capability and is namespaced by construction: the `_id` is
/// `<plugin>:<key>`, and `:` is not in the key charset.
#[tokio::test]
async fn kv_round_trips_through_mongo_in_the_plugins_own_namespace() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("activates");

    let cron = json!({
        "expression": "*/15 * * * *", "index": 0,
        "scheduled_for": "2026-09-24T06:00:00Z", "fired_at": "2026-09-24T06:00:01Z",
        "last_run": null, "missed": 0, "deadline_ms": 2500
    });
    for expected in 1..=3u64 {
        let invocation = Invocation::top_level(
            "hello-backend",
            CallKind::Cron { index: 0 },
            cron.clone(),
            harness.host.limits(),
        );
        harness
            .host
            .call(&harness.state, invocation)
            .await
            .expect("ddd_cron");

        // Read back through `ddd_call` (the plugin's own view)…
        assert_eq!(
            harness.invoke("runs", Value::Null).await.expect("runs"),
            Some(json!(expected))
        );
    }

    // …and through Mongo (the host's view), where the namespace is visible in the `_id`.
    let row = harness
        .state
        .collections
        .raw(ddd_server::db::PLUGIN_KV)
        .find_one(bson::doc! { "_id": "hello-backend:runs" })
        .await
        .expect("query")
        .expect("the row exists");
    assert_eq!(
        row.get_str("plugin_id").expect("plugin_id"),
        "hello-backend"
    );
    assert_eq!(row.get_str("key").expect("key"), "runs");

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// call_plugin
// ---------------------------------------------------------------------------

/// `dependencies` is what gates `call_plugin`, not a capability (HOST-ABI.md §3.10).
/// An undeclared callee is `forbidden` even when it is loaded and healthy.
#[tokio::test]
async fn call_plugin_refuses_an_undeclared_dependency_and_refuses_reentrancy() {
    if skip() {
        return;
    }
    let harness = harness!();
    // Declares itself as a callee, which is the only way to reach the reentrancy check
    // through a single fixture — and a legitimate thing for a manifest to be wrong about.
    let deps = vec!["hello-backend".to_string()];
    harness
        .host
        .activate(
            &harness.state,
            &record_with(PluginCapabilities::default(), deps, Vec::new()),
        )
        .await
        .expect("activates");

    // Not in `dependencies`: forbidden, before anything is looked up.
    match harness
        .invoke(
            "call",
            json!({ "plugin": "folders", "function": "normalize" }),
        )
        .await
    {
        Err(CallFailure::Refused(error)) => {
            assert_eq!(error.code, abi::ErrorCode::Forbidden);
            assert!(error.message.contains("dependencies"));
        }
        other => panic!("expected forbidden, got {other:?}"),
    }

    // Declared, but it is itself: an Extism instance cannot re-enter itself, and that is a
    // *different* refusal from being too deep.
    match harness
        .invoke(
            "call",
            json!({ "plugin": "hello-backend", "function": "echo" }),
        )
        .await
    {
        Err(CallFailure::Refused(error)) => assert_eq!(error.code, abi::ErrorCode::Reentrancy),
        other => panic!("expected reentrancy, got {other:?}"),
    }

    // Neither refusal is the plugin's fault as far as the breaker is concerned.
    assert_eq!(harness.host.breaker_state("hello-backend").failures(), 0);

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// Limits: traps, deadlines, the breaker
// ---------------------------------------------------------------------------

/// A trap is a host-side failure: it poisons the instance, it is counted, and the *next*
/// call still works because the poisoned instance was dropped rather than reused.
#[tokio::test]
async fn a_trap_is_counted_poisons_its_instance_and_does_not_break_the_next_call() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("activates");

    let err = harness
        .call("trap", Value::Null)
        .await
        .expect_err("a panic in a plugin is a trap");
    assert!(matches!(err, PluginHostError::Trap { .. }), "{err}");
    assert!(err.counts_as_failure());
    assert_eq!(harness.host.breaker_state("hello-backend").failures(), 1);

    // The instance was thrown away, not reset — so this call gets a fresh one and works.
    assert_eq!(
        harness
            .invoke("echo", json!("still here"))
            .await
            .expect("echo"),
        Some(json!("still here"))
    );
    assert_eq!(
        harness.host.breaker_state("hello-backend").failures(),
        0,
        "a success resets the consecutive count"
    );

    harness.cleanup().await;
}

/// Five in a row (three here — the threshold is configurable downward) disables the plugin,
/// with **manual re-enable only** (SPEC §6.3). After that no call reaches an instance.
#[tokio::test]
async fn consecutive_failures_open_the_breaker_and_only_an_admin_closes_it() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("activates");
    let threshold = harness.host.limits().breaker_threshold;

    for n in 1..=threshold {
        let err = harness
            .call("trap", Value::Null)
            .await
            .expect_err("a trap each time");
        assert!(err.counts_as_failure(), "failure {n}: {err}");
    }
    assert!(
        harness.host.breaker_state("hello-backend").is_open(),
        "{threshold} consecutive failures should have opened it"
    );

    // Every further call is refused *without touching an instance*: a disabled plugin must
    // not still cost a compile and 128 MB.
    let refused = harness
        .call("echo", json!("anyone there"))
        .await
        .expect_err("the breaker is open");
    assert!(
        matches!(refused, PluginHostError::Disabled { .. }),
        "{refused}"
    );
    // …and being refused by the breaker is not itself a countable failure.
    assert!(!refused.counts_as_failure());

    // The breaker opening also unloads the plugin, so its record and its memory agree.
    assert!(harness.host.get_active("hello-backend").is_none());

    // Manual re-enable: the admin's button. Nothing else closes it.
    harness.host.reset_breaker("hello-backend");
    assert_eq!(
        harness.host.breaker_state("hello-backend"),
        BreakerState::Closed { failures: 0 }
    );
    harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("re-activates");
    assert_eq!(
        harness.invoke("echo", json!("back")).await.expect("echo"),
        Some(json!("back"))
    );

    harness.cleanup().await;
}

/// The one case the host's own deadline logic cannot see: a Wasm loop that never returns to
/// the host. Epoch interruption does not need the plugin's cooperation, which is why it is
/// the thing that has to work.
#[tokio::test]
async fn a_wasm_loop_that_never_returns_is_still_interrupted() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("activates");

    let budget = harness.host.limits().call_timeout;
    let started = std::time::Instant::now();
    let err = harness
        .call("spin", Value::Null)
        .await
        .expect_err("an endless loop must not run forever");
    let elapsed = started.elapsed();

    assert!(matches!(err, PluginHostError::Timeout { .. }), "{err}");
    assert!(err.counts_as_failure());
    assert!(
        elapsed < budget * 4,
        "interrupted in {elapsed:?}, which is not close to the {budget:?} budget"
    );

    // And the host is still usable: the spinning instance was dropped.
    assert_eq!(
        harness.invoke("echo", json!("alive")).await.expect("echo"),
        Some(json!("alive"))
    );

    harness.cleanup().await;
}

/// The log cap drops lines rather than failing the call: a plugin that logs too much is
/// noisy, not broken.
#[tokio::test]
async fn the_log_cap_drops_lines_without_failing_the_call() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("activates");

    let outcome = harness
        .call("log_flood", Value::Null)
        .await
        .expect("150 log lines must not fail a call");
    assert!(!outcome.refused());
    assert!(
        outcome.logs >= abi::log::MAX_LOG_LINES_PER_CALL,
        "the counter should have seen every attempt, got {}",
        outcome.logs
    );

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

/// Extism calls are not reentrant, so a plugin's concurrency *is* its instance count — and
/// two concurrent calls must both complete rather than one of them failing.
#[tokio::test]
async fn concurrent_calls_are_served_by_separate_instances() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("activates");

    let mut calls = Vec::new();
    for n in 0..6 {
        let host = Arc::clone(&harness.host);
        let state = harness.state.clone();
        let limits = *harness.host.limits();
        calls.push(tokio::spawn(async move {
            let invocation = Invocation::top_level(
                "hello-backend",
                CallKind::Invoked {
                    caller: "test".to_string(),
                    function: "echo".to_string(),
                },
                json!(n),
                &limits,
            );
            host.call_typed::<Value>(&state, invocation).await
        }));
    }

    let mut answers = Vec::new();
    for call in calls {
        answers.push(
            call.await
                .expect("the task")
                .expect("every concurrent call should succeed"),
        );
    }
    answers.sort_by_key(|value| value.as_ref().and_then(Value::as_i64).unwrap_or(-1));
    assert_eq!(
        answers,
        (0..6).map(|n| Some(json!(n))).collect::<Vec<_>>(),
        "each call gets its own answer, not another call's"
    );

    // The pool is bounded: two instances for six calls.
    assert!(
        harness.host.stats().instances <= harness.host.limits().max_instances,
        "the pool must not grow past its permit count, got {}",
        harness.host.stats().instances
    );

    harness.cleanup().await;
}

/// Unloading stops routing immediately and then waits for what is running — SPEC §6.3's
/// "hot unload waits on in-flight calls (refcount)".
#[tokio::test]
async fn deactivating_stops_routing_and_then_waits() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("activates");

    harness
        .host
        .deactivate("hello-backend")
        .await
        .expect("unload");
    assert!(harness.host.get_active("hello-backend").is_none());
    assert_eq!(harness.host.stats().active, 0);

    let err = harness
        .call("echo", json!("anyone"))
        .await
        .expect_err("nothing to route to");
    assert!(matches!(err, PluginHostError::NotActive(_)), "{err}");

    // Deactivating something that was never active is not an error: uninstall is allowed to
    // be idempotent.
    harness
        .host
        .deactivate("hello-backend")
        .await
        .expect("idempotent");

    harness.cleanup().await;
}

/// `DISABLE_PLUGINS=1` has to be a state the host is *in*, not a branch every caller
/// remembers (SPEC §6.1). Nothing compiles, nothing activates, every call is `NotActive`.
#[tokio::test]
async fn safe_mode_makes_the_host_inert() {
    if skip() {
        return;
    }
    let uri = common::mongo_uri().expect("checked");
    let database = format!("ddd_pluginhost_test_{}", new_id());
    let mut config = common::test_config(uri.clone(), database.clone());
    config.disable_plugins = true;
    let state = AppState::new(config).await.expect("state");
    state.init_schema().await.expect("schema");
    let host = PluginHost::get(&state);

    let err = host
        .activate(&state, &record(read_write()))
        .await
        .expect_err("nothing activates in safe mode");
    assert!(matches!(err, PluginHostError::NotActive(_)), "{err}");
    assert!(host.active().is_empty());
    assert_eq!(host.stats().active, 0);
    // `reload` is a no-op rather than an error, so boot does not have to special-case it.
    assert!(host.reload(&state).await.is_empty());

    let client = mongodb::Client::with_uri_str(&uri).await.expect("client");
    let _ = client.database(&database).drop().await;
}

/// **One call's deadline must not be another call's trap.**
///
/// Extism cancellation is engine-wide — `CancelHandle::cancel()` does nothing but
/// `engine.increment_epoch()`, and every store on that engine runs at `set_epoch_deadline(1)`.
/// While all of a plugin's instances shared one compiled module they shared one engine, so the
/// per-call watchdog was a plugin-wide weapon: a cron run hitting its 60 s budget trapped every
/// other in-flight call of the same plugin at its next Wasm instruction. Those calls came back as
/// `Trap` rather than `Timeout` (their own flags said nothing was wrong), their instances were
/// poisoned mid-write, a user's route got a 502, and five such collateral traps disabled a
/// healthy plugin.
///
/// So: start the call that will be cancelled **first**, then start a bounded one that is still
/// running when the cancel fires, and require it to come back as anything other than a trap.
///
/// The ordering is what makes the window exist. Both calls share one budget
/// (`plugin_call_timeout`, 1.5 s here), so the spinner is cancelled ~1.5 s after *it* started;
/// launching the sibling two thirds of the way through that puts it mid-call at the moment of the
/// cancel, with margin on both sides. A machine slow enough to change the arithmetic only widens
/// the window, and the final guard fails loudly rather than passing vacuously if it ever closes.
#[tokio::test]
async fn a_timing_out_call_does_not_trap_its_siblings() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(PluginCapabilities::default()))
        .await
        .expect("activates");

    let budget = harness.host.limits().call_timeout;
    let started = std::time::Instant::now();

    // The one that will be cancelled: an uninterruptible Wasm loop, so only the epoch ends it.
    let spinner = {
        let host = Arc::clone(&harness.host);
        let state = harness.state.clone();
        let limits = *harness.host.limits();
        tokio::spawn(async move {
            let invocation = Invocation::top_level(
                "hello-backend",
                CallKind::Invoked {
                    caller: "test".to_string(),
                    function: "spin".to_string(),
                },
                Value::Null,
                &limits,
            );
            let outcome = host.call(&state, invocation).await;
            (outcome, std::time::Instant::now())
        })
    };

    // Two thirds through the spinner's budget, start the sibling with enough work to outlast the
    // remaining third.
    tokio::time::sleep(budget * 2 / 3).await;
    let victim = harness.call("busy", json!({ "steps": 1_200 })).await;
    let finished_at = std::time::Instant::now();

    let (spun, cancelled_at) = spinner.await.expect("the task");
    assert!(
        matches!(spun, Err(PluginHostError::Timeout { .. })),
        "the spinner should have hit its deadline: {spun:?}"
    );

    // Without this the test could pass vacuously: a sibling that finished before the cancel was
    // never exposed to it. `steps` is what to raise if this ever trips.
    assert!(
        finished_at > cancelled_at,
        "the sibling finished at {:?}, before the spinner was cancelled at {:?} — it was never \
         exposed to the cancel, so this test proved nothing",
        finished_at.duration_since(started),
        cancelled_at.duration_since(started)
    );
    let outcome = victim;

    match outcome {
        Ok(outcome) => assert!(
            !outcome.refused(),
            "the sibling call answered a refusal it had no reason to"
        ),
        // A sibling that ran out of its *own* budget is not the bug — that is its deadline
        // doing its job. A `Trap` is: nothing in `busy` traps.
        Err(PluginHostError::Timeout { .. }) => {}
        Err(other) => panic!(
            "a sibling call was collaterally killed by the spinner's cancel: {other} \
             (budget was {budget:?})"
        ),
    }

    // The structural half of the same property, with no timing in it: the pool compiled a
    // module per instance slot, which is what gives each instance an engine of its own.
    let stats = harness.host.pool_stats("hello-backend").expect("the pool");
    assert!(
        stats.compiles >= 2,
        "two concurrent instances must not share one engine; compiles = {}",
        stats.compiles
    );

    harness.cleanup().await;
}

/// `ddd_init` runs **once per instance**, including on the instance activation warmed.
///
/// `probe_abi_version` and `exports` leave a warm instance in the idle list, and they run
/// *before* `set_init_payload`. While `acquire` decided by "did this call instantiate it", that
/// instance was popped with `fresh == false` and skipped `ddd_init` entirely — so the very first
/// invocation of every plugin ran on an uninitialised instance. HOST-ABI.md §4.1 promises the
/// payload (with the approved capability set, so a plugin can degrade deliberately rather than
/// discovering denials per call); a plugin caching it in a static saw its default until traffic
/// forced a second instance, and an `ddd_init` refusal was unreachable there.
#[tokio::test]
async fn the_first_call_runs_on_an_initialised_instance() {
    if skip() {
        return;
    }
    let harness = harness!();
    harness
        .host
        .activate(&harness.state, &record(read_write()))
        .await
        .expect("activates");

    // Activation warmed exactly one instance and nothing has been initialised yet.
    let before = harness.host.pool_stats("hello-backend").expect("the pool");
    assert_eq!(before.instances, 1, "activation warms one instance");

    // The fixture's `ddd_init` records what it was told; `caps` reads it back. A call landing on
    // an uninitialised instance would see nothing recorded.
    let answer = harness
        .invoke("caps", Value::Null)
        .await
        .expect("the first call")
        .expect("a value");
    assert_eq!(
        answer["initialised"],
        json!(true),
        "the first call ran on an instance that never received `ddd_init`: {answer}"
    );
    assert_eq!(
        answer["documents"],
        json!(["read", "write"]),
        "`ddd_init` must carry the *approved* capability set: {answer}"
    );

    // Still one instance: this was the warm one, initialised on its way out of the pool.
    assert_eq!(
        harness
            .host
            .pool_stats("hello-backend")
            .expect("the pool")
            .instances,
        1
    );

    harness.cleanup().await;
}

//! The install, approval, upgrade and uninstall life cycle (SPEC §6.2).
//!
//! These drive [`plugininstall`] against a **real MongoDB and a real filesystem**, because
//! every property worth asserting here is about the two of them agreeing: a pending package
//! is pending *because* it is in a directory the registry does not scan, an approval is a
//! rename, an upgrade is a rename plus a prune, and a purge is a background job over
//! documents. None of that can be faked without testing the fake.
//!
//! They do **not** go through the router: the admin HTTP surface belongs to another area
//! (`routes/plugin_api.rs`), and these are the library contract it calls.
//!
//! Like the rest of the Mongo-backed suites they are `#[ignore]`d and skip silently when
//! `MONGO_URI` is unset:
//!
//! ```text
//! docker compose up -d --wait mongo
//! MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p life-manager-server \
//!   --test plugininstall_flow -- --ignored
//! ```
//!
//! **Owner:** the `install-flow` builder.

mod common;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use life_manager_server::domain::{Actor, new_id};
use life_manager_server::plugininstall::{self, InstallError, InstallRequest, InstallSource};
use life_manager_server::plugins::{self, HttpCapability, PluginCapabilities, PluginState};
use life_manager_server::state::AppState;
use zip::write::SimpleFileOptions;

/// One test's server, throwaway database and throwaway plugin directories.
struct Harness {
    state: AppState,
    dir: PathBuf,
}

impl Harness {
    async fn start(name: &str) -> Option<Harness> {
        let uri = common::mongo_uri()?;
        let database = format!("lm_install_test_{}", new_id());
        let dir =
            Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("install-{name}-{}", new_id()));
        fs::create_dir_all(dir.join("served")).expect("a served root");
        fs::create_dir_all(dir.join("staging")).expect("a staging root");
        fs::create_dir_all(dir.join("inbox")).expect("an inbox");

        let mut config = common::test_config(uri, database);
        // The registry cache is keyed by `plugins_dir`, so a per-test directory is also what
        // keeps these cases from seeing each other's plugins.
        config.plugins_dir = dir.join("served");
        config.plugin_staging_dir = dir.join("staging");
        config.plugin_inbox_dir = Some(dir.join("inbox"));

        let state = AppState::new(config).await.ok()?;
        state.init_schema().await.ok()?;
        Some(Harness { state, dir })
    }

    async fn cleanup(self) {
        let _ = self.state.db.drop().await;
        let _ = fs::remove_dir_all(&self.dir);
    }

    fn served(&self, id: &str, version: &str) -> PathBuf {
        plugininstall::installed_dir(&self.state.config, id, version)
    }

    fn pending(&self, id: &str, version: &str) -> PathBuf {
        plugininstall::pending_dir(&self.state.config, id, version)
    }

    /// Build a package archive in this test's workspace.
    fn package(&self, name: &str, manifest: &str, with_wasm: bool) -> PathBuf {
        let path = self.dir.join(format!("{name}-{}.zip", new_id()));
        let file = fs::File::create(&path).expect("create the archive");
        let mut writer = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        writer
            .start_file("manifest.json", options)
            .expect("manifest");
        writer.write_all(manifest.as_bytes()).expect("write");
        writer
            .start_file("frontend/index.mjs", options)
            .expect("module");
        writer
            .write_all(b"export function activate() {}\n")
            .expect("write");
        if with_wasm {
            writer.start_file("backend.wasm", options).expect("wasm");
            writer.write_all(&wasm_with_abi_export()).expect("write");
        }
        writer.finish().expect("finish");
        path
    }

    async fn install(
        &self,
        archive: PathBuf,
    ) -> Result<plugininstall::InstallOutcome, InstallError> {
        plugininstall::install(
            &self.state,
            InstallRequest {
                source: InstallSource::Upload {
                    filename: archive
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_default(),
                },
                archive,
                actor: Actor::User(new_id()),
                auto_approve: false,
            },
        )
        .await
    }
}

fn wasm_with_abi_export() -> Vec<u8> {
    let mut module = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    let name = b"lm_abi_version";
    let mut section = vec![1u8];
    section.push(name.len() as u8);
    section.extend_from_slice(name);
    section.push(0x00);
    section.push(0x00);
    module.push(7);
    module.push(section.len() as u8);
    module.extend_from_slice(&section);
    module
}

/// A frontend-only manifest: no backend half, so nothing in these tests reaches the Wasm
/// host (which is another area's, and whose activation is the one step an install-flow test
/// must not depend on).
fn manifest(id: &str, version: &str) -> String {
    format!(
        r#"{{"id":"{id}","version":"{version}","kernel":"^2.0","frontend":{{"module":"frontend/index.mjs"}}}}"#
    )
}

// ---------------------------------------------------------------------------
// Both paths land as pending
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn an_upload_lands_as_pending_and_is_not_served() {
    let Some(harness) = Harness::start("pending").await else {
        return;
    };

    let archive = harness.package("demo", &manifest("demo", "1.0.0"), false);
    let outcome = harness.install(archive).await.expect("installs");

    assert_eq!(outcome.state, PluginState::Pending);
    assert_eq!(outcome.id, "demo");
    assert!(outcome.replaced.is_none());

    let record = plugininstall::record(&harness.state, "demo")
        .await
        .expect("reads the record")
        .expect("a record exists");
    assert_eq!(record.state, PluginState::Pending);
    assert!(
        record.capabilities_approved.is_empty(),
        "a pending record must not claim a grant nobody made"
    );
    assert!(record.approved_at.is_none());
    assert!(record.installed_by.is_some(), "the installer is recorded");

    // The structural half of "pending installs cannot be fetched": the package is not in
    // the served root, so the registry cannot know about it and no route can reach it.
    assert!(
        harness
            .pending("demo", "1.0.0")
            .join("manifest.json")
            .is_file()
    );
    assert!(!harness.served("demo", "1.0.0").exists());
    let registry = plugins::registry(&harness.state.config);
    assert!(
        registry.get("demo", "1.0.0").is_none(),
        "a pending package is being served"
    );

    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_dropped_package_lands_as_pending_too_and_the_archive_is_kept() {
    let Some(harness) = Harness::start("drop").await else {
        return;
    };

    let inbox = harness.dir.join("inbox");
    let built = harness.package("dropped", &manifest("dropped", "2.1.0"), false);
    let dropped = inbox.join("dropped-2.1.0.zip");
    fs::rename(&built, &dropped).expect("drop it in");

    let attempted = plugininstall::watcher::scan_once(&harness.state, &inbox).await;
    assert_eq!(attempted, 1);

    let record = plugininstall::record(&harness.state, "dropped")
        .await
        .expect("reads")
        .expect("a record");
    assert_eq!(
        record.state,
        PluginState::Pending,
        "a drop is not an approval (SPEC §6.2)"
    );
    assert!(matches!(record.source, InstallSource::Directory { .. }));

    // The archive is moved aside, not deleted, and not left where the next poll would
    // retry it forever.
    assert!(!dropped.exists());
    let installed: Vec<String> = fs::read_dir(inbox.join("installed"))
        .expect("the installed subdirectory")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(installed.len(), 1);
    assert!(installed[0].ends_with("dropped-2.1.0.zip"));

    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_refused_drop_is_moved_to_rejected_with_the_reason() {
    let Some(harness) = Harness::start("drop-bad").await else {
        return;
    };

    let inbox = harness.dir.join("inbox");
    let bad = inbox.join("broken.zip");
    fs::write(&bad, b"not a zip at all").expect("write");

    plugininstall::watcher::scan_once(&harness.state, &inbox).await;

    assert!(!bad.exists());
    let rejected: Vec<String> = fs::read_dir(inbox.join("rejected"))
        .expect("the rejected subdirectory")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(
        rejected.len(),
        2,
        "the archive and its .error.txt: {rejected:?}"
    );
    assert!(rejected.iter().any(|name| name.ends_with(".error.txt")));

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn approval_is_the_rename_and_records_who_approved() {
    let Some(harness) = Harness::start("approve").await else {
        return;
    };

    let archive = harness.package("demo", &manifest("demo", "1.0.0"), false);
    harness.install(archive).await.expect("installs");

    let admin = new_id();
    let record = plugininstall::approve(
        &harness.state,
        "demo",
        "1.0.0",
        PluginCapabilities::default(),
        &Actor::User(admin.clone()),
    )
    .await
    .expect("approves");

    assert_eq!(record.state, PluginState::Enabled);
    assert_eq!(
        record.approved_by.as_deref(),
        Some(admin.as_str()),
        "the audit trail needs who clicked (SPEC §5.4)"
    );
    assert!(record.approved_at.is_some());

    // The rename *is* the activation of serving.
    assert!(
        harness
            .served("demo", "1.0.0")
            .join("manifest.json")
            .is_file()
    );
    assert!(!harness.pending("demo", "1.0.0").exists());
    let registry = plugins::registry(&harness.state.config);
    let served = registry.get("demo", "1.0.0").expect("now served");
    assert_eq!(served.state, PluginState::Enabled);

    // And the audit log has the entry.
    let audited = harness
        .state
        .collections
        .raw("audit_log")
        .count_documents(bson::doc! { "action": "plugin.approve", "target_id": "demo" })
        .await
        .expect("counts");
    assert_eq!(audited, 1);

    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn approving_twice_is_a_conflict_not_a_second_rename() {
    let Some(harness) = Harness::start("approve-twice").await else {
        return;
    };

    let archive = harness.package("demo", &manifest("demo", "1.0.0"), false);
    harness.install(archive).await.expect("installs");
    plugininstall::approve(
        &harness.state,
        "demo",
        "1.0.0",
        PluginCapabilities::default(),
        &Actor::System,
    )
    .await
    .expect("approves");

    let error = plugininstall::approve(
        &harness.state,
        "demo",
        "1.0.0",
        PluginCapabilities::default(),
        &Actor::System,
    )
    .await
    .expect_err("must refuse");
    assert!(matches!(error, InstallError::Conflict(_)), "{error}");

    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn an_approval_may_widen_http_hosts_and_nothing_else() {
    let Some(harness) = Harness::start("widen").await else {
        return;
    };

    // The calendar's shape: it asks for document access and for `http` with **no** hosts,
    // because the operator who enters the feed URL is the one who knows the host.
    let requested = r#"{"id":"cal","version":"1.0.0","kernel":"^2.0",
        "capabilities":{"documents":["read","write"],"http":{"hosts":[]}},
        "frontend":{"module":"frontend/index.mjs"}}"#;
    let archive = harness.package("cal", requested, false);
    harness.install(archive).await.expect("installs");

    // Adding a right the package never asked for is refused…
    let mut illegal = PluginCapabilities {
        documents: vec!["read".into(), "write".into()],
        ..PluginCapabilities::default()
    };
    illegal.notifications = true;
    let error = plugininstall::approve(&harness.state, "cal", "1.0.0", illegal, &Actor::System)
        .await
        .expect_err("must refuse an added capability");
    assert!(matches!(error, InstallError::Config(_)), "{error}");

    // …and the package is still pending, so a refused approval changes nothing.
    let record = plugininstall::record(&harness.state, "cal")
        .await
        .expect("reads")
        .expect("a record");
    assert_eq!(record.state, PluginState::Pending);

    // Narrowing the documents right and widening `http.hosts` is the legal move.
    let granted = PluginCapabilities {
        documents: vec!["read".into()],
        http: Some(HttpCapability {
            hosts: vec!["calendar.example.com".into()],
        }),
        notifications: false,
        public_routes: Vec::new(),
    };
    let record = plugininstall::approve(&harness.state, "cal", "1.0.0", granted, &Actor::System)
        .await
        .expect("approves");
    assert_eq!(record.state, PluginState::Enabled);
    assert_eq!(
        record.capabilities_approved.http_hosts(),
        vec!["calendar.example.com".to_string()]
    );
    assert!(record.capabilities_approved.can_read_documents());
    assert!(
        !record.capabilities_approved.can_write_documents(),
        "the approved set is what the host enforces, and it was narrowed"
    );

    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_rejected_package_leaves_nothing_behind() {
    let Some(harness) = Harness::start("reject").await else {
        return;
    };

    let archive = harness.package("demo", &manifest("demo", "1.0.0"), false);
    harness.install(archive).await.expect("installs");
    plugininstall::reject(&harness.state, "demo", "1.0.0", &Actor::System)
        .await
        .expect("rejects");

    assert!(!harness.pending("demo", "1.0.0").exists());
    assert!(!harness.served("demo", "1.0.0").exists());
    assert!(
        plugininstall::record(&harness.state, "demo")
            .await
            .expect("reads")
            .is_none()
    );

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// Upgrade
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn an_upgrade_replaces_the_version_and_keeps_the_kv() {
    let Some(harness) = Harness::start("upgrade").await else {
        return;
    };

    let archive = harness.package("demo", &manifest("demo", "1.0.0"), false);
    harness.install(archive).await.expect("installs");
    plugininstall::approve(
        &harness.state,
        "demo",
        "1.0.0",
        PluginCapabilities::default(),
        &Actor::System,
    )
    .await
    .expect("approves");

    // The plugin has state. An upgrade must not touch it (SPEC §6.2: "upgrade path —
    // replace version, keep KV").
    harness
        .state
        .collections
        .raw("plugin_kv")
        .insert_one(bson::doc! {
            "_id": "demo:cursor", "plugin_id": "demo", "key": "cursor",
            "value": "2026-09-01", "updated_at": bson::DateTime::now(),
        })
        .await
        .expect("writes kv");

    // The same version again is refused…
    let again = harness.package("demo", &manifest("demo", "1.0.0"), false);
    let error = harness.install(again).await.expect_err("must refuse");
    assert!(
        matches!(error, InstallError::AlreadyInstalled { .. }),
        "{error}"
    );

    // …a new one is an upgrade.
    let newer = harness.package("demo", &manifest("demo", "1.1.0"), false);
    let outcome = harness.install(newer).await.expect("installs the upgrade");
    assert_eq!(outcome.replaced.as_deref(), Some("1.0.0"));
    plugininstall::approve(
        &harness.state,
        "demo",
        "1.1.0",
        PluginCapabilities::default(),
        &Actor::System,
    )
    .await
    .expect("approves the upgrade");

    assert!(
        harness
            .served("demo", "1.1.0")
            .join("manifest.json")
            .is_file()
    );
    assert!(
        !harness.served("demo", "1.0.0").exists(),
        "the superseded version is pruned; two versions in one page would be two copies of one plugin's API"
    );
    let record = plugininstall::record(&harness.state, "demo")
        .await
        .expect("reads")
        .expect("a record");
    assert_eq!(record.version, "1.1.0");

    let kv = harness
        .state
        .collections
        .raw("plugin_kv")
        .count_documents(bson::doc! { "plugin_id": "demo" })
        .await
        .expect("counts");
    assert_eq!(kv, 1, "an upgrade must keep the plugin's KV");

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires MONGO_URI"]
async fn the_mongo_lock_serializes_two_concurrent_installs() {
    let Some(harness) = Harness::start("serialize").await else {
        return;
    };

    // `with_lock` is the Mongo lock alone — `queued` puts an in-process mutex in front of
    // it, which would make this pass even if the database lock did nothing.
    let inside = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));

    let mut handles = Vec::new();
    for index in 0..4 {
        let state = harness.state.clone();
        let inside = Arc::clone(&inside);
        let peak = Arc::clone(&peak);
        handles.push(tokio::spawn(async move {
            plugininstall::queue::with_lock(&state, &format!("worker-{index}"), async || {
                let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                inside.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            })
            .await
        }));
    }

    let mut held = 0;
    let mut refused = 0;
    for handle in handles {
        match handle.await.expect("the task") {
            Ok(()) => held += 1,
            Err(InstallError::Locked) => refused += 1,
            Err(err) => panic!("unexpected error: {err}"),
        }
    }

    assert_eq!(
        peak.load(Ordering::SeqCst),
        1,
        "two installs held the lock at once"
    );
    assert_eq!(held + refused, 4);
    assert!(held >= 1);
    // 4 × 150 ms is well inside `LOCK_WAIT`, so nobody should have given up.
    assert_eq!(refused, 0, "a waiter gave up inside the wait window");

    // And the lock is released: the next caller gets it immediately.
    let lock = plugininstall::queue::acquire(&harness.state, "after")
        .await
        .expect("the lock is free again");
    assert_eq!(
        plugininstall::queue::holder(&harness.state)
            .await
            .expect("reads the holder")
            .as_deref(),
        Some("after")
    );
    lock.release().await;
    assert!(
        plugininstall::queue::holder(&harness.state)
            .await
            .expect("reads the holder")
            .is_none()
    );

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// Uninstall and purge
// ---------------------------------------------------------------------------

/// A document with a `%%% demo` machine section, materialized.
async fn document_with_section(state: &AppState) -> String {
    let text = "---\ntitle: Event\n---\n\n# Event\n\n%%% demo\nsource_uid: abc123\n%%%\n";
    let written = state
        .docs
        .create(None, text, &Actor::System)
        .await
        .expect("creates the document");
    // Force the materialization the purge job's query reads.
    state.docs.get(&written.id).await.expect("materializes");
    written.id
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn uninstall_keeps_kv_config_and_sections_by_default() {
    let Some(harness) = Harness::start("uninstall").await else {
        return;
    };

    let archive = harness.package("demo", &manifest("demo", "1.0.0"), false);
    harness.install(archive).await.expect("installs");
    plugininstall::approve(
        &harness.state,
        "demo",
        "1.0.0",
        PluginCapabilities::default(),
        &Actor::System,
    )
    .await
    .expect("approves");

    let document = document_with_section(&harness.state).await;
    harness
        .state
        .collections
        .raw("plugin_kv")
        .insert_one(bson::doc! {
            "_id": "demo:cursor", "plugin_id": "demo", "key": "cursor",
            "value": "x", "updated_at": bson::DateTime::now(),
        })
        .await
        .expect("writes kv");

    plugininstall::uninstall(&harness.state, "demo", false, &Actor::System)
        .await
        .expect("uninstalls");

    // The artifacts and the record go…
    assert!(!harness.served("demo", "1.0.0").exists());
    assert!(
        plugininstall::record(&harness.state, "demo")
            .await
            .expect("reads")
            .is_none()
    );
    // …and the data stays, so a reinstall is lossless.
    let kv = harness
        .state
        .collections
        .raw("plugin_kv")
        .count_documents(bson::doc! { "plugin_id": "demo" })
        .await
        .expect("counts");
    assert_eq!(kv, 1, "KV is retained by default (SPEC §6.2)");
    let text = harness.state.docs.text(&document).await.expect("reads");
    assert!(
        text.contains("%%% demo"),
        "the machine section is retained by default"
    );

    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn purge_removes_the_kv_the_config_and_the_machine_sections() {
    let Some(harness) = Harness::start("purge").await else {
        return;
    };

    let archive = harness.package("demo", &manifest("demo", "1.0.0"), false);
    harness.install(archive).await.expect("installs");
    plugininstall::approve(
        &harness.state,
        "demo",
        "1.0.0",
        PluginCapabilities::default(),
        &Actor::System,
    )
    .await
    .expect("approves");

    let first = document_with_section(&harness.state).await;
    let second = document_with_section(&harness.state).await;
    harness
        .state
        .collections
        .raw("plugin_kv")
        .insert_one(bson::doc! {
            "_id": "demo:cursor", "plugin_id": "demo", "key": "cursor",
            "value": "x", "updated_at": bson::DateTime::now(),
        })
        .await
        .expect("writes kv");
    harness
        .state
        .collections
        .raw("plugin_config")
        .insert_one(bson::doc! {
            "_id": "demo", "values": { "feed_url": "https://example.com/x.ics" },
            "updated_at": bson::DateTime::now(),
        })
        .await
        .expect("writes config");

    plugininstall::uninstall(&harness.state, "demo", true, &Actor::System)
        .await
        .expect("uninstalls with purge");

    assert_eq!(
        harness
            .state
            .collections
            .raw("plugin_kv")
            .count_documents(bson::doc! { "plugin_id": "demo" })
            .await
            .expect("counts"),
        0,
        "purge clears the KV namespace"
    );
    assert_eq!(
        harness
            .state
            .collections
            .raw("plugin_config")
            .count_documents(bson::doc! { "_id": "demo" })
            .await
            .expect("counts"),
        0,
        "purge clears the configuration and its secrets"
    );

    // The section strip is a background job, and it is also callable directly — which is
    // what makes it resumable. Running it here is deterministic where awaiting the spawned
    // task would not be; `remove_section` is idempotent, so the two cannot conflict.
    let stripped = plugininstall::purge_sections(&harness.state, "demo")
        .await
        .expect("the purge job runs");
    assert!(stripped <= 2);

    for document in [&first, &second] {
        let text = harness.state.docs.text(document).await.expect("reads");
        assert!(
            !text.contains("%%% demo"),
            "the machine section survived the purge: {text:?}"
        );
        assert!(
            text.contains("# Event"),
            "the purge removed more than the plugin's own section: {text:?}"
        );
    }

    // Idempotent: a second run has nothing left to do.
    assert_eq!(
        plugininstall::purge_sections(&harness.state, "demo")
            .await
            .expect("runs again"),
        0
    );

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// Validation, end to end
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_package_for_another_kernel_major_never_reaches_the_filesystem() {
    let Some(harness) = Harness::start("kernel").await else {
        return;
    };

    // A 1.x package: `@kernel` 2.0 removed what it was written against.
    let future = r#"{"id":"demo","version":"1.0.0","kernel":"^1.0","frontend":{"module":"frontend/index.mjs"}}"#;
    let archive = harness.package("demo", future, false);
    let error = harness.install(archive).await.expect_err("must refuse");
    assert!(
        matches!(error, InstallError::KernelIncompatible { .. }),
        "{error}"
    );

    assert!(!harness.pending("demo", "1.0.0").exists());
    assert!(!harness.served("demo", "1.0.0").exists());
    assert!(
        plugininstall::record(&harness.state, "demo")
            .await
            .expect("reads")
            .is_none(),
        "a refused package must not leave a record"
    );
    // Not even a working directory.
    let work = harness.dir.join("staging").join("work").join("demo");
    assert!(
        !work.exists()
            || fs::read_dir(&work)
                .map(|mut d| d.next().is_none())
                .unwrap_or(true),
        "the working directory was left behind"
    );

    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_manifest_with_dependencies_is_refused_and_rolls_back() {
    let Some(harness) = Harness::start("dependency").await else {
        return;
    };

    // `dependencies` was removed in `@kernel` 2.0: `consumes` ports replace it.
    let needy = r#"{"id":"needy","version":"1.0.0","kernel":"^2.0",
        "dependencies":{"folders":"^2.0"},
        "frontend":{"module":"frontend/index.mjs"}}"#;
    let archive = harness.package("needy", needy, false);
    let error = harness.install(archive).await.expect_err("must refuse");
    assert!(error.to_string().contains("dependencies"), "{error}");
    assert!(!harness.pending("needy", "1.0.0").exists());

    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_backend_half_without_the_abi_export_is_refused() {
    let Some(harness) = Harness::start("abi").await else {
        return;
    };

    let with_backend = r#"{"id":"demo","version":"1.0.0","kernel":"^2.0",
        "backend":{"module":"backend.wasm"},
        "frontend":{"module":"frontend/index.mjs"}}"#;

    // A module that is not one: the static export scan refuses it before an admin can
    // approve something that would only fail at activation.
    let path = harness.dir.join("bad.zip");
    let file = fs::File::create(&path).expect("create");
    let mut writer = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default();
    writer
        .start_file("manifest.json", options)
        .expect("manifest");
    writer.write_all(with_backend.as_bytes()).expect("write");
    writer
        .start_file("frontend/index.mjs", options)
        .expect("module");
    writer
        .write_all(b"export function activate(){}\n")
        .expect("write");
    writer.start_file("backend.wasm", options).expect("wasm");
    writer.write_all(b"definitely not wasm").expect("write");
    writer.finish().expect("finish");

    let error = harness.install(path).await.expect_err("must refuse");
    assert!(matches!(error, InstallError::Manifest(_)), "{error}");
    assert!(!harness.pending("demo", "1.0.0").exists());

    // The same package with a module that does export it installs.
    let good = harness.package("demo", with_backend, true);
    let outcome = harness.install(good).await.expect("installs");
    assert_eq!(outcome.state, PluginState::Pending);
    let record = plugininstall::record(&harness.state, "demo")
        .await
        .expect("reads")
        .expect("a record");
    assert_eq!(
        record.module_sha256.as_ref().map(|hex| hex.len()),
        Some(64),
        "the approved module is fingerprinted"
    );

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// Adoption, and the registry reflecting the records
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn plugins_already_on_disk_are_adopted_as_approved() {
    let Some(harness) = Harness::start("adopt").await else {
        return;
    };

    // The M3 world: a directory, no record.
    let dir = harness.served("legacy", "1.2.0");
    fs::create_dir_all(dir.join("frontend")).expect("a plugin directory");
    fs::write(dir.join("manifest.json"), manifest("legacy", "1.2.0")).expect("manifest");
    fs::write(
        dir.join("frontend/index.mjs"),
        b"export function activate(){}\n",
    )
    .expect("module");

    let adopted = plugininstall::adopt_installed_directory(&harness.state)
        .await
        .expect("adopts");
    assert_eq!(adopted, 1);

    let record = plugininstall::record(&harness.state, "legacy")
        .await
        .expect("reads")
        .expect("a record");
    assert_eq!(record.state, PluginState::Enabled);
    assert_eq!(record.version, "1.2.0");

    // Adoption is idempotent: a second boot adopts nothing new.
    assert_eq!(
        plugininstall::adopt_installed_directory(&harness.state)
            .await
            .expect("adopts again"),
        0
    );

    // And a disabled record now demotes the served entry — the wiring M4 left open.
    plugininstall::disable(&harness.state, "legacy", "admin", &Actor::System)
        .await
        .expect("disables");
    let registry = plugins::registry(&harness.state.config);
    let served = registry.get("legacy", "1.2.0").expect("still served");
    assert_eq!(
        served.state,
        PluginState::Disabled,
        "/api/plugins must report the record's state, not the directory's"
    );

    plugininstall::enable(&harness.state, "legacy", &Actor::System)
        .await
        .expect("enables");
    let registry = plugins::registry(&harness.state.config);
    assert_eq!(
        registry.get("legacy", "1.2.0").expect("served").state,
        PluginState::Enabled
    );

    harness.cleanup().await;
}

/// The other half of reconciliation: a package that is gone.
///
/// An image that stops shipping a plugin says nothing to the database, so without this the
/// record outlives its artifacts — listed in admin as `enabled`, activated by the host against
/// a `backend.wasm` that is not there, and fetched by every client that remembers the plugin
/// list from its last boot (a 404 per module). Disabling the record is what makes the removal
/// complete; keeping the record *and* the plugin's data is what keeps it reversible.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_plugin_whose_package_is_gone_is_retired_and_keeps_its_data() {
    let Some(harness) = Harness::start("prune").await else {
        return;
    };

    for (id, version) in [("staying", "1.0.0"), ("going", "2.0.0")] {
        let dir = harness.served(id, version);
        fs::create_dir_all(dir.join("frontend")).expect("a plugin directory");
        fs::write(dir.join("manifest.json"), manifest(id, version)).expect("manifest");
        fs::write(
            dir.join("frontend/index.mjs"),
            b"export function activate(){}\n",
        )
        .expect("module");
    }
    assert_eq!(
        plugininstall::adopt_installed_directory(&harness.state)
            .await
            .expect("adopts"),
        2
    );

    // State the plugin owns, of both kinds retention covers.
    harness
        .state
        .collections
        .raw("plugin_kv")
        .insert_one(bson::doc! {
            "_id": "going:cursor", "plugin_id": "going", "key": "cursor",
            "value": "2026-09-01", "updated_at": bson::DateTime::now(),
        })
        .await
        .expect("writes kv");
    harness
        .state
        .collections
        .raw("plugin_config")
        .insert_one(bson::doc! {
            "_id": "going", "values": { "feed": "https://x.test/f" },
            "updated_at": bson::DateTime::now(),
        })
        .await
        .expect("writes config");

    // The image stopped shipping it.
    fs::remove_dir_all(
        harness
            .served("going", "2.0.0")
            .parent()
            .expect("the id dir"),
    )
    .expect("removes the package");

    plugininstall::adopt_installed_directory(&harness.state)
        .await
        .expect("reconciles");

    let gone = plugininstall::record(&harness.state, "going")
        .await
        .expect("reads")
        .expect("the record survives; only the plugin is switched off");
    assert_eq!(
        gone.state,
        PluginState::Disabled,
        "a record left `enabled` with no package is a ghost: admin lists it as running and \
         the host activates a module that is not there"
    );
    assert_eq!(
        gone.disabled_reason.as_deref(),
        Some(plugininstall::ABSENT_DISABLED_REASON),
        "the reason is the marker, so a directory that comes back can be told from a plugin \
         a person switched off"
    );
    assert_eq!(
        plugininstall::record(&harness.state, "staying")
            .await
            .expect("reads")
            .expect("a record")
            .state,
        PluginState::Enabled,
        "the plugin that is still on disk must be untouched"
    );
    let registry = plugins::registry(&harness.state.config);
    assert!(registry.get("going", "2.0.0").is_none());
    assert!(registry.get("staying", "1.0.0").is_some());

    // Idempotent: this pass runs on every boot, so a second one must change nothing and say
    // nothing. (`adopted` counts directories written, and there is still exactly one.)
    assert_eq!(
        plugininstall::adopt_installed_directory(&harness.state)
            .await
            .expect("reconciles again"),
        0,
        "a record already disabled for absence must not be rewritten on every boot"
    );

    // Retiring is an uninstall, not a purge (SPEC §6.2): the data survives a reinstall.
    for (collection, filter) in [
        ("plugin_kv", bson::doc! { "plugin_id": "going" }),
        ("plugin_config", bson::doc! { "_id": "going" }),
    ] {
        assert_eq!(
            harness
                .state
                .collections
                .raw(collection)
                .count_documents(filter)
                .await
                .expect("counts"),
            1,
            "{collection} must survive a retirement, exactly as it survives an uninstall"
        );
    }

    harness.cleanup().await;
}

/// An absence of one boot must not undo an admin's decisions.
///
/// This is the case retirement was written for and the one it originally broke. A plugin's
/// *record* is the only place two facts live: the capability set an admin chose on the
/// approval screen — possibly narrower than the manifest asked for, which is the whole point
/// of that screen (SPEC §6.2) — and whether they switched the plugin off afterwards. Deleting
/// the record threw both away, and the directory coming back was then re-adoption from
/// scratch: `Enabled`, with the **manifest's full request** granted, and no approval screen
/// in between. An absence of one boot is not exotic — an image that drops a plugin and a
/// rollback that restores it, an operator moving the directory aside, a half-finished volume
/// sync — and neither guard covers it, because other plugins are on disk and nothing is
/// pending.
///
/// Two plugins, because the two decisions recover differently: the one we switched off comes
/// back on, the one a person switched off stays off.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn an_absence_does_not_undo_a_narrowing_or_an_admin_disable() {
    let Some(harness) = Harness::start("absence-keeps-approval").await else {
        return;
    };

    let requested = |id: &str| {
        format!(
            r#"{{"id":"{id}","version":"1.0.0","kernel":"^2.0",
            "capabilities":{{"documents":["read","write"]}},
            "frontend":{{"module":"frontend/index.mjs"}}}}"#
        )
    };
    let narrowed = PluginCapabilities {
        documents: vec!["read".into()],
        ..PluginCapabilities::default()
    };

    for id in ["narrowed", "switched-off"] {
        let archive = harness.package(id, &requested(id), false);
        harness.install(archive).await.expect("installs");
        plugininstall::approve(
            &harness.state,
            id,
            "1.0.0",
            narrowed.clone(),
            &Actor::System,
        )
        .await
        .expect("approves, narrowed");
    }
    // One of them the admin then turns off, for a reason of their own.
    plugininstall::disable(
        &harness.state,
        "switched-off",
        "misbehaving",
        &Actor::System,
    )
    .await
    .expect("disables");

    // A third plugin stays on disk throughout, so guard 1 ("no plugins found at all") is
    // not what is being tested here.
    let anchor = harness.served("anchor", "1.0.0");
    fs::create_dir_all(anchor.join("frontend")).expect("a plugin directory");
    fs::write(anchor.join("manifest.json"), manifest("anchor", "1.0.0")).expect("manifest");
    fs::write(
        anchor.join("frontend/index.mjs"),
        b"export function activate(){}\n",
    )
    .expect("module");

    // --- The absence. Both directories move aside; neither is pending. -------------
    let aside = harness.dir.join("aside");
    fs::create_dir_all(&aside).expect("somewhere to put them");
    for id in ["narrowed", "switched-off"] {
        fs::rename(harness.state.config.plugins_dir.join(id), aside.join(id))
            .expect("moves the package aside");
    }

    plugininstall::adopt_installed_directory(&harness.state)
        .await
        .expect("reconciles");

    for id in ["narrowed", "switched-off"] {
        let record = plugininstall::record(&harness.state, id)
            .await
            .expect("reads")
            .unwrap_or_else(|| {
                panic!("{id}'s record must survive; deleting it loses the approval")
            });
        assert_eq!(record.state, PluginState::Disabled, "{id}");
        assert!(
            record.capabilities_approved.can_read_documents()
                && !record.capabilities_approved.can_write_documents(),
            "{id} must keep the narrowed grant: {:?}",
            record.capabilities_approved
        );
    }
    assert_eq!(
        plugininstall::record(&harness.state, "switched-off")
            .await
            .expect("reads")
            .expect("a record")
            .disabled_reason
            .as_deref(),
        Some("misbehaving"),
        "an admin's own reason is not overwritten by ours; it is what stops the re-enable below"
    );

    // --- The return. The image rolls back and both directories are there again. ----
    for id in ["narrowed", "switched-off"] {
        fs::rename(aside.join(id), harness.state.config.plugins_dir.join(id))
            .expect("puts the package back");
    }
    plugininstall::adopt_installed_directory(&harness.state)
        .await
        .expect("reconciles");

    let back = plugininstall::record(&harness.state, "narrowed")
        .await
        .expect("reads")
        .expect("a record");
    assert_eq!(
        back.state,
        PluginState::Enabled,
        "we switched it off because the file vanished, so we switch it back on"
    );
    assert_eq!(back.disabled_reason, None);
    assert!(
        back.capabilities_approved.can_read_documents()
            && !back.capabilities_approved.can_write_documents(),
        "and it comes back with what was approved, not with what the manifest asks for: {:?}",
        back.capabilities_approved
    );

    let still_off = plugininstall::record(&harness.state, "switched-off")
        .await
        .expect("reads")
        .expect("a record");
    assert_eq!(
        still_off.state,
        PluginState::Disabled,
        "an admin's disable is not ours to undo"
    );
    assert_eq!(still_off.disabled_reason.as_deref(), Some("misbehaving"));

    harness.cleanup().await;
}

/// The two cases that must **not** prune, because both look like "everything disappeared".
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn an_empty_plugins_dir_and_a_pending_upload_are_never_pruned() {
    let Some(harness) = Harness::start("prune-guards").await else {
        return;
    };

    let dir = harness.served("ondisk", "1.0.0");
    fs::create_dir_all(dir.join("frontend")).expect("a plugin directory");
    fs::write(dir.join("manifest.json"), manifest("ondisk", "1.0.0")).expect("manifest");
    fs::write(
        dir.join("frontend/index.mjs"),
        b"export function activate(){}\n",
    )
    .expect("module");
    plugininstall::adopt_installed_directory(&harness.state)
        .await
        .expect("adopts");

    // Guard 2: a pending package lives in staging and has *nothing* in the served root —
    // that is what pending means. Pruning it would delete what an admin is about to approve.
    let archive = harness.package("waiting", &manifest("waiting", "1.0.0"), false);
    harness.install(archive).await.expect("installs");
    assert!(!harness.served("waiting", "1.0.0").exists());

    plugininstall::adopt_installed_directory(&harness.state)
        .await
        .expect("reconciles");
    let pending = plugininstall::record(&harness.state, "waiting")
        .await
        .expect("reads")
        .expect("a pending record");
    assert_eq!(pending.state, PluginState::Pending);
    assert!(
        harness
            .pending("waiting", "1.0.0")
            .join("manifest.json")
            .is_file()
    );

    // Guard 1: an unreadable or unmounted PLUGINS_DIR reads as "no plugins on disk". It is
    // not an uninstall, and treating it as one would delete every approval over a mount that
    // comes back a minute later.
    fs::remove_dir_all(&harness.state.config.plugins_dir).expect("unmounts the volume");
    fs::create_dir_all(&harness.state.config.plugins_dir).expect("an empty served root");

    plugininstall::adopt_installed_directory(&harness.state)
        .await
        .expect("reconciles");
    for id in ["ondisk", "waiting"] {
        assert!(
            plugininstall::record(&harness.state, id)
                .await
                .expect("reads")
                .is_some(),
            "{id}'s record must survive an empty PLUGINS_DIR"
        );
    }

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// Config and secrets
// ---------------------------------------------------------------------------

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_secret_is_write_only_for_the_admin_and_readable_by_the_plugin() {
    let Some(harness) = Harness::start("secrets").await else {
        return;
    };

    let schema_json = r#"{"id":"cal","version":"1.0.0","kernel":"^2.0",
        "config":{"feed_url":{"type":"string","required":true},
                  "auth_header":{"type":"string","secret":true}},
        "frontend":{"module":"frontend/index.mjs"}}"#;
    let archive = harness.package("cal", schema_json, false);
    harness.install(archive).await.expect("installs");
    let record = plugininstall::record(&harness.state, "cal")
        .await
        .expect("reads")
        .expect("a record");
    let schema = record.manifest.config.clone();

    let mut values = serde_json::Map::new();
    values.insert(
        "feed_url".into(),
        serde_json::json!("https://calendar.example.com/x.ics"),
    );
    values.insert("auth_header".into(), serde_json::json!("Bearer hunter2"));
    plugininstall::config::set(&harness.state, "cal", &schema, values, &Actor::System)
        .await
        .expect("saves the form");

    // What the admin screen gets: the plain value, and a mask for the secret.
    let admin = plugininstall::config::for_admin(&harness.state, "cal", &schema)
        .await
        .expect("reads for the admin");
    assert_eq!(
        admin["values"]["feed_url"],
        serde_json::json!("https://calendar.example.com/x.ics")
    );
    assert_eq!(
        admin["values"]["auth_header"],
        serde_json::json!(plugininstall::config::SECRET_PLACEHOLDER),
        "a secret must never be echoed"
    );
    assert_eq!(admin["set"]["auth_header"], serde_json::json!(true));
    assert!(
        !serde_json::to_string(&admin)
            .expect("serializes")
            .contains("hunter2"),
        "the admin representation leaked the secret"
    );

    // What the plugin gets: the decrypted value.
    let plugin = plugininstall::config::for_plugin(&harness.state, "cal", &schema, None)
        .await
        .expect("reads for the plugin");
    assert_eq!(
        plugin.string("auth_header"),
        Some("Bearer hunter2"),
        "config_get decrypts — that is the point of the feature"
    );
    assert!(plugin.missing.is_empty());

    // The stored form is sealed, not plaintext.
    let stored = harness
        .state
        .collections
        .raw("plugin_config")
        .find_one(bson::doc! { "_id": "cal" })
        .await
        .expect("reads")
        .expect("a row");
    let rendered = format!("{stored:?}");
    assert!(
        !rendered.contains("hunter2"),
        "the secret is stored in plaintext: {rendered}"
    );

    // Re-saving the form with the mask keeps the secret; submitting a new one replaces it.
    let mut resubmit = serde_json::Map::new();
    resubmit.insert(
        "auth_header".into(),
        serde_json::json!(plugininstall::config::SECRET_PLACEHOLDER),
    );
    plugininstall::config::set(&harness.state, "cal", &schema, resubmit, &Actor::System)
        .await
        .expect("saves the form again");
    let plugin = plugininstall::config::for_plugin(&harness.state, "cal", &schema, None)
        .await
        .expect("reads");
    assert_eq!(
        plugin.string("auth_header"),
        Some("Bearer hunter2"),
        "saving a masked field overwrote the real secret"
    );

    // A value the schema does not declare is refused rather than stored.
    let mut stray = serde_json::Map::new();
    stray.insert("nope".into(), serde_json::json!("x"));
    let error = plugininstall::config::set(&harness.state, "cal", &schema, stray, &Actor::System)
        .await
        .expect_err("must refuse");
    assert!(matches!(error, InstallError::Config(_)), "{error}");

    // Clearing a key makes the plugin see it as unset.
    plugininstall::config::clear(&harness.state, "cal", "auth_header", &Actor::System)
        .await
        .expect("clears");
    let plugin = plugininstall::config::for_plugin(&harness.state, "cal", &schema, None)
        .await
        .expect("reads");
    assert!(plugin.string("auth_header").is_none());
    assert!(plugin.missing.contains(&"auth_header".to_string()));

    harness.cleanup().await;
}

// ---------------------------------------------------------------------------
// The approve window: rename, then record
// ---------------------------------------------------------------------------

/// Simulate a process that died between approval's `fs::rename` and its `save_record`: the
/// package is in the served root, the record still says `pending`.
///
/// That state used to be a dead end with no in-app way out — approve refused ("the pending
/// package … is no longer in <staging>"), re-uploading the same version was refused as already
/// installed, `reject` deleted the record and left the files, and boot's adoption pass saw
/// matching versions and skipped the row. An operator had to delete a directory by hand or bump
/// the version.
fn interrupt_after_rename(harness: &Harness, id: &str, version: &str) {
    let pending = harness.pending(id, version);
    let served = harness.served(id, version);
    fs::create_dir_all(served.parent().expect("a parent")).expect("the served id directory");
    fs::rename(&pending, &served).expect("the half of approve that did happen");
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn approving_again_finishes_an_interrupted_approval() {
    let Some(harness) = Harness::start("approve-interrupted").await else {
        return;
    };

    let archive = harness.package("demo", &manifest("demo", "1.0.0"), false);
    harness.install(archive).await.expect("installs");
    interrupt_after_rename(&harness, "demo", "1.0.0");

    // The route that serves plugin assets must refuse this: the record says pending, so the
    // registry entry does too, whatever the directory looks like.
    plugininstall::refresh_registry(&harness.state).await;
    let registry = plugins::registry(&harness.state.config);
    assert_eq!(
        registry.get("demo", "1.0.0").map(|plugin| plugin.state),
        Some(PluginState::Pending),
        "an interrupted approval must not be served"
    );
    assert!(
        !registry
            .get("demo", "1.0.0")
            .expect("the entry")
            .state
            .is_served()
    );

    let record = plugininstall::approve(
        &harness.state,
        "demo",
        "1.0.0",
        PluginCapabilities::default(),
        &Actor::System,
    )
    .await
    .expect("a second approve completes the interrupted one");
    assert_eq!(record.state, PluginState::Enabled);
    assert!(
        harness
            .served("demo", "1.0.0")
            .join("manifest.json")
            .is_file()
    );

    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn boot_unwinds_an_interrupted_approval_back_to_pending() {
    let Some(harness) = Harness::start("adopt-interrupted").await else {
        return;
    };

    let archive = harness.package("demo", &manifest("demo", "1.0.0"), false);
    harness.install(archive).await.expect("installs");
    interrupt_after_rename(&harness, "demo", "1.0.0");

    plugininstall::adopt_installed_directory(&harness.state)
        .await
        .expect("adopts");

    // Unwound, not completed: only the operator knows which capabilities they were granting,
    // and that is exactly what was never written down.
    assert!(
        harness
            .pending("demo", "1.0.0")
            .join("manifest.json")
            .is_file(),
        "the package belongs back in staging"
    );
    assert!(!harness.served("demo", "1.0.0").exists());
    let record = plugininstall::record(&harness.state, "demo")
        .await
        .expect("reads")
        .expect("a record");
    assert_eq!(
        record.state,
        PluginState::Pending,
        "adoption must never approve on the operator's behalf"
    );

    // And the normal approval works from there.
    plugininstall::approve(
        &harness.state,
        "demo",
        "1.0.0",
        PluginCapabilities::default(),
        &Actor::System,
    )
    .await
    .expect("approves");
    assert!(
        harness
            .served("demo", "1.0.0")
            .join("manifest.json")
            .is_file()
    );

    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn rejecting_an_interrupted_approval_removes_the_files_too() {
    let Some(harness) = Harness::start("reject-interrupted").await else {
        return;
    };

    let archive = harness.package("demo", &manifest("demo", "1.0.0"), false);
    harness.install(archive).await.expect("installs");
    interrupt_after_rename(&harness, "demo", "1.0.0");

    plugininstall::reject(&harness.state, "demo", "1.0.0", &Actor::System)
        .await
        .expect("rejects");

    // Deleting the record while leaving an unapproved package's frontend files in the served
    // root would leave nothing that knows they are unapproved.
    assert!(!harness.served("demo", "1.0.0").exists());
    assert!(!harness.pending("demo", "1.0.0").exists());
    assert!(
        plugininstall::record(&harness.state, "demo")
            .await
            .expect("reads")
            .is_none()
    );

    harness.cleanup().await;
}

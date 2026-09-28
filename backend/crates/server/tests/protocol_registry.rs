//! The protocol registry (PLUGIN-PROTOCOLS §3, §9 step 3): scanned from the served
//! plugins, kept in Mongo after its owner is gone, shipped in the plugin list, served at
//! `/protocols/<id>/<version>/index.d.ts`, and guarded at install by namespace claims and
//! `needs` keys.
//!
//! ```text
//! MONGO_URI=mongodb://127.0.0.1:27017 cargo test -p life-manager-server \
//!   --test protocol_registry -- --ignored
//! ```

mod common;

use std::fs;
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use life_manager_server::domain::{Actor, new_id};
use life_manager_server::plugininstall::{self, InstallError, InstallRequest, InstallSource};
use life_manager_server::state::AppState;
use life_manager_server::{protocols, routes, telemetry};
use zip::write::SimpleFileOptions;

const PANEL: &str = r#"{ "id": "acme/outline.panel", "version": "1.0.0", "kind": "slot", "owner": "acme-outline",
  "key": "id", "shape": { "object": { "id": "string", "title": "string", "component": "component" } } }"#;

struct Harness {
    state: AppState,
    addr: SocketAddr,
    dir: PathBuf,
}

impl Harness {
    async fn start(name: &str) -> Option<Harness> {
        let uri = common::mongo_uri()?;
        let dir =
            Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("protocols-{name}-{}", new_id()));
        let mut config = common::test_config(uri, format!("lm_protocols_test_{}", new_id()));
        config.plugins_dir = dir.join("served");
        config.plugin_staging_dir = dir.join("staging");

        let root = dir.join("served/acme-outline/1.0.0");
        fs::create_dir_all(root.join("frontend")).ok()?;
        fs::create_dir_all(root.join("protocols/outline.panel")).ok()?;
        fs::write(
            root.join("manifest.json"),
            r#"{"id":"acme-outline","version":"1.0.0","kernel":"^2.0","frontend":{"module":"frontend/index.mjs"},
                "provides":{"panel":{"protocol":"acme/outline.panel@1.0.0"}}}"#,
        )
        .ok()?;
        fs::write(
            root.join("frontend/index.mjs"),
            "export default function activate() {}\n",
        )
        .ok()?;
        fs::write(root.join("protocols/outline.panel/protocol.json"), PANEL).ok()?;
        fs::write(
            root.join("protocols/outline.panel/index.d.ts"),
            "export interface OutlinePanel { readonly id: string }\n",
        )
        .ok()?;

        let state = AppState::new(config.clone()).await.ok()?;
        state.init_schema().await.ok()?;
        plugininstall::adopt_installed_directory(&state)
            .await
            .ok()?;
        protocols::register_served(&state).await;

        let metrics = telemetry::init_metrics(&config).ok()?;
        let router = routes::router(state.clone(), metrics);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.ok()?;
        let addr = listener.local_addr().ok()?;
        tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });
        Some(Harness { state, addr, dir })
    }

    async fn get(&self, path: &str) -> (u16, String) {
        let response = reqwest::get(format!("http://{}{path}", self.addr))
            .await
            .expect("request");
        let status = response.status().as_u16();
        (status, response.text().await.unwrap_or_default())
    }

    fn package(&self, id: &str, protocol: Option<(&str, &str)>) -> PathBuf {
        let path = self.dir.join(format!("{id}-{}.zip", new_id()));
        let mut writer = zip::ZipWriter::new(fs::File::create(&path).expect("zip"));
        let options = SimpleFileOptions::default();
        writer.start_file("manifest.json", options).unwrap();
        writer
            .write_all(
                format!(r#"{{"id":"{id}","version":"1.0.0","kernel":"^2.0","frontend":{{"module":"frontend/index.mjs"}}}}"#)
                    .as_bytes(),
            )
            .unwrap();
        writer.start_file("frontend/index.mjs", options).unwrap();
        writer
            .write_all(b"export default function activate() {}\n")
            .unwrap();
        if let Some((name, json)) = protocol {
            writer
                .start_file(format!("protocols/{name}/protocol.json"), options)
                .unwrap();
            writer.write_all(json.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
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
                    filename: "package.zip".to_string(),
                },
                archive,
                actor: Actor::User(new_id()),
                auto_approve: false,
            },
        )
        .await
    }

    async fn cleanup(self) {
        let _ = self.state.db.drop().await;
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn a_protocol_is_served_and_outlives_its_owner() {
    let Some(harness) = Harness::start("outlives").await else {
        return;
    };

    let (status, types) = harness
        .get("/protocols/acme/outline.panel/1.0.0/index.d.ts")
        .await;
    assert_eq!(status, 200);
    assert!(types.contains("OutlinePanel"));
    let (status, _) = harness
        .get("/protocols/acme/outline.panel/9.9.9/index.d.ts")
        .await;
    assert_eq!(status, 404);

    plugininstall::uninstall(&harness.state, "acme-outline", false, &Actor::System)
        .await
        .expect("uninstalls");
    let known = protocols::all(&harness.state).await;
    assert!(
        known.contains_key("acme/outline.panel@1.0.0"),
        "the registry keeps a protocol after its owner is uninstalled"
    );
    let (status, _) = harness
        .get("/protocols/acme/outline.panel/1.0.0/protocol.json")
        .await;
    assert_eq!(status, 200);

    harness.cleanup().await;
}

#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn install_refuses_a_claimed_namespace_and_a_reserved_one() {
    let Some(harness) = Harness::start("claims").await else {
        return;
    };

    let impostor = r#"{ "id": "acme/other", "version": "1.0.0", "kind": "slot", "owner": "impostor",
      "shape": { "object": {} } }"#;
    let refused = harness
        .install(harness.package("impostor", Some(("other", impostor))))
        .await
        .expect_err("acme/ belongs to acme-outline");
    assert!(refused.to_string().contains("namespace"), "{refused}");

    let base_squatter = r#"{ "id": "lm/router", "version": "9.0.0", "kind": "service", "owner": "squatter",
      "shape": { "object": {} } }"#;
    let refused = harness
        .install(harness.package("squatter", Some(("router", base_squatter))))
        .await
        .expect_err("lm/ is reserved");
    assert!(refused.to_string().contains("reserved"), "{refused}");

    // A fresh namespace is claimed by whoever installs it first.
    let fresh = r#"{ "id": "zeta/thing", "version": "1.0.0", "kind": "event", "owner": "zeta",
      "shape": { "object": {} } }"#;
    harness
        .install(harness.package("zeta", Some(("thing", fresh))))
        .await
        .expect("a fresh namespace installs");

    harness.cleanup().await;
}

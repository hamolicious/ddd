//! Life Manager server library. `main.rs` is wiring only; everything else lives
//! in these modules so integration tests can drive the router directly.
//!
//! Module ownership (see `backend/CONTRACTS.md`):
//!
//! | Module | Area |
//! |---|---|
//! | `config`, `telemetry` | ops |
//! | `error`, `state`, `domain` | **frozen** — scaffold-owned |
//! | `db/*` | ops |
//! | `docstore` | docstore (trait itself frozen) |
//! | `feed` | sync (change-feed sequencing + queries; types frozen) |
//! | `plugins` | server-static (M3: registry + import map) → shared with install-flow (M4: manifest types, states, resolution) |
//! | `pluginhost/*` | wasm-host (M4: Extism host, limits, breaker, pool) + hooks-cron (`hooks.rs`, `cron.rs`) |
//! | `plugininstall/*` | install-flow (M4: zip, queue, watcher, config + secrets) |
//! | `auth` | auth |
//! | `routes/*` | http-routes; `routes/plugin_api.rs` is wasm-host + agenda-admin (M4) |
//!
//! Nobody adds a module here without agreement — a new module means a new owner.

pub mod auth;
pub mod changes;
pub mod config;
pub mod db;
pub mod docstore;
pub mod domain;
pub mod error;
pub mod feed;
pub mod manifest_schema;
pub mod manifest_types;
pub mod pluginhost;
pub mod plugininstall;
pub mod plugins;
pub mod routes;
pub mod state;
pub mod telemetry;

/// Crate version, reported by `/readyz`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

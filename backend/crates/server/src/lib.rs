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
//! | `plugins` | server-static (M3: installed-plugin registry + import map) |
//! | `auth` | auth |
//! | `routes/*` | http-routes |
//! | `seed` | http-routes |
//!
//! Nobody adds a module here without agreement — a new module means a new owner.

pub mod auth;
pub mod config;
pub mod db;
pub mod docstore;
pub mod domain;
pub mod error;
pub mod feed;
pub mod plugins;
pub mod routes;
pub mod seed;
pub mod state;
pub mod telemetry;

/// Crate version, reported by `/readyz`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

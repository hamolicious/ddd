//! Write a Life Manager backend plugin in Rust.
//!
//! This crate is a thin, typed skin over the host ABI in
//! [`life_manager_plugin_abi`] (prose form: `backend/HOST-ABI.md`). It adds no
//! behaviour of its own — every call is one Extism host call, every export is one Wasm
//! export the host looks for by name — so nothing here can hide a capability check or a
//! limit.
//!
//! # A whole plugin
//!
//! ```ignore
//! use life_manager_plugin_sdk as lm;
//!
//! lm::abi_version!();
//!
//! lm::cron!(sync);
//! fn sync(_schedule: lm::abi::cron::CronPayload) -> lm::Result<()> {
//!     let url = lm::config::require_string("feed_url")?;
//!     let response = lm::http::get(&url)?;
//!     let body = response.error_for_status()?.text()?;
//!     lm::documents::create(&format!("---\ntitle: Imported\n---\n\n{body}"))?;
//!     lm::kv::set("last_sync", &_schedule.fired_at)?;
//!     lm::log::info("feed imported");
//!     Ok(())
//! }
//! ```
//!
//! # The two rules worth internalising
//!
//! 1. **Share state through documents.** The backend writes documents; sync carries them
//!    to every client, offline included, searchable and editable (SPEC §1). [`events`] is
//!    for what genuinely cannot be a document, and [`kv`] is for high-frequency state no
//!    human reads.
//! 2. **Write your own section, or your own documents.** [`documents::splice_section`]
//!    touches only your `%%%` section; [`documents::rewrite`] works only on documents you
//!    created. There is no primitive that edits a human's prose, by design (SPEC §3.3).
//!
//! # Errors
//!
//! Every call returns [`Result`], whose error is a [`HostError`] carrying a stable
//! [`ErrorCode`]. A capability you did not declare is not a trap and not a panic: it is
//! `Err(ErrorCode::CapabilityDenied)`, so optional use is expressible (SPEC §6.2).

#![deny(missing_docs)]

pub use life_manager_plugin_abi as abi;

pub use abi::documents::{DocumentValue, SectionEdit};
pub use abi::error::{ErrorCode, HostError};
pub use abi::{Capabilities, Envelope, InitPayload, Origin};

/// Re-exported Extism PDK, for the rare plugin that needs the raw layer (its own
/// `plugin_fn` export, `extism_pdk::var`, a `Memory` trick).
pub mod pdk {
    pub use extism_pdk::*;
}

/// Re-exported so the export macros can name `serde_json` without the plugin crate
/// having to depend on it directly.
pub use serde_json;

pub mod config;
pub mod documents;
pub mod events;
pub mod host;
pub mod http;
pub mod kv;
pub mod log;
pub mod plugins;
pub mod runtime;

/// The result of every SDK call.
pub type Result<T> = core::result::Result<T, HostError>;

/// The ABI version this SDK speaks. [`abi_version!`] exports it.
pub const ABI_VERSION: u32 = abi::ABI_VERSION;

/// Export `lm_abi_version` — **required** in every plugin with a backend half.
///
/// The host re-checks this at activation and refuses a module built against another ABI
/// major, independently of the `kernel` range in the manifest. Two checks because they
/// catch different mistakes: the manifest can lie, and a stale `.wasm` can outlive the
/// manifest that describes it (SPEC §6.4, the same reasoning as the frontend loader's
/// per-plugin bundle check).
#[macro_export]
macro_rules! abi_version {
    () => {
        #[unsafe(no_mangle)]
        pub extern "C" fn lm_abi_version() -> i32 {
            $crate::runtime::emit_value(&$crate::ABI_VERSION)
        }
    };
}

/// Export `lm_init` — optional one-time setup, called with [`InitPayload`] before any
/// other export on that instance.
///
/// Instances are pooled and recycled, so this runs **once per instance**, not once per
/// plugin: it is the place for cheap preparation, not for a migration.
#[macro_export]
macro_rules! init {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn lm_init() -> i32 {
            $crate::runtime::dispatch_unit::<$crate::InitPayload, _>($handler)
        }
    };
}

/// Export `lm_hook_document_created`.
#[macro_export]
macro_rules! hook_document_created {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn lm_hook_document_created() -> i32 {
            $crate::runtime::dispatch_unit::<$crate::abi::hooks::DocumentEvent, _>($handler)
        }
    };
}

/// Export `lm_hook_document_changed`.
#[macro_export]
macro_rules! hook_document_changed {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn lm_hook_document_changed() -> i32 {
            $crate::runtime::dispatch_unit::<$crate::abi::hooks::DocumentEvent, _>($handler)
        }
    };
}

/// Export `lm_hook_document_deleted`.
#[macro_export]
macro_rules! hook_document_deleted {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn lm_hook_document_deleted() -> i32 {
            $crate::runtime::dispatch_unit::<$crate::abi::hooks::DocumentEvent, _>($handler)
        }
    };
}

/// Export `lm_cron` — every expression in `backend.cron` arrives here; dispatch on
/// [`abi::cron::CronPayload::index`].
#[macro_export]
macro_rules! cron {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn lm_cron() -> i32 {
            $crate::runtime::dispatch_unit::<$crate::abi::cron::CronPayload, _>($handler)
        }
    };
}

/// Export `lm_http` — every route in `backend.routes` arrives here.
#[macro_export]
macro_rules! http_routes {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn lm_http() -> i32 {
            $crate::runtime::dispatch::<
                $crate::abi::http::HttpRouteRequest,
                $crate::abi::http::HttpRouteResponse,
                _,
            >($handler)
        }
    };
}

/// Export `lm_call` — what `call_plugin` from a plugin that lists you in `backend.calls` reaches.
#[macro_export]
macro_rules! calls {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn lm_call() -> i32 {
            $crate::runtime::dispatch::<
                $crate::abi::call::CallPayload,
                $crate::serde_json::Value,
                _,
            >($handler)
        }
    };
}

/// Export `lm_event` — server-bus events this plugin subscribed to in `backend.events`.
#[macro_export]
macro_rules! events {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn lm_event() -> i32 {
            $crate::runtime::dispatch_unit::<$crate::abi::events::EventPayload, _>($handler)
        }
    };
}

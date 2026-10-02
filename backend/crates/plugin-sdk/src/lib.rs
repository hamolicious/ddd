pub use ddd_plugin_abi as abi;

pub use abi::documents::{DocumentValue, SectionEdit};
pub use abi::error::{ErrorCode, HostError};
pub use abi::{Capabilities, Envelope, InitPayload, Origin};

pub mod pdk {
    pub use extism_pdk::*;
}

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

pub type Result<T> = core::result::Result<T, HostError>;

pub const ABI_VERSION: u32 = abi::ABI_VERSION;

#[macro_export]
macro_rules! abi_version {
    () => {
        #[unsafe(no_mangle)]
        pub extern "C" fn ddd_abi_version() -> i32 {
            $crate::runtime::emit_value(&$crate::ABI_VERSION)
        }
    };
}

#[macro_export]
macro_rules! init {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn ddd_init() -> i32 {
            $crate::runtime::dispatch_unit::<$crate::InitPayload, _>($handler)
        }
    };
}

#[macro_export]
macro_rules! hook_document_created {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn ddd_hook_document_created() -> i32 {
            $crate::runtime::dispatch_unit::<$crate::abi::hooks::DocumentEvent, _>($handler)
        }
    };
}

#[macro_export]
macro_rules! hook_document_changed {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn ddd_hook_document_changed() -> i32 {
            $crate::runtime::dispatch_unit::<$crate::abi::hooks::DocumentEvent, _>($handler)
        }
    };
}

#[macro_export]
macro_rules! hook_document_deleted {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn ddd_hook_document_deleted() -> i32 {
            $crate::runtime::dispatch_unit::<$crate::abi::hooks::DocumentEvent, _>($handler)
        }
    };
}

#[macro_export]
macro_rules! cron {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn ddd_cron() -> i32 {
            $crate::runtime::dispatch_unit::<$crate::abi::cron::CronPayload, _>($handler)
        }
    };
}

#[macro_export]
macro_rules! http_routes {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn ddd_http() -> i32 {
            $crate::runtime::dispatch::<
                $crate::abi::http::HttpRouteRequest,
                $crate::abi::http::HttpRouteResponse,
                _,
            >($handler)
        }
    };
}

#[macro_export]
macro_rules! calls {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn ddd_call() -> i32 {
            $crate::runtime::dispatch::<
                $crate::abi::call::CallPayload,
                $crate::serde_json::Value,
                _,
            >($handler)
        }
    };
}

#[macro_export]
macro_rules! events {
    ($handler:path) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn ddd_event() -> i32 {
            $crate::runtime::dispatch_unit::<$crate::abi::events::EventPayload, _>($handler)
        }
    };
}

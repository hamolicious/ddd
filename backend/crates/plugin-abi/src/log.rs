//! `log` — the one host function that is not in SPEC §6.3's list, and the reason it is
//! here anyway.
//!
//! A Wasm module has no stdout worth having: Extism can capture WASI stdio, but a plugin
//! that prints is invisible in the server's structured JSON log (SPEC §8) — no plugin id,
//! no request id, no level, and nothing an operator can filter on. Without this, the only
//! way to debug a plugin is to make it fail.
//!
//! It is ungated, rate-limited per invocation, and its messages are attributed to the
//! plugin (`plugin=calendar`) so they can never be mistaken for the server's own.

use serde::{Deserialize, Serialize};

/// Mapped onto `tracing` levels. `Trace` is dropped unless the server runs at trace level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogInput {
    pub level: LogLevel,
    /// ≤ 4 KiB; longer messages are truncated with a marker rather than refused.
    pub message: String,
}

/// Log lines one invocation may emit before the rest are dropped (with one warning).
pub const MAX_LOG_LINES_PER_CALL: u32 = 100;
/// Longest message kept verbatim.
pub const MAX_LOG_MESSAGE_BYTES: usize = 4 * 1024;

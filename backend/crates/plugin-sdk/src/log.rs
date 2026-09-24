//! Logging into the server's structured log, attributed to this plugin.
//!
//! Extism's own `extism_pdk::info!` writes to the runtime's log; these go through the
//! `log` host function, which adds the plugin id and the invocation kind so an operator
//! can filter (`plugin=calendar`). Rate-limited per invocation
//! ([`abi::log::MAX_LOG_LINES_PER_CALL`](crate::abi::log::MAX_LOG_LINES_PER_CALL)); a
//! failed log call is dropped rather than propagated, because losing a call over a log
//! line would be absurd.

use crate::abi::log::{LogInput, LogLevel};
use crate::host;

fn emit(level: LogLevel, message: &str) {
    let _ = host::call::<LogInput, serde_json::Value>(
        host::log,
        &LogInput {
            level,
            message: message.to_string(),
        },
    );
}

/// Operational detail — a sync summary, a skipped item.
pub fn info(message: &str) {
    emit(LogLevel::Info, message);
}

/// Something an operator should look at: a feed that answered oddly, a config gap.
pub fn warn(message: &str) {
    emit(LogLevel::Warn, message);
}

/// A failure. Note that returning `Err` from a handler already logs — this is for the
/// failures you recover from.
pub fn error(message: &str) {
    emit(LogLevel::Error, message);
}

/// Development detail; visible only when the server runs at debug level.
pub fn debug(message: &str) {
    emit(LogLevel::Debug, message);
}

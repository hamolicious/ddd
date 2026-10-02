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

pub fn info(message: &str) {
    emit(LogLevel::Info, message);
}

pub fn warn(message: &str) {
    emit(LogLevel::Warn, message);
}

pub fn error(message: &str) {
    emit(LogLevel::Error, message);
}

pub fn debug(message: &str) {
    emit(LogLevel::Debug, message);
}

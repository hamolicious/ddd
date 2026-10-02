use serde::{Deserialize, Serialize};

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
    pub message: String,
}

pub const MAX_LOG_LINES_PER_CALL: u32 = 100;
pub const MAX_LOG_MESSAGE_BYTES: usize = 4 * 1024;

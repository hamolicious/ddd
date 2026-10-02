use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CronPayload {
    pub expression: String,
    pub index: u32,
    pub scheduled_for: String,
    pub fired_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<String>,
    #[serde(default)]
    pub missed: u32,
    pub deadline_ms: u64,
}

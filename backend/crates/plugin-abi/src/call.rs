use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallPluginInput {
    pub plugin: String,
    pub function: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallPluginOutput {
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallPayload {
    pub function: String,
    #[serde(default)]
    pub payload: Value,
    pub caller: String,
    pub depth: u32,
    pub deadline_ms: u64,
}

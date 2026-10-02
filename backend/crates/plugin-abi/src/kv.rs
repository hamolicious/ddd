use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KvGetInput {
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KvGetOutput {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    pub found: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KvSetInput {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default)]
    pub remove: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KvSetOutput {
    pub key: String,
    pub existed: bool,
    pub keys: u32,
}

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Origin;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmitInput {
    pub event: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmitOutput {
    pub event: String,
    pub subscribers: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmitClientInput {
    pub event: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmitClientOutput {
    pub event: String,
    pub sockets: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventPayload {
    pub event: String,
    #[serde(default)]
    pub payload: Value,
    pub origin: Origin,
    pub at: String,
}

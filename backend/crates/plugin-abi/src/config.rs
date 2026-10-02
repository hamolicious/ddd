use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::JsonMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConfigGetInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConfigGetOutput {
    #[serde(default)]
    pub values: JsonMap,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
}

impl ConfigGetOutput {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.values.get(key)
    }

    pub fn string(&self, key: &str) -> Option<&str> {
        self.values.get(key).and_then(Value::as_str)
    }
}

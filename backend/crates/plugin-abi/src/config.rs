//! `config_get` — the admin-entered configuration for this plugin (SPEC §6.2).
//!
//! The manifest declares a `config` schema; the admin UI writes `plugin_config`; the
//! backend half reads it here. Values declared `secret: true` are write-only in the UI
//! and encrypted at rest — **this function returns them decrypted**, which is the entire
//! point of the feature: outbound HTTP with credentials is the niche backend plugins
//! exist for (SPEC §6.3).
//!
//! Consequences, stated because they are load-bearing:
//!
//! - A secret is never pushed to a plugin (no `InitPayload.config`), only pulled — so an
//!   instance that never calls `config_get` never has the credential in its memory.
//! - The host never logs a config value, and never puts one in an error `detail`. A
//!   plugin that logs its own secret has leaked it; the SDK's `Debug` impls avoid it.
//! - No capability gates this: the configuration *is* the plugin's own.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::JsonMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConfigGetInput {
    /// One key, or all of them when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// Always a map — one entry when a key was named, every set key otherwise. One shape
/// means one typed accessor in the SDK instead of two near-identical ones.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConfigGetOutput {
    #[serde(default)]
    pub values: JsonMap,
    /// Keys the manifest declares that have **no** value yet, so a plugin can report
    /// "not configured" instead of failing mysteriously on the first HTTP call.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
}

impl ConfigGetOutput {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.values.get(key)
    }

    /// A string config value, the common case (`feed_url`, an API key).
    pub fn string(&self, key: &str) -> Option<&str> {
        self.values.get(key).and_then(Value::as_str)
    }
}

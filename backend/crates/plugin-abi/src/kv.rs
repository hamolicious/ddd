//! `kv_get` / `kv_set` — plugin-scoped key/value state.
//!
//! **This is where high-frequency machine state belongs** (SPEC §3.3): a sync cursor, an
//! ETag, a `last_seen` marker. Putting those in a document would grow its CRDT history
//! forever for data no human will ever read.
//!
//! The namespace is the plugin id and is supplied by the host — a plugin cannot read
//! another plugin's KV, and there is no parameter that would let it try. Uninstall keeps
//! KV by default so a reinstall is lossless (SPEC §6.2).
//!
//! **No capability gates KV.** A cron-and-KV plugin is the archetype SPEC §6.3 names,
//! and it should need no `documents` right at all.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KvGetInput {
    /// `^[A-Za-z0-9._:-]{1,256}$`.
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KvGetOutput {
    pub key: String,
    /// `None` **and** `found: false` when the key is absent; a stored JSON `null` comes
    /// back as `Some(Value::Null)` with `found: true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    pub found: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KvSetInput {
    pub key: String,
    /// Any JSON value, serialized ≤ [`crate::limits::MAX_KV_VALUE_BYTES`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    /// Delete the key. Deleting an absent key succeeds (`existed: false`).
    #[serde(default)]
    pub remove: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KvSetOutput {
    pub key: String,
    /// `true` when a value was already stored under the key.
    pub existed: bool,
    /// Keys this plugin now holds — the budget in
    /// [`crate::limits::MAX_KV_KEYS_PER_PLUGIN`] is visible rather than a surprise.
    pub keys: u32,
}

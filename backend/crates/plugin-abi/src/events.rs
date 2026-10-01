//! `emit` (server-side bus) and `emit_client` (relayed to browsers over the sync socket).
//!
//! **Documents first.** SPEC §1 is explicit: when the two halves of a plugin share state,
//! the backend writes *documents* and sync carries them everywhere, offline included.
//! Events are for what genuinely cannot be a document — "the sync finished", "re-render
//! now". They are ephemeral, fire-and-forget, at-most-once, and never replayed: a client
//! that was closed missed it (SPEC §6.3).
//!
//! **Names are namespaced by the host.** A plugin emits `"synced"`; subscribers see
//! `"calendar:synced"` on the server bus and `"plugin:calendar:synced"` in a browser.
//! A plugin cannot spoof another plugin's event, and the `kernel:` prefix stays reserved
//! for the kernel (`web/kernel-api/src/events.ts`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Origin;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmitInput {
    /// Unprefixed, `^[a-z0-9][a-z0-9._-]{0,63}$`. The host prefixes the plugin id.
    pub event: String,
    /// ≤ [`crate::limits::MAX_EVENT_PAYLOAD_BYTES`] serialized.
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmitOutput {
    /// The namespaced name the host published (`calendar:synced`).
    pub event: String,
    /// Backend plugins that subscribe to it (manifest `backend.events`). Zero is normal
    /// and not an error — an event with no listener is the usual state of an event bus.
    pub subscribers: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmitClientInput {
    pub event: String,
    #[serde(default)]
    pub payload: Value,
    /// Target one user's sessions. Absent ⇒ every connected session in the workspace
    /// (this is a shared workspace, SPEC §3.x — "every user" is a normal audience).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmitClientOutput {
    /// `plugin:<id>:<event>` — the type a frontend plugin listens for on
    /// `kernel.events.on(...)`.
    pub event: String,
    /// Sockets the frame was queued on. **Not** a delivery guarantee: a socket whose
    /// send queue is full drops it (PROTOCOL.md §6, backpressure), because the
    /// alternative is unbounded buffering of state nobody can replay anyway.
    pub sockets: u32,
}

/// What a subscribing plugin's `ddd_event` export receives.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventPayload {
    /// Namespaced (`calendar:synced`).
    pub event: String,
    #[serde(default)]
    pub payload: Value,
    /// The emitting plugin. Never the receiver: the host does not deliver a plugin its
    /// own events, for the same reason it does not deliver its own document hooks.
    pub origin: Origin,
    /// RFC 3339 UTC, when the emit happened.
    pub at: String,
}

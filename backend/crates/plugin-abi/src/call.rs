//! `call_plugin` — one backend plugin calling another (SPEC §6.3).
//!
//! Four rules, all enforced by the host and none of them optional:
//!
//! 1. **The callee must be a dependency** (manifest `dependencies` or
//!    `optionalDependencies`, `@kernel` 3.0), at a version inside the declared range, and
//!    **the function must be exported** (the callee's `backend.exports`). Either refusal is
//!    [`crate::ErrorCode::Forbidden`], not a lookup failure.
//! 2. **Shapes are checked.** The export's `input` shape before the call
//!    ([`crate::ErrorCode::InvalidArgument`]) and its `output` shape after
//!    ([`crate::ErrorCode::Internal`]: the callee broke its own contract).
//! 3. **No reentrancy.** A plugin already on the call stack cannot be re-entered —
//!    Extism instances are not reentrant, and the honest error is better than a
//!    deadlock or a second instance with half the first one's state.
//! 4. **Depth ≤ 3.** The whole chain also shares *one* deadline: a three-deep call
//!    tree does not get 15 seconds (see `backend/HOST-ABI.md`, Limits).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallPluginInput {
    /// The callee's plugin id — or an id it `provides`.
    pub plugin: String,
    /// The function name as the callee's `lm_call` dispatcher understands it, and as its
    /// `backend.exports` lists it — *not* a Wasm export name. Every invoked call lands on the single `lm_call` export
    /// (`crate::names::CALL`), which is what keeps the export surface fixed.
    pub function: String,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallPluginOutput {
    /// Whatever the callee returned. A callee refusal arrives as
    /// [`crate::Envelope::Err`] with the callee's own code, so a caller can tell "the
    /// callee said no" from "the host said no" by the message, and from
    /// [`crate::ErrorCode::Unavailable`] when the callee is disabled.
    #[serde(default)]
    pub value: Value,
}

/// What the callee's `lm_call` export receives.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallPayload {
    pub function: String,
    #[serde(default)]
    pub payload: Value,
    /// The calling plugin's id.
    pub caller: String,
    /// 1 for a call from a top-level invocation, up to
    /// [`crate::limits::MAX_CALL_DEPTH`].
    pub depth: u32,
    /// Milliseconds left on the shared deadline when the call was dispatched. A callee
    /// that needs more should refuse rather than be interrupted mid-write.
    pub deadline_ms: u64,
}

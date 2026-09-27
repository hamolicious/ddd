//! The **Wasm plugin host** (SPEC §6.3): instantiation, invocation, limits, and the
//! circuit breaker.
//!
//! # What a backend plugin is for
//!
//! Not a mirror of the client. Its niche is *cron while nobody's looking, outbound HTTP
//! with secrets, inbound webhooks* — and authoring machine-owned documents. Everything a
//! plugin can do from here is one of those four, and the host functions in [`host_fns`]
//! are deliberately the smallest set that covers them.
//!
//! # The shape of one call
//!
//! ```text
//!  cron tick / hook / HTTP route / call_plugin
//!            │
//!            ├─ breaker open?              → Unavailable, no instance touched
//!            ├─ pool.acquire(plugin)       → an instantiated, warm module
//!            ├─ spawn_blocking             → Extism calls block the thread
//!            │    └─ plugin.call(export, json)
//!            │          └─ host functions re-enter tokio via `Handle::block_on`
//!            ├─ deadline / trap / refusal  → recorded on the breaker
//!            └─ envelope out
//! ```
//!
//! Two structural facts drive that shape and are worth stating once:
//!
//! - **Extism calls are synchronous and non-reentrant.** So a call runs on a blocking
//!   thread ([`tokio::task::spawn_blocking`]), and an instance serves one call at a time
//!   ([`pool`]). The host functions inside it are *also* synchronous, and they reach the
//!   async world (Mongo, the sync hub) through a stored [`tokio::runtime::Handle`] —
//!   documented in [`host_fns::HostContext`], because it is the one place where a
//!   deadlock is imaginable and the rule ("never block on a task that needs this thread")
//!   has to be visible.
//! - **A plugin is hot-loaded and hot-unloaded** (SPEC §1). Activation compiles the
//!   module once ([`extism::CompiledPlugin`]) and instantiation is cheap; unload waits on
//!   in-flight calls through the pool's refcount rather than cancelling them mid-write.
//!
//! # Failure is a first-class outcome
//!
//! A refusal ([`abi::Envelope`] with `ok: false`) is a *successful* call: the host
//! answered, the plugin was told why. A timeout, a trap or an unreadable answer is a
//! failure, counted by [`breaker`]; five consecutive ones disable the plugin until an
//! admin re-enables it. The distinction is
//! [`abi::ErrorCode::is_plugin_fault`] — a plugin is never disabled for correctly
//! reporting that a document does not exist.
//!
//! **Owner:** the `wasm-host` builder (`backend/CONTRACTS.md`).

pub mod breaker;
pub mod cron;
pub mod hooks;
pub mod host_fns;
pub mod limits;
pub mod pool;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use life_manager_plugin_abi as abi;
use serde_json::Value;

use crate::error::AppError;
use crate::plugins::{ConfigField, PluginRecord, RouteSpec};
use crate::state::AppState;
use breaker::{BreakerState, BreakerTransition, CircuitBreaker};
use host_fns::HostContext;
use limits::{CallCounters, Deadline, PluginLimits, WriteLedger};
use pool::PluginPool;

/// The Extism namespace every host function lives in. Extism's own built-ins are in
/// `extism:host/env`, so nothing here can shadow them — and in particular the PDK's
/// `extism_pdk::http` is **not** this host's HTTP: `allowed_hosts` is left empty in the
/// Extism manifest so that path refuses, and outbound requests go through
/// [`host_fns`]'s `http_request`, which is the one with the allowlist, the IP policy and
/// the pinning (SPEC §6.2).
pub const HOST_NAMESPACE: &str = "extism:host/user";

/// An activated backend half: everything the host needs to route a call to it, resolved
/// once at activation so no hot path reads a manifest.
#[derive(Debug, Clone)]
pub struct ActivePlugin {
    pub id: String,
    pub version: String,
    /// **Approved**, not requested (SPEC §6.2): the admin's decision is what gates.
    pub capabilities: abi::Capabilities,
    /// Declared dependencies — the allowlist for `call_plugin`.
    pub dependencies: BTreeMap<String, String>,
    pub hooks: Vec<abi::hooks::HookKind>,
    pub cron: Vec<String>,
    pub routes: Vec<RouteSpec>,
    /// Server-bus events this plugin subscribes to (`backend.events`).
    pub events: Vec<String>,
    /// Config keys the manifest declares, with the secret ones marked — the host needs
    /// this to answer `config_get` without re-reading the manifest.
    pub config_keys: Vec<String>,
    /// The declared `config` schema itself.
    ///
    /// **Added to the scaffold's field list** (announced in the report): `config_keys` alone
    /// is not enough to answer `config_get`, which has to report *which declared keys have
    /// no value* — and that needs the declaration, not a list of the ones that do. Keeping
    /// the schema here is what lets the host answer without re-reading the record on every
    /// call. `config_keys` stays: it is what `lm_init` carries.
    pub config: BTreeMap<String, ConfigField>,
    pub wasm_path: PathBuf,
    /// Hex SHA-256 of the module, logged at activation and stored on the record. The
    /// answer to "is the running plugin the one I approved".
    pub module_sha256: String,
    /// What the module's `lm_abi_version` export reported.
    pub abi_version: u32,
    /// Exports the module actually has, so a hook is never scheduled for a plugin that
    /// cannot receive it.
    pub exports: Vec<String>,
}

impl ActivePlugin {
    /// `plugin:<id>` — the [`crate::domain::Actor`] every write of this plugin's is
    /// attributed to, and the string `created_by` ownership is checked against.
    pub fn actor(&self) -> crate::domain::Actor {
        crate::domain::Actor::Plugin(self.id.clone())
    }

    pub fn has_export(&self, name: &str) -> bool {
        self.exports.iter().any(|export| export == name)
    }

    pub fn subscribes_to(&self, hook: abi::hooks::HookKind) -> bool {
        self.hooks.contains(&hook) && self.has_export(hook.export_name())
    }
}

/// Why the host is invoking a plugin. Decides the export, the timeout and what a failure
/// means.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallKind {
    /// Once per instance, at activation.
    Init,
    Hook(abi::hooks::HookKind),
    /// `backend.cron[index]` fired.
    Cron {
        index: u32,
    },
    /// An inbound `/api/plugins/<id>/…` request.
    Route,
    /// `call_plugin` from `caller`.
    Invoked {
        caller: String,
        function: String,
    },
    /// A server-bus event from `emitter`.
    Event {
        emitter: String,
    },
}

impl CallKind {
    /// The Wasm export this kind lands on.
    pub fn export_name(&self) -> &'static str {
        match self {
            CallKind::Init => abi::names::INIT,
            CallKind::Hook(hook) => hook.export_name(),
            CallKind::Cron { .. } => abi::names::CRON,
            CallKind::Route => abi::names::HTTP,
            CallKind::Invoked { .. } => abi::names::CALL,
            CallKind::Event { .. } => abi::names::EVENT,
        }
    }

    /// Cron gets the long budget; everything else gets the short one (SPEC §6.3).
    pub fn timeout(&self, limits: &PluginLimits) -> Duration {
        match self {
            CallKind::Cron { .. } => limits.cron_timeout,
            _ => limits.call_timeout,
        }
    }

    /// A short label for logs and metrics (`kind="cron"`).
    pub fn label(&self) -> &'static str {
        match self {
            CallKind::Init => "init",
            CallKind::Hook(_) => "hook",
            CallKind::Cron { .. } => "cron",
            CallKind::Route => "route",
            CallKind::Invoked { .. } => "call",
            CallKind::Event { .. } => "event",
        }
    }
}

/// One invocation, fully specified.
///
/// `deadline` and `stack` are what make a `call_plugin` chain safe: the deadline is
/// **shared** by the whole chain (three nested calls do not get three timeouts), and the
/// stack is what detects reentrancy and bounds depth (SPEC §6.3).
#[derive(Debug, Clone)]
pub struct Invocation {
    pub plugin_id: String,
    pub kind: CallKind,
    pub payload: Value,
    pub deadline: Deadline,
    pub depth: u32,
    /// Plugin ids already on the call stack, outermost first.
    pub stack: Vec<String>,
    /// The user whose action started the chain, when there is one — the audit trail for a
    /// plugin route, and the default target for `emit_client`.
    pub user_id: Option<String>,
}

impl Invocation {
    /// A top-level invocation: depth 0, a fresh deadline from the kind's budget.
    pub fn top_level(
        plugin_id: impl Into<String>,
        kind: CallKind,
        payload: Value,
        limits: &PluginLimits,
    ) -> Self {
        let plugin_id = plugin_id.into();
        let deadline = Deadline::new(kind.timeout(limits));
        Self {
            stack: vec![plugin_id.clone()],
            plugin_id,
            kind,
            payload,
            deadline,
            depth: 0,
            user_id: None,
        }
    }

    pub fn with_user(mut self, user_id: Option<String>) -> Self {
        self.user_id = user_id;
        self
    }

    /// The nested invocation `call_plugin` produces. `Err` when it would re-enter a
    /// plugin already on the stack or exceed [`abi::limits::MAX_CALL_DEPTH`].
    ///
    /// The two refusals are *different* and are reported differently, because the fixes are
    /// different. Reentrancy is a design mistake in the plugin graph — `a → b → a` can never
    /// work, whatever the depth cap is, because an Extism instance cannot re-enter itself.
    /// Depth is a budget: the same chain with one fewer hop would have run.
    pub fn nested(
        &self,
        target: &str,
        function: &str,
        payload: Value,
    ) -> Result<Self, abi::HostError> {
        // Reentrancy before depth: `a → b → a` at depth 1 is still a cycle, and telling the
        // author "too deep" would send them to fix the wrong thing.
        if self.stack.iter().any(|on_stack| on_stack == target) {
            return Err(abi::HostError::new(
                abi::ErrorCode::Reentrancy,
                format!(
                    "`{target}` is already on this call stack ({}); an Extism instance cannot \
                     re-enter itself",
                    self.stack.join(" → ")
                ),
            )
            .with_detail(serde_json::json!({ "stack": self.stack, "plugin": target })));
        }
        let depth = self.depth + 1;
        if depth > abi::limits::MAX_CALL_DEPTH {
            return Err(abi::HostError::new(
                abi::ErrorCode::LimitExceeded,
                format!(
                    "a `call_plugin` chain may be at most {} deep; this would be {depth}",
                    abi::limits::MAX_CALL_DEPTH
                ),
            )
            .with_detail(serde_json::json!({
                "limit": abi::limits::MAX_CALL_DEPTH,
                "stack": self.stack,
            })));
        }

        let mut stack = self.stack.clone();
        stack.push(target.to_string());
        Ok(Self {
            plugin_id: target.to_string(),
            kind: CallKind::Invoked {
                caller: self.plugin_id.clone(),
                function: function.to_string(),
            },
            payload,
            // **Inherited, never fresh** (HOST-ABI.md §5): a three-deep chain does not get
            // three timeouts, and the callee sees what is left in `deadline_ms`.
            deadline: self.deadline.inherited(),
            depth,
            stack,
            user_id: self.user_id.clone(),
        })
    }

    /// The payload a callee's `lm_call` receives, with the remaining budget in it.
    fn call_payload(&self) -> Value {
        match &self.kind {
            CallKind::Invoked { caller, function } => {
                serde_json::to_value(abi::call::CallPayload {
                    function: function.clone(),
                    payload: self.payload.clone(),
                    caller: caller.clone(),
                    depth: self.depth,
                    deadline_ms: self.deadline.remaining_ms(),
                })
                .unwrap_or(Value::Null)
            }
            _ => self.payload.clone(),
        }
    }
}

/// What a completed call produced.
#[derive(Debug, Clone)]
pub struct CallOutcome {
    /// The plugin's returned value; `None` for a void export.
    pub value: Option<Value>,
    pub duration: Duration,
    /// Document writes the call made — recorded so the per-call cap is enforced and so a
    /// cron run's effect is loggable in one line.
    pub writes: u32,
    pub logs: u32,
    /// The plugin's own refusal, when it answered `{"ok": false, …}`.
    ///
    /// **Added to the scaffold's field list** (announced in the report). A refusal is a
    /// *successful* call — the machinery worked and the plugin was heard — so it cannot be
    /// the `Err` of [`PluginHost::call`], and [`PluginHostError`] deliberately has no
    /// `Refused` variant. Without this field a cron run that refused every time would read
    /// as a run that succeeded every time. [`PluginHost::call_typed`] turns it into an `Err`
    /// for the callers that want that.
    pub refusal: Option<abi::HostError>,
}

impl CallOutcome {
    /// `true` when the plugin answered with a refusal rather than a value.
    pub fn refused(&self) -> bool {
        self.refusal.is_some()
    }
}

/// Everything that can go wrong around a call. A *refusal by the plugin* is not here —
/// that arrives as [`CallOutcome`] carrying an error envelope the caller interprets.
#[derive(Debug, thiserror::Error)]
pub enum PluginHostError {
    #[error("plugin `{0}` is not active")]
    NotActive(String),
    #[error("plugin `{plugin}` does not export `{export}`")]
    NoExport { plugin: String, export: String },
    #[error("plugin `{plugin}` is disabled: {reason}")]
    Disabled { plugin: String, reason: String },
    #[error("plugin `{plugin}` exceeded its {budget_ms} ms budget")]
    Timeout { plugin: String, budget_ms: u64 },
    #[error("plugin `{plugin}` trapped: {message}")]
    Trap { plugin: String, message: String },
    #[error("plugin `{plugin}` answered with something this host cannot read: {message}")]
    BadResponse { plugin: String, message: String },
    #[error("plugin `{plugin}` was built against host ABI {found}, this server speaks {expected}")]
    AbiMismatch {
        plugin: String,
        expected: u32,
        found: u32,
    },
    #[error("no instance of `{plugin}` became available within {waited_ms} ms")]
    PoolExhausted { plugin: String, waited_ms: u64 },
    #[error("plugin `{plugin}` could not be instantiated: {message}")]
    Instantiate { plugin: String, message: String },
    #[error("the plugin host is shutting down")]
    ShuttingDown,
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl PluginHostError {
    /// `true` when the failure should count toward the circuit breaker.
    ///
    /// `NotActive`, `NoExport` and `Disabled` must not: they are *the host's own* routing
    /// decisions, and counting them would let a misconfigured hook disable a healthy
    /// plugin.
    pub fn counts_as_failure(&self) -> bool {
        matches!(
            self,
            PluginHostError::Timeout { .. }
                | PluginHostError::Trap { .. }
                | PluginHostError::BadResponse { .. }
                | PluginHostError::Instantiate { .. }
                | PluginHostError::PoolExhausted { .. }
        )
    }

    /// The short label the `/metrics` failure series carries.
    pub fn label(&self) -> &'static str {
        match self {
            PluginHostError::NotActive(_) => "not_active",
            PluginHostError::NoExport { .. } => "no_export",
            PluginHostError::Disabled { .. } => "disabled",
            PluginHostError::Timeout { .. } => "timeout",
            PluginHostError::Trap { .. } => "trap",
            PluginHostError::BadResponse { .. } => "bad_response",
            PluginHostError::AbiMismatch { .. } => "abi_mismatch",
            PluginHostError::PoolExhausted { .. } => "pool_exhausted",
            PluginHostError::Instantiate { .. } => "instantiate",
            PluginHostError::ShuttingDown => "shutting_down",
            PluginHostError::Internal(_) => "internal",
        }
    }

    /// The status an inbound plugin route answers with (HOST-ABI.md §4.4).
    ///
    /// Not derived from the [`AppError`] mapping, because two of these have no `AppError`
    /// variant: a trap is **502** (the plugin is the upstream and it misbehaved) and a
    /// deadline is **504** (the upstream took too long). Those are the honest codes for a
    /// gateway, and inventing `AppError` variants for them would change a frozen file for
    /// the sake of one route family.
    pub fn http_status(&self) -> axum::http::StatusCode {
        use axum::http::StatusCode;
        match self {
            // Routing decisions: the plugin or its route is simply not there.
            PluginHostError::NotActive(_) | PluginHostError::NoExport { .. } => {
                StatusCode::NOT_FOUND
            }
            PluginHostError::Timeout { .. } => StatusCode::GATEWAY_TIMEOUT,
            PluginHostError::Trap { .. }
            | PluginHostError::BadResponse { .. }
            | PluginHostError::AbiMismatch { .. } => StatusCode::BAD_GATEWAY,
            PluginHostError::Disabled { .. }
            | PluginHostError::PoolExhausted { .. }
            | PluginHostError::Instantiate { .. }
            | PluginHostError::ShuttingDown => StatusCode::SERVICE_UNAVAILABLE,
            PluginHostError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    /// The same failure as the ABI sees it — what `call_plugin` forwards to a caller that
    /// is itself a plugin.
    ///
    /// Deliberately lossy in one direction: a callee's *host-side* failure reaches the
    /// caller as `unavailable`/`timeout`/`internal` and never as a message naming a file
    /// path or a Wasmtime frame. The detail is in the server's log, where it belongs.
    pub fn as_host_error(&self) -> abi::HostError {
        match self {
            PluginHostError::NotActive(id) => abi::HostError::new(
                abi::ErrorCode::NotFound,
                format!("`{id}` has no active backend half"),
            ),
            PluginHostError::NoExport { plugin, export } => abi::HostError::new(
                abi::ErrorCode::NotFound,
                format!("`{plugin}` does not export `{export}`"),
            ),
            PluginHostError::Disabled { plugin, .. } => abi::HostError::new(
                abi::ErrorCode::Unavailable,
                format!("`{plugin}` is disabled"),
            ),
            PluginHostError::Timeout { plugin, budget_ms } => abi::HostError::new(
                abi::ErrorCode::Timeout,
                format!("`{plugin}` exceeded its {budget_ms} ms budget"),
            ),
            PluginHostError::Trap { plugin, .. } | PluginHostError::BadResponse { plugin, .. } => {
                abi::HostError::new(
                    abi::ErrorCode::Internal,
                    format!("`{plugin}` failed; the reason is in the server log"),
                )
            }
            PluginHostError::AbiMismatch { plugin, .. } => abi::HostError::new(
                abi::ErrorCode::Unavailable,
                format!("`{plugin}` speaks another host ABI"),
            ),
            PluginHostError::PoolExhausted { plugin, .. } => abi::HostError::new(
                abi::ErrorCode::Unavailable,
                format!("`{plugin}` has no free instance"),
            ),
            PluginHostError::Instantiate { plugin, .. } => abi::HostError::new(
                abi::ErrorCode::Unavailable,
                format!("`{plugin}` could not be instantiated"),
            ),
            PluginHostError::ShuttingDown => abi::HostError::new(
                abi::ErrorCode::Unavailable,
                "the plugin host is shutting down",
            ),
            PluginHostError::Internal(_) => {
                abi::HostError::new(abi::ErrorCode::Internal, "the call failed inside the host")
            }
        }
    }
}

impl From<PluginHostError> for AppError {
    fn from(error: PluginHostError) -> Self {
        // The two statuses `AppError` cannot express — 502 for a trap, 504 for a deadline —
        // are produced by `routes::plugin_api`, which builds those responses directly from
        // `http_status`. Everything that goes through `AppError` collapses to the nearest
        // variant, and the message never leaks a Wasmtime frame or a module path.
        match error {
            PluginHostError::NotActive(_) | PluginHostError::NoExport { .. } => {
                AppError::NotFound("plugin")
            }
            PluginHostError::Internal(err) => AppError::Internal(err),
            other => {
                if matches!(
                    other,
                    PluginHostError::Trap { .. } | PluginHostError::BadResponse { .. }
                ) {
                    tracing::warn!(error = %other, "plugin host: a plugin failed");
                }
                AppError::Unavailable(other.as_host_error().message)
            }
        }
    }
}

/// Aggregate state for `/readyz`, `/metrics` and the admin screen.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct PluginHostStats {
    pub active: usize,
    pub disabled: usize,
    pub instances: usize,
    pub calls_in_flight: usize,
    pub cron_jobs: usize,
    pub hooks_pending: usize,
}

/// The host: one per server process, holding the Wasmtime engine, the compiled modules,
/// the instance pools and the breaker.
///
/// **Not a field on [`AppState`]** — that type is a frozen contract, and the sync hub and
/// the plugin registry already established the process-wide-handle pattern for exactly
/// this situation. [`PluginHost::get`] is the accessor.
pub struct PluginHost {
    limits: PluginLimits,
    breaker: CircuitBreaker,
    write_ledger: Arc<WriteLedger>,
    /// Published plugins. Removed from here *before* the pool is drained, so a deactivation
    /// stops routing immediately and then waits — never the other way round.
    active: RwLock<BTreeMap<String, ActiveEntry>>,
    calls_in_flight: AtomicUsize,
    shutting_down: AtomicBool,
    /// `DISABLE_PLUGINS=1`. Safe mode is a *state the host is in*, not a branch every
    /// caller has to remember (SPEC §6.1).
    inert: bool,
}

/// One published plugin and the pool behind it.
#[derive(Clone)]
struct ActiveEntry {
    plugin: Arc<ActivePlugin>,
    pool: Arc<PluginPool>,
}

/// The one log line an unload produces, wherever the drain finished.
fn report_unload(plugin_id: &str, stranded: usize) {
    if stranded > 0 {
        tracing::warn!(
            plugin = %plugin_id, calls = stranded,
            "plugin host: unloaded with calls still in flight"
        );
    } else {
        tracing::info!(plugin = %plugin_id, "plugin host: backend half unloaded");
    }
}

/// One host per `AppState`, keyed the way the sync hub and the plugin registry already do
/// it — by database name, so a test that boots a dozen throwaway states gets a dozen hosts
/// and none of them sees another's plugins.
fn hosts() -> &'static Mutex<HashMap<String, Arc<PluginHost>>> {
    static HOSTS: OnceLock<Mutex<HashMap<String, Arc<PluginHost>>>> = OnceLock::new();
    HOSTS.get_or_init(|| Mutex::new(HashMap::new()))
}

impl PluginHost {
    /// The process-wide host, created on first use.
    ///
    /// Returns an inert host when `DISABLE_PLUGINS=1` (SPEC §6.1): every call answers
    /// [`PluginHostError::NotActive`], nothing is compiled, and no cron fires. Safe mode
    /// has to be a state the host can be *in*, not a branch every caller remembers.
    pub fn get(state: &AppState) -> Arc<PluginHost> {
        let key = state.db.name().to_string();
        let mut hosts = hosts().lock().expect("plugin host registry poisoned");
        Arc::clone(
            hosts
                .entry(key)
                .or_insert_with(|| Arc::new(PluginHost::new(state))),
        )
    }

    /// The host for this state **if one already exists** — never creating one.
    ///
    /// [`PluginHost::get`] is the right accessor everywhere a call is about to be made:
    /// creating the host is how the first one comes into being. `/readyz` is the case that
    /// wants the other answer. A readiness probe runs every few seconds forever, it is
    /// unauthenticated, and its job is to *report* state, not to bring any into existence —
    /// a probe that instantiated the host would make "the plugin host is running" true by
    /// asking the question.
    pub fn existing(state: &AppState) -> Option<Arc<PluginHost>> {
        let hosts = hosts().lock().expect("plugin host registry poisoned");
        hosts.get(state.db.name()).map(Arc::clone)
    }

    fn new(state: &AppState) -> PluginHost {
        let limits = PluginLimits::from_config(&state.config);
        PluginHost {
            breaker: CircuitBreaker::new(limits.breaker_threshold),
            write_ledger: Arc::new(WriteLedger::new(limits.writes_per_document_per_minute)),
            limits,
            active: RwLock::new(BTreeMap::new()),
            calls_in_flight: AtomicUsize::new(0),
            shutting_down: AtomicBool::new(false),
            inert: state.config.disable_plugins,
        }
    }

    pub fn limits(&self) -> &PluginLimits {
        &self.limits
    }

    /// Compile, instantiate once, check the ABI export, run `lm_init`, and publish as
    /// active.
    ///
    /// Order matters: the ABI check happens **before** `lm_init`, so a module built
    /// against another major never runs a line of its own code. A failure here leaves the
    /// plugin inactive with the reason on its record — activation is never half-done.
    pub async fn activate(
        &self,
        state: &AppState,
        record: &PluginRecord,
    ) -> Result<Arc<ActivePlugin>, PluginHostError> {
        if self.inert {
            return Err(PluginHostError::NotActive(record.id.clone()));
        }
        if self.shutting_down.load(Ordering::Relaxed) {
            return Err(PluginHostError::ShuttingDown);
        }

        let Some(backend) = record.manifest.backend.as_ref() else {
            // Not an error worth a breaker entry: most plugins have no backend half — a
            // plugin needs one only for cron, outbound HTTP or a webhook (SPEC §6.3), and
            // today none of the base distribution does.
            return Err(PluginHostError::NotActive(record.id.clone()));
        };

        let wasm_path = module_path(state, &record.id, &record.version, &backend.module);
        if !wasm_path.exists() {
            return Err(PluginHostError::Instantiate {
                plugin: record.id.clone(),
                message: format!("{} does not exist", wasm_path.display()),
            });
        }

        // The *granted* public set, not the manifest's request: an admin may decline a
        // public route at approval, and `route_specs` alone would hand the dispatcher a
        // `public: true` the admin explicitly unchecked (`plugins::route_specs_granted`).
        let routes =
            crate::plugins::route_specs_granted(&record.manifest, &record.capabilities_approved)
                .map_err(|message| PluginHostError::Instantiate {
                    plugin: record.id.clone(),
                    message: format!("`backend.routes` is not valid: {message}"),
                })?;
        let hooks: Vec<abi::hooks::HookKind> = backend
            .hooks
            .iter()
            .filter_map(|name| abi::hooks::HookKind::parse(name))
            .collect();

        // Compiling is the expensive step, and it is synchronous: Wasmtime parses and
        // codegens the whole module.
        let limits = self.limits;
        let path = wasm_path.clone();
        let id_for_compile = record.id.clone();
        let pool = tokio::task::spawn_blocking(move || {
            PluginPool::compile_for(&id_for_compile, &path, &limits, host_fns::functions)
        })
        .await
        .map_err(|err| PluginHostError::Internal(anyhow::Error::new(err)))??;

        // The stale-`.wasm` guard, before any of the plugin's own logic runs.
        let pool_for_probe = Arc::clone(&pool);
        let abi_version = tokio::task::spawn_blocking(move || pool_for_probe.probe_abi_version())
            .await
            .map_err(|err| PluginHostError::Internal(anyhow::Error::new(err)))??;
        if abi_version != abi::ABI_VERSION {
            return Err(PluginHostError::AbiMismatch {
                plugin: record.id.clone(),
                expected: abi::ABI_VERSION,
                found: abi_version,
            });
        }

        let pool_for_exports = Arc::clone(&pool);
        let exports = tokio::task::spawn_blocking(move || pool_for_exports.exports())
            .await
            .map_err(|err| PluginHostError::Internal(anyhow::Error::new(err)))??;

        // The approved set, not the requested one (SPEC §6.2): the admin's decision is what
        // gates. Before approval `capabilities_approved` is empty, which is the correct
        // answer for a plugin that is not enabled yet.
        let capabilities = record.capabilities_approved.to_abi();
        let config_keys = record.manifest.config.keys().cloned().collect::<Vec<_>>();

        let plugin = Arc::new(ActivePlugin {
            id: record.id.clone(),
            version: record.version.clone(),
            capabilities,
            dependencies: record.manifest.dependencies.clone(),
            hooks,
            cron: backend.cron.clone(),
            routes,
            events: backend.events.clone(),
            config_keys: config_keys.clone(),
            config: record.manifest.config.clone(),
            wasm_path,
            module_sha256: record.module_sha256.clone().unwrap_or_default(),
            abi_version,
            exports,
        });

        // `lm_init` runs per *instance*, so the payload is stored on the pool rather than
        // called once here: the instance this activation warmed is not the only one that
        // will ever serve a call (HOST-ABI.md §4.1).
        if plugin.has_export(abi::names::INIT) {
            let payload = serde_json::to_vec(&abi::InitPayload {
                plugin_id: plugin.id.clone(),
                version: plugin.version.clone(),
                abi_version: abi::ABI_VERSION,
                capabilities: plugin.capabilities.clone(),
                config_keys,
            })
            .map_err(|err| PluginHostError::Internal(anyhow::Error::new(err)))?;
            pool.set_init_payload(Some(payload));
        }

        // Publish last. Nothing can route to a half-activated plugin, because until this
        // line it is not in the map.
        {
            let mut active = self.active.write().expect("plugin host map poisoned");
            active.insert(
                plugin.id.clone(),
                ActiveEntry {
                    plugin: Arc::clone(&plugin),
                    pool: Arc::clone(&pool),
                },
            );
        }
        // A fresh activation starts with a clean breaker: an operator who reinstalled a
        // plugin to fix it should not inherit the old build's failure count.
        self.breaker.reset(&plugin.id);

        tracing::info!(
            plugin = %plugin.id, version = %plugin.version, abi = abi_version,
            hooks = plugin.hooks.len(), cron = plugin.cron.len(), routes = plugin.routes.len(),
            sha256 = %plugin.module_sha256,
            "plugin host: backend half activated"
        );
        Ok(plugin)
    }

    /// Stop routing to a plugin and drop its instances **after in-flight calls finish**
    /// (SPEC §6.3: "hot unload waits on in-flight calls (refcount)").
    ///
    /// Cancelling a call mid-write would leave a half-written document set with nobody to
    /// finish it, so the wait is the point: unpublish first (so nothing new arrives), then
    /// let what is running finish.
    pub async fn deactivate(&self, plugin_id: &str) -> Result<(), PluginHostError> {
        let Some(entry) = self.unpublish(plugin_id) else {
            return Ok(());
        };
        let stranded = entry.pool.drain(self.limits.cron_timeout).await;
        self.write_ledger.forget(plugin_id);
        report_unload(plugin_id, stranded);
        Ok(())
    }

    /// Stop routing to a plugin **now** and let its instances drain on a task of their own.
    ///
    /// The half of [`PluginHost::deactivate`] that has to be immediate is the unpublish; the
    /// drain is cleanup that waits up to the cron grace (60 s). Awaiting it is right when an
    /// admin or the shutdown path asked for an unload and is willing to wait, and wrong when
    /// the unload is a *side effect* of a failing call: a breaker that opens inside a nested
    /// `call_plugin` runs on the caller's `spawn_blocking` thread, so awaiting the callee's
    /// drain pinned that thread — and the caller's own pooled instance — for up to a minute
    /// past the caller's 5 s budget. Nothing preempts it either: epoch interruption only traps
    /// at Wasm instruction boundaries, and this is host code. One such chain could outlast the
    /// 30 s shutdown grace of SPEC §8.
    pub fn deactivate_detached(&self, plugin_id: &str) {
        let Some(entry) = self.unpublish(plugin_id) else {
            return;
        };
        self.write_ledger.forget(plugin_id);
        let grace = self.limits.cron_timeout;
        let plugin_id = plugin_id.to_string();
        tokio::spawn(async move {
            let stranded = entry.pool.drain(grace).await;
            report_unload(&plugin_id, stranded);
        });
    }

    /// Take a plugin out of the active map, so no further call can reach it.
    fn unpublish(&self, plugin_id: &str) -> Option<ActiveEntry> {
        self.active
            .write()
            .expect("plugin host map poisoned")
            .remove(plugin_id)
    }

    /// Activate every approved plugin with a backend half; used at boot and after an
    /// install. Never fatal: a plugin that fails to activate is recorded and skipped, the
    /// same rule the frontend loader follows (SPEC §6.4).
    pub async fn reload(&self, state: &AppState) -> Vec<(String, PluginHostError)> {
        if self.inert {
            tracing::warn!(
                "DISABLE_PLUGINS=1: no backend plugin is loaded, no cron fires (SPEC §6.1)"
            );
            return Vec::new();
        }

        let records = match crate::plugininstall::records(state).await {
            Ok(records) => records,
            Err(err) => {
                // Not fatal, and deliberately so: a server that will not boot because Mongo
                // hiccuped while reading plugin records is worse than one with no plugins.
                tracing::error!(error = %err, "plugin host: could not read the plugin records");
                return Vec::new();
            }
        };

        let mut failures = Vec::new();
        for record in &records {
            if !record.state.is_active() || !record.manifest.has_backend() {
                continue;
            }
            // A plugin an operator (or the breaker) switched off stays off across a restart:
            // `disabled_reason` is persisted precisely so a reboot is not an accidental
            // re-enable.
            if let Some(reason) = record.disabled_reason.as_deref() {
                self.breaker.open(&record.id, reason);
                tracing::warn!(
                    plugin = %record.id, %reason,
                    "plugin host: not activating a plugin its record says is disabled"
                );
                continue;
            }
            if let Err(err) = self.activate(state, record).await {
                failures.push((record.id.clone(), err));
            }
        }
        failures
    }

    pub fn active(&self) -> Vec<Arc<ActivePlugin>> {
        self.active
            .read()
            .expect("plugin host map poisoned")
            .values()
            .map(|entry| Arc::clone(&entry.plugin))
            .collect()
    }

    pub fn get_active(&self, plugin_id: &str) -> Option<Arc<ActivePlugin>> {
        self.active
            .read()
            .expect("plugin host map poisoned")
            .get(plugin_id)
            .map(|entry| Arc::clone(&entry.plugin))
    }

    /// The breaker state of one plugin, for the admin screen.
    pub fn breaker_state(&self, plugin_id: &str) -> BreakerState {
        self.breaker.state(plugin_id)
    }

    /// Every plugin the breaker knows about — the admin screen's list.
    pub fn breaker_snapshot(&self) -> Vec<(String, BreakerState)> {
        self.breaker.snapshot()
    }

    /// The one entry point for invoking a plugin.
    ///
    /// Everything else — cron, hooks, routes, `call_plugin` — builds an [`Invocation`] and
    /// comes through here, so the breaker, the pool, the deadline, the metrics and the
    /// logging exist once.
    pub async fn call(
        &self,
        state: &AppState,
        invocation: Invocation,
    ) -> Result<CallOutcome, PluginHostError> {
        let (envelope, outcome) = self.invoke(state, invocation).await?;
        let refusal = envelope.error;
        Ok(CallOutcome {
            value: if refusal.is_none() {
                envelope.value
            } else {
                None
            },
            refusal,
            ..outcome
        })
    }

    /// [`PluginHost::call`] plus envelope interpretation: the plugin's own refusal becomes
    /// `Err`. What `call_plugin` and the route dispatcher want.
    pub async fn call_typed<T: serde::de::DeserializeOwned>(
        &self,
        state: &AppState,
        invocation: Invocation,
    ) -> Result<Option<T>, CallFailure> {
        let plugin_id = invocation.plugin_id.clone();
        let (envelope, _) = self.invoke(state, invocation).await?;
        let value = envelope.into_result().map_err(CallFailure::Refused)?;
        match value {
            None | Some(Value::Null) => Ok(None),
            Some(value) => serde_json::from_value(value).map(Some).map_err(|err| {
                CallFailure::Host(PluginHostError::BadResponse {
                    plugin: plugin_id,
                    message: format!("the returned value is not the expected shape: {err}"),
                })
            }),
        }
    }

    /// Breaker → pool → blocking thread → envelope. The one place any of that happens.
    async fn invoke(
        &self,
        state: &AppState,
        invocation: Invocation,
    ) -> Result<(abi::Envelope<Value>, CallOutcome), PluginHostError> {
        if self.inert || self.shutting_down.load(Ordering::Relaxed) {
            return Err(if self.inert {
                PluginHostError::NotActive(invocation.plugin_id.clone())
            } else {
                PluginHostError::ShuttingDown
            });
        }

        // The breaker is checked **first** — before the active map, and therefore long before
        // an instance is touched. Two reasons, and the ordering is load-bearing for both:
        //
        // - A disabled plugin must not be instantiated at all, or "disabled" would still cost
        //   a compile and 128 MB.
        // - Opening the breaker also *unloads* the plugin, so after that it is not in the
        //   active map. Looking there first would report `NotActive` — a 404 — for a plugin
        //   that is disabled rather than absent, and "it is switched off" (503) and "there is
        //   no such plugin" (404) are different answers a client acts on differently.
        //   Uninstall is the case that really is absent, and it calls `forget`.
        if let BreakerState::Open { reason, .. } = self.breaker.state(&invocation.plugin_id) {
            return Err(PluginHostError::Disabled {
                plugin: invocation.plugin_id.clone(),
                reason,
            });
        }

        let entry = self
            .active
            .read()
            .expect("plugin host map poisoned")
            .get(&invocation.plugin_id)
            .cloned()
            .ok_or_else(|| PluginHostError::NotActive(invocation.plugin_id.clone()))?;

        let export = invocation.kind.export_name();
        if !entry.plugin.has_export(export) {
            // Not a breaker failure: this is the *host's* routing decision, and counting it
            // would let a misconfigured hook disable a healthy plugin.
            return Err(PluginHostError::NoExport {
                plugin: invocation.plugin_id.clone(),
                export: export.to_string(),
            });
        }

        let payload = serde_json::to_vec(&invocation.call_payload())
            .map_err(|err| PluginHostError::Internal(anyhow::Error::new(err)))?;

        let context = Arc::new(HostContext {
            state: state.clone(),
            plugin: Arc::clone(&entry.plugin),
            kind: invocation.kind.clone(),
            limits: self.limits,
            deadline: invocation.deadline,
            depth: invocation.depth,
            stack: invocation.stack.clone(),
            user_id: invocation.user_id.clone(),
            counters: CallCounters::default(),
            write_ledger: Arc::clone(&self.write_ledger),
            // Captured here rather than inside the host functions: by the time one runs it is
            // on a blocking thread, where `Handle::current()` would panic.
            runtime: tokio::runtime::Handle::current(),
        });

        let started = Instant::now();
        self.calls_in_flight.fetch_add(1, Ordering::Relaxed);
        let result = self
            .run_blocking(&entry, export, payload, Arc::clone(&context))
            .await;
        self.calls_in_flight.fetch_sub(1, Ordering::Relaxed);
        let duration = started.elapsed();

        let kind_label = invocation.kind.label();
        metrics::histogram!(
            crate::telemetry::names::PLUGIN_CALL_LATENCY,
            "plugin" => invocation.plugin_id.clone(),
            "kind" => kind_label
        )
        .record(duration.as_secs_f64());
        metrics::counter!(
            crate::telemetry::names::PLUGIN_CALLS,
            "plugin" => invocation.plugin_id.clone(),
            "kind" => kind_label
        )
        .increment(1);

        let bytes = match result {
            Ok(bytes) => bytes,
            Err(error) => {
                self.record_failure(state, &invocation.plugin_id, &error)
                    .await;
                return Err(error);
            }
        };

        let envelope: abi::Envelope<Value> = match serde_json::from_slice(&bytes) {
            Ok(envelope) => envelope,
            Err(err) => {
                let error = PluginHostError::BadResponse {
                    plugin: invocation.plugin_id.clone(),
                    message: format!("the export did not answer with an envelope: {err}"),
                };
                self.record_failure(state, &invocation.plugin_id, &error)
                    .await;
                return Err(error);
            }
        };

        // A refusal is a **success** for the breaker: the plugin was reached and it answered.
        // `ErrorCode::is_plugin_fault` is the split, and a plugin is never disabled for
        // correctly reporting that a document does not exist (HOST-ABI.md §5).
        self.breaker.record_success(&invocation.plugin_id);
        if let Some(error) = envelope.error.as_ref() {
            tracing::warn!(
                plugin = %invocation.plugin_id, kind = kind_label,
                code = error.code.as_str(), message = %error.message,
                duration_ms = duration.as_millis(),
                "plugin host: the plugin refused the invocation"
            );
        } else {
            tracing::debug!(
                plugin = %invocation.plugin_id, kind = kind_label,
                duration_ms = duration.as_millis(), writes = context.counters.writes(),
                "plugin host: call finished"
            );
        }

        let outcome = CallOutcome {
            value: None,
            duration,
            writes: context.counters.writes(),
            logs: context.counters.logs(),
            refusal: None,
        };
        Ok((envelope, outcome))
    }

    /// Take an instance and run the export on a blocking thread.
    ///
    /// Two things have to happen on that thread and nowhere else: the Extism call itself
    /// (synchronous), and every host function it makes (which `block_on` their async work).
    /// The guard travels with the closure and comes back, so it is returned to the pool by
    /// its own `Drop` whatever happened.
    async fn run_blocking(
        &self,
        entry: &ActiveEntry,
        export: &'static str,
        payload: Vec<u8>,
        context: Arc<HostContext>,
    ) -> Result<Vec<u8>, PluginHostError> {
        let mut guard = entry.pool.acquire(Arc::clone(&context)).await?;
        let (_guard, result) = tokio::task::spawn_blocking(move || {
            let result = guard.call_export(export, &payload, context);
            (guard, result)
        })
        .await
        .map_err(|err| PluginHostError::Internal(anyhow::Error::new(err)))?;
        result
    }

    /// Count a host-side failure, and disable the plugin if it was the fifth in a row.
    async fn record_failure(&self, state: &AppState, plugin_id: &str, error: &PluginHostError) {
        metrics::counter!(
            crate::telemetry::names::PLUGIN_CALL_FAILURES,
            "plugin" => plugin_id.to_string(),
            "reason" => error.label()
        )
        .increment(1);

        if !error.counts_as_failure() {
            tracing::warn!(
                plugin = %plugin_id, reason = error.label(), error = %error,
                "plugin host: call failed (not counted on the breaker)"
            );
            return;
        }

        match self.breaker.record_failure(plugin_id, error.label()) {
            BreakerTransition::Counted { failures } => {
                tracing::warn!(
                    plugin = %plugin_id, reason = error.label(), error = %error,
                    failures, threshold = self.limits.breaker_threshold,
                    "plugin host: call failed"
                );
            }
            BreakerTransition::AlreadyOpen => {}
            BreakerTransition::Opened { failures, reason } => {
                tracing::error!(
                    plugin = %plugin_id, failures, %reason,
                    "plugin host: circuit breaker opened; the plugin is disabled until an admin \
                     re-enables it"
                );
                // Persisted and audited, then unloaded. The order matters: a plugin whose
                // record still says `enabled` would come back on the next restart, which is
                // exactly the silent re-enable SPEC §6.3 refuses.
                if let Err(err) = crate::plugininstall::disable(
                    state,
                    plugin_id,
                    &reason,
                    &crate::domain::Actor::System,
                )
                .await
                {
                    tracing::error!(
                        plugin = %plugin_id, error = %err,
                        "plugin host: the breaker opened but the plugin record could not be \
                         updated; it will be active again after a restart"
                    );
                }
                // **Detached.** The unpublish is immediate — nothing new reaches the plugin
                // from here on — but the drain waits up to the cron grace, and this runs on
                // the *failing caller's* stack: for a nested `call_plugin` that is a
                // `spawn_blocking` thread holding the caller's own pooled instance, and
                // awaiting a callee's drain there turned a 5 s hook into a ~65 s one.
                self.deactivate_detached(plugin_id);
            }
        }
    }

    /// Clear a breaker after an admin re-enables a plugin.
    pub fn reset_breaker(&self, plugin_id: &str) {
        self.breaker.reset(plugin_id);
    }

    /// Forget everything about a plugin — on uninstall, so a reinstall starts clean.
    pub fn forget(&self, plugin_id: &str) {
        self.breaker.forget(plugin_id);
        self.write_ledger.forget(plugin_id);
    }

    /// One plugin's pool numbers — instances, in-flight calls, and how many modules were
    /// compiled for it (one per instance slot, which is what gives each instance its own
    /// engine). `None` when the plugin is not active.
    pub fn pool_stats(&self, plugin_id: &str) -> Option<crate::pluginhost::pool::PoolStats> {
        self.active
            .read()
            .expect("plugin host map poisoned")
            .get(plugin_id)
            .map(|entry| entry.pool.stats())
    }

    pub fn stats(&self) -> PluginHostStats {
        let active = self.active.read().expect("plugin host map poisoned");
        let instances = active
            .values()
            .map(|entry| entry.pool.stats().instances)
            .sum();
        let cron_jobs = active
            .values()
            .filter(|entry| entry.plugin.has_export(abi::names::CRON))
            .map(|entry| entry.plugin.cron.len())
            .sum();
        PluginHostStats {
            active: active.len(),
            disabled: self.breaker.open_count(),
            instances,
            calls_in_flight: self.calls_in_flight.load(Ordering::Relaxed),
            cron_jobs,
            // The hook debouncer owns its own queue; it reports through
            // `telemetry::names::PLUGIN_HOOKS_PENDING`.
            hooks_pending: 0,
        }
    }

    /// Drop instances that have been idle too long, and age out the write ledger. Called
    /// from the maintenance loop; 128 MB of idle plugin is worth reclaiming.
    pub fn maintain(&self) -> usize {
        let now = Instant::now();
        let evicted: usize = self
            .active
            .read()
            .expect("plugin host map poisoned")
            .values()
            .map(|entry| entry.pool.evict_idle(now))
            .sum();
        self.write_ledger.sweep();
        evicted
    }

    /// Refuse new calls, wait for in-flight ones, drop every instance. Called from
    /// `main.rs` on SIGTERM before the document flush.
    pub async fn shutdown(&self, grace: Duration) {
        if self.inert {
            return;
        }
        self.shutting_down.store(true, Ordering::Relaxed);
        let entries: Vec<ActiveEntry> = self
            .active
            .write()
            .expect("plugin host map poisoned")
            .values()
            .cloned()
            .collect();

        // Drained in parallel: the grace is a wall clock for the whole shutdown, not a
        // budget each plugin gets in turn (SPEC §8's 30 s ceiling covers the flush too).
        let stranded: usize =
            futures::future::join_all(entries.iter().map(|entry| entry.pool.drain(grace)))
                .await
                .into_iter()
                .sum();

        self.active
            .write()
            .expect("plugin host map poisoned")
            .clear();
        if stranded > 0 {
            tracing::warn!(
                calls = stranded,
                "plugin host: shut down with calls still in flight"
            );
        }
    }
}

/// `<PLUGINS_DIR>/<id>/<version>/<module>` — where the installer puts a backend half.
///
/// The same layout [`crate::plugininstall::installed_dir`] writes and the M3 registry scans.
/// Computed here rather than called through the installer so that activation has no reason
/// to reach into the install flow; the layout itself is the contract (`backend/CONTRACTS.md`,
/// "The installed layout").
//
// INTEGRATION (install-flow): if the installed layout ever changes, this and
// `plugininstall::installed_dir` change together — they are the only two places that spell it.
fn module_path(state: &AppState, id: &str, version: &str, module: &str) -> PathBuf {
    state.config.plugins_dir.join(id).join(version).join(module)
}

/// The two ways a `call_typed` can fail, kept apart because callers treat them
/// differently: a plugin refusal is *data* (forward the code), a host failure is an
/// incident (503, breaker, log).
#[derive(Debug, thiserror::Error)]
pub enum CallFailure {
    #[error("the plugin refused: {0}")]
    Refused(abi::HostError),
    #[error(transparent)]
    Host(#[from] PluginHostError),
}

/// Background workers the host owns: the cron scheduler, the hook debouncer, instance
/// eviction, and the write-ledger sweep.
///
/// Held by `main.rs` for the process lifetime — dropping the handle stops cron.
pub struct PluginHostWorkers {
    handles: Vec<tokio::task::JoinHandle<()>>,
}

impl PluginHostWorkers {
    /// Stop every worker and wait briefly for them to notice.
    ///
    /// Aborted rather than signalled: all three are timer loops with nothing to flush, and
    /// the thing that must not be interrupted — a call in flight — is waited on by
    /// [`PluginHost::shutdown`] instead, through the pool's refcount.
    pub async fn shutdown(self) {
        for handle in &self.handles {
            handle.abort();
        }
        for handle in self.handles {
            let _ = handle.await;
        }
    }
}

/// How often idle instances are reclaimed and the write ledger is aged out.
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(30);

/// Start the host's background workers. Called once from `main.rs` after
/// [`PluginHost::reload`].
///
/// Three tasks, in the order they matter: cron (the reason backend plugins exist), the hook
/// debouncer, and maintenance. Cron is started **after** `reload` by the caller, because a
/// job firing against a half-activated set is the one bug nobody reproduces.
pub fn spawn_workers(state: &AppState) -> PluginHostWorkers {
    let maintenance_state = state.clone();
    let maintenance = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(MAINTENANCE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            let host = PluginHost::get(&maintenance_state);
            let evicted = host.maintain();
            let stats = host.stats();
            metrics::gauge!(crate::telemetry::names::PLUGIN_ACTIVE).set(stats.active as f64);
            metrics::gauge!(crate::telemetry::names::PLUGIN_DISABLED).set(stats.disabled as f64);
            metrics::gauge!(crate::telemetry::names::PLUGIN_INSTANCES).set(stats.instances as f64);
            if evicted > 0 {
                tracing::debug!(instances = evicted, "plugin host: reclaimed idle instances");
            }
        }
    });

    PluginHostWorkers {
        handles: vec![
            cron::CronScheduler::spawn(state.clone()),
            hooks::HookDispatcher::spawn(state.clone()),
            maintenance,
        ],
    }
}

/// Fixtures the unit tests in this module tree share.
///
/// A [`crate::config::Config`] is thirty-odd fields and three of the modules here need one,
/// so it is built once. Nothing in it touches a database — `PluginLimits::from_config` and
/// the IP policy are the only things these tests exercise.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::config::{Config, LogFormat, SessionSecret};

    pub(crate) fn config() -> Config {
        Config {
            mongo_uri: "mongodb://127.0.0.1:27017".to_string(),
            bind_addr: "127.0.0.1:0".parse().expect("a literal address"),
            session_secret: SessionSecret::new(vec![7u8; 48]).expect("48 bytes is enough"),
            mongo_database: "lm_pluginhost_unit".to_string(),
            max_attachment_bytes: 1024 * 1024,
            max_document_bytes: life_manager_core::limits::MAX_DOCUMENT_BYTES,
            app_origins: vec!["http://localhost:5173".to_string()],
            public_url: None,
            log_format: LogFormat::Pretty,
            cookie_secure: false,
            trust_proxy_headers: false,
            trash_retention_days: 30,
            checkpoint_every_changes: 1000,
            invite_ttl_days: 7,
            session_idle_days: 30,
            session_absolute_days: 180,
            materialize_debounce: Duration::from_millis(50),
            room_idle_timeout: Duration::from_secs(30),
            update_log_keep_bytes: 4096,
            update_log_keep_count: 5,
            crdt_compact_threshold_bytes: 128 * 1024,
            crdt_alert_threshold_bytes: 256 * 1024,
            login_max_attempts: 50,
            login_attempt_window: Duration::from_secs(60),
            shutdown_grace: Duration::from_secs(5),
            web_dist_dir: None,
            plugins_dir: PathBuf::from("target/test-plugins-empty"),
            kernel_dts_path: None,
            disable_plugins: false,
            plugin_staging_dir: PathBuf::from("target/test-plugins-staging"),
            plugin_inbox_dir: None,
            plugin_config_key: None,
            plugin_call_timeout: Duration::from_millis(abi::limits::CALL_TIMEOUT_MS),
            plugin_cron_timeout: Duration::from_millis(abi::limits::CRON_CALL_TIMEOUT_MS),
            plugin_memory_bytes: abi::limits::MEMORY_BYTES,
            plugin_max_instances: abi::limits::MAX_INSTANCES_PER_PLUGIN,
            plugin_breaker_threshold: abi::limits::BREAKER_FAILURE_THRESHOLD,
            plugin_http_timeout: Duration::from_millis(abi::limits::HTTP_TIMEOUT_MS),
            plugin_http_max_response_bytes: abi::limits::MAX_HTTP_RESPONSE_BYTES,
            plugin_http_allow_cidrs: Vec::new(),
            plugin_enable_cron: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn top_level(plugin: &str) -> Invocation {
        Invocation::top_level(
            plugin,
            CallKind::Cron { index: 0 },
            Value::Null,
            &PluginLimits::default(),
        )
    }

    #[test]
    fn a_top_level_invocation_starts_the_stack_with_itself() {
        let invocation = top_level("calendar");
        assert_eq!(invocation.depth, 0);
        assert_eq!(invocation.stack, vec!["calendar".to_string()]);
        assert_eq!(invocation.kind.export_name(), abi::names::CRON);
        // Cron gets the long budget; everything else gets the short one (SPEC §6.3).
        assert_eq!(
            invocation.kind.timeout(&PluginLimits::default()),
            Duration::from_millis(abi::limits::CRON_CALL_TIMEOUT_MS)
        );
        assert_eq!(
            CallKind::Route.timeout(&PluginLimits::default()),
            Duration::from_millis(abi::limits::CALL_TIMEOUT_MS)
        );
    }

    /// The whole chain shares one deadline: three nested calls do not get three timeouts,
    /// and the callee is told what is left rather than being interrupted mid-write.
    #[test]
    fn a_chain_shares_one_deadline_and_counts_its_depth() {
        let first = top_level("calendar");
        let second = first
            .nested("folders", "normalize", Value::Null)
            .expect("depth 1");
        assert_eq!(second.depth, 1);
        assert_eq!(second.deadline.at(), first.deadline.at());
        assert_eq!(second.plugin_id, "folders");
        assert_eq!(second.stack, vec!["calendar", "folders"]);
        assert_eq!(
            second.kind,
            CallKind::Invoked {
                caller: "calendar".to_string(),
                function: "normalize".to_string(),
            }
        );

        let third = second
            .nested("search", "index", Value::Null)
            .expect("depth 2");
        let fourth = third
            .nested("themes", "tokens", Value::Null)
            .expect("depth 3");
        assert_eq!(fourth.depth, abi::limits::MAX_CALL_DEPTH);
        assert_eq!(fourth.deadline.at(), first.deadline.at());

        let too_deep = fourth
            .nested("markdown", "render", Value::Null)
            .expect_err("depth 4 is over the cap");
        assert_eq!(too_deep.code, abi::ErrorCode::LimitExceeded);
    }

    /// `a → b → a` is a design mistake, not a budget problem — so it is `reentrancy` at any
    /// depth, and the check runs before the depth one so the author is sent to the right fix.
    #[test]
    fn reentrancy_is_refused_before_depth_and_at_any_depth() {
        let first = top_level("calendar");
        let direct = first
            .nested("calendar", "sync", Value::Null)
            .expect_err("a plugin cannot call itself");
        assert_eq!(direct.code, abi::ErrorCode::Reentrancy);

        let second = first
            .nested("folders", "normalize", Value::Null)
            .expect("ok");
        let cycle = second
            .nested("calendar", "sync", Value::Null)
            .expect_err("a → b → a is still a cycle");
        assert_eq!(cycle.code, abi::ErrorCode::Reentrancy);
        assert_eq!(
            cycle
                .detail
                .as_ref()
                .and_then(|d| d["stack"].as_array())
                .map(Vec::len),
            Some(2),
            "the refusal shows the stack that caused it"
        );
    }

    /// The callee is told how much of the shared budget is left, so it can refuse honestly
    /// instead of being interrupted (HOST-ABI.md §4.5).
    #[test]
    fn a_callee_sees_the_remaining_budget_not_a_fresh_one() {
        let first = top_level("calendar");
        let nested = first
            .nested(
                "folders",
                "normalize",
                serde_json::json!({ "path": "a//b" }),
            )
            .expect("ok");
        let payload: abi::call::CallPayload =
            serde_json::from_value(nested.call_payload()).expect("a CallPayload");
        assert_eq!(payload.function, "normalize");
        assert_eq!(payload.caller, "calendar");
        assert_eq!(payload.depth, 1);
        assert_eq!(payload.payload, serde_json::json!({ "path": "a//b" }));
        assert!(
            payload.deadline_ms <= abi::limits::CRON_CALL_TIMEOUT_MS,
            "never more than the outermost budget"
        );
    }

    /// The host's own routing decisions must not count on the breaker: a hook aimed at a
    /// plugin that does not export it is a misconfiguration, and counting it would let one
    /// disable a perfectly healthy plugin.
    #[test]
    fn only_host_side_failures_count_on_the_breaker() {
        assert!(!PluginHostError::NotActive("calendar".into()).counts_as_failure());
        assert!(
            !PluginHostError::NoExport {
                plugin: "calendar".into(),
                export: "lm_cron".into()
            }
            .counts_as_failure()
        );
        assert!(
            !PluginHostError::Disabled {
                plugin: "calendar".into(),
                reason: "admin".into()
            }
            .counts_as_failure()
        );
        assert!(!PluginHostError::ShuttingDown.counts_as_failure());

        assert!(
            PluginHostError::Timeout {
                plugin: "calendar".into(),
                budget_ms: 5000
            }
            .counts_as_failure()
        );
        assert!(
            PluginHostError::Trap {
                plugin: "calendar".into(),
                message: "unreachable".into()
            }
            .counts_as_failure()
        );
        assert!(
            PluginHostError::BadResponse {
                plugin: "calendar".into(),
                message: "not JSON".into()
            }
            .counts_as_failure()
        );
        assert!(
            PluginHostError::PoolExhausted {
                plugin: "calendar".into(),
                waited_ms: 1000
            }
            .counts_as_failure()
        );
        assert!(
            PluginHostError::Instantiate {
                plugin: "calendar".into(),
                message: "no module".into()
            }
            .counts_as_failure()
        );
    }

    /// The gateway statuses of HOST-ABI.md §4.4. Two of them — 502 and 504 — have no
    /// `AppError` variant, which is why the route builds its response from this directly.
    #[test]
    fn a_route_reports_the_gateway_status_for_each_failure() {
        use axum::http::StatusCode;
        let cases: &[(PluginHostError, StatusCode)] = &[
            (
                PluginHostError::NotActive("calendar".into()),
                StatusCode::NOT_FOUND,
            ),
            (
                PluginHostError::NoExport {
                    plugin: "calendar".into(),
                    export: "lm_http".into(),
                },
                StatusCode::NOT_FOUND,
            ),
            (
                PluginHostError::Disabled {
                    plugin: "calendar".into(),
                    reason: "breaker".into(),
                },
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                PluginHostError::PoolExhausted {
                    plugin: "calendar".into(),
                    waited_ms: 1000,
                },
                StatusCode::SERVICE_UNAVAILABLE,
            ),
            (
                PluginHostError::Timeout {
                    plugin: "calendar".into(),
                    budget_ms: 5000,
                },
                StatusCode::GATEWAY_TIMEOUT,
            ),
            (
                PluginHostError::Trap {
                    plugin: "calendar".into(),
                    message: "unreachable".into(),
                },
                StatusCode::BAD_GATEWAY,
            ),
            (
                PluginHostError::BadResponse {
                    plugin: "calendar".into(),
                    message: "not JSON".into(),
                },
                StatusCode::BAD_GATEWAY,
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(error.http_status(), *expected, "{error}");
        }
    }

    /// A host-side failure reaching a *plugin* caller must not carry a Wasmtime frame or a
    /// module path — a plugin is not an operator.
    #[test]
    fn a_host_failure_forwarded_to_a_plugin_leaks_nothing() {
        let error = PluginHostError::Trap {
            plugin: "folders".into(),
            message: "/srv/plugins/folders/1.0.0/backend.wasm: unreachable at 0x4f2".into(),
        };
        let forwarded = error.as_host_error();
        assert_eq!(forwarded.code, abi::ErrorCode::Internal);
        assert!(!forwarded.message.contains("backend.wasm"));
        assert!(!forwarded.message.contains("0x4f2"));
        assert!(forwarded.message.contains("folders"));
    }
}

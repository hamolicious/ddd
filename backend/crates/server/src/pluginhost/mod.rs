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

use ddd_plugin_abi as abi;
use serde_json::Value;

use crate::error::AppError;
use crate::plugins::{ConfigField, PluginRecord, RouteSpec};
use crate::state::AppState;
use breaker::{BreakerState, BreakerTransition, CircuitBreaker};
use host_fns::HostContext;
use limits::{CallCounters, Deadline, PluginLimits, WriteLedger};
use pool::PluginPool;

pub const HOST_NAMESPACE: &str = "extism:host/user";

#[derive(Debug, Clone)]
pub struct ActivePlugin {
    pub id: String,
    pub version: String,
    pub capabilities: abi::Capabilities,
    pub deps: BTreeMap<String, String>,
    pub provides: Option<(String, String)>,
    pub callable: BTreeMap<String, CallableExport>,
    pub hooks: Vec<abi::hooks::HookKind>,
    pub cron: Vec<String>,
    pub routes: Vec<RouteSpec>,
    pub events: Vec<String>,
    pub config_keys: Vec<String>,
    pub config: BTreeMap<String, ConfigField>,
    pub wasm_path: PathBuf,
    pub module_sha256: String,
    pub abi_version: u32,
    pub exports: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CallableExport {
    pub input: Option<ddd_core::shape::Shape>,
    pub output: Option<ddd_core::shape::Shape>,
}

impl CallableExport {
    pub fn from_manifest(export: &crate::plugins::BackendExport) -> Self {
        let parse = |json: &Option<Value>| {
            json.as_ref().map(|json| {
                serde_json::from_value(json.clone())
                    .unwrap_or_else(|_| ddd_core::shape::Shape::Unknown(json.clone()))
            })
        };
        CallableExport {
            input: parse(&export.input),
            output: parse(&export.output),
        }
    }
}

impl ActivePlugin {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallKind {
    Init,
    Hook(abi::hooks::HookKind),
    Cron { index: u32 },
    Route,
    Invoked { caller: String, function: String },
    Event { emitter: String },
}

impl CallKind {
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

    pub fn timeout(&self, limits: &PluginLimits) -> Duration {
        match self {
            CallKind::Cron { .. } => limits.cron_timeout,
            _ => limits.call_timeout,
        }
    }

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

#[derive(Debug, Clone)]
pub struct Invocation {
    pub plugin_id: String,
    pub kind: CallKind,
    pub payload: Value,
    pub deadline: Deadline,
    pub depth: u32,
    pub stack: Vec<String>,
    pub user_id: Option<String>,
}

impl Invocation {
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

    pub fn nested(
        &self,
        target: &str,
        function: &str,
        payload: Value,
    ) -> Result<Self, abi::HostError> {
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
            deadline: self.deadline.inherited(),
            depth,
            stack,
            user_id: self.user_id.clone(),
        })
    }

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

#[derive(Debug, Clone)]
pub struct CallOutcome {
    pub value: Option<Value>,
    pub duration: Duration,
    pub writes: u32,
    pub logs: u32,
    pub refusal: Option<abi::HostError>,
}

impl CallOutcome {
    pub fn refused(&self) -> bool {
        self.refusal.is_some()
    }
}

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

    pub fn http_status(&self) -> axum::http::StatusCode {
        use axum::http::StatusCode;
        match self {
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

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct PluginHostStats {
    pub active: usize,
    pub disabled: usize,
    pub instances: usize,
    pub calls_in_flight: usize,
    pub cron_jobs: usize,
    pub hooks_pending: usize,
}

pub struct PluginHost {
    limits: PluginLimits,
    breaker: CircuitBreaker,
    write_ledger: Arc<WriteLedger>,
    active: RwLock<BTreeMap<String, ActiveEntry>>,
    calls_in_flight: AtomicUsize,
    shutting_down: AtomicBool,
    inert: bool,
}

#[derive(Clone)]
struct ActiveEntry {
    plugin: Arc<ActivePlugin>,
    pool: Arc<PluginPool>,
}

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

fn hosts() -> &'static Mutex<HashMap<String, Arc<PluginHost>>> {
    static HOSTS: OnceLock<Mutex<HashMap<String, Arc<PluginHost>>>> = OnceLock::new();
    HOSTS.get_or_init(|| Mutex::new(HashMap::new()))
}

impl PluginHost {
    pub fn get(state: &AppState) -> Arc<PluginHost> {
        let key = state.db.name().to_string();
        let mut hosts = hosts().lock().expect("plugin host registry poisoned");
        Arc::clone(
            hosts
                .entry(key)
                .or_insert_with(|| Arc::new(PluginHost::new(state))),
        )
    }

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
            return Err(PluginHostError::NotActive(record.id.clone()));
        };

        let wasm_path = module_path(state, &record.id, &record.version, &backend.module);
        if !wasm_path.exists() {
            return Err(PluginHostError::Instantiate {
                plugin: record.id.clone(),
                message: format!("{} does not exist", wasm_path.display()),
            });
        }

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

        let limits = self.limits;
        let path = wasm_path.clone();
        let id_for_compile = record.id.clone();
        let pool = tokio::task::spawn_blocking(move || {
            PluginPool::compile_for(&id_for_compile, &path, &limits, host_fns::functions)
        })
        .await
        .map_err(|err| PluginHostError::Internal(anyhow::Error::new(err)))??;

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

        let capabilities = record.capabilities_approved.to_abi();
        let config_keys = record.manifest.config.keys().cloned().collect::<Vec<_>>();

        let plugin = Arc::new(ActivePlugin {
            id: record.id.clone(),
            version: record.version.clone(),
            capabilities,
            deps: record
                .manifest
                .optional_dependencies
                .iter()
                .chain(record.manifest.dependencies.iter())
                .map(|(id, range)| (id.clone(), range.clone()))
                .collect(),
            provides: record
                .manifest
                .provides
                .as_deref()
                .and_then(crate::manifest_schema::parse_plugin_ref)
                .map(|(id, version)| (id.to_string(), version.to_string())),
            callable: backend
                .exports
                .iter()
                .map(|(name, export)| (name.clone(), CallableExport::from_manifest(export)))
                .collect(),
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
        self.breaker.reset(&plugin.id);

        tracing::info!(
            plugin = %plugin.id, version = %plugin.version, abi = abi_version,
            hooks = plugin.hooks.len(), cron = plugin.cron.len(), routes = plugin.routes.len(),
            sha256 = %plugin.module_sha256,
            "plugin host: backend half activated"
        );
        Ok(plugin)
    }

    pub async fn deactivate(&self, plugin_id: &str) -> Result<(), PluginHostError> {
        let Some(entry) = self.unpublish(plugin_id) else {
            return Ok(());
        };
        let stranded = entry.pool.drain(self.limits.cron_timeout).await;
        self.write_ledger.forget(plugin_id);
        report_unload(plugin_id, stranded);
        Ok(())
    }

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

    fn unpublish(&self, plugin_id: &str) -> Option<ActiveEntry> {
        self.active
            .write()
            .expect("plugin host map poisoned")
            .remove(plugin_id)
    }

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
                tracing::error!(error = %err, "plugin host: could not read the plugin records");
                return Vec::new();
            }
        };

        let mut failures = Vec::new();
        for record in &records {
            if !record.state.is_active() || !record.manifest.has_backend() {
                continue;
            }
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

    pub fn breaker_state(&self, plugin_id: &str) -> BreakerState {
        self.breaker.state(plugin_id)
    }

    pub fn breaker_snapshot(&self) -> Vec<(String, BreakerState)> {
        self.breaker.snapshot()
    }

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
                self.deactivate_detached(plugin_id);
            }
        }
    }

    pub fn reset_breaker(&self, plugin_id: &str) {
        self.breaker.reset(plugin_id);
    }

    pub fn forget(&self, plugin_id: &str) {
        self.breaker.forget(plugin_id);
        self.write_ledger.forget(plugin_id);
    }

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
            hooks_pending: 0,
        }
    }

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

fn module_path(state: &AppState, id: &str, version: &str, module: &str) -> PathBuf {
    state.config.plugins_dir.join(id).join(version).join(module)
}

#[derive(Debug, thiserror::Error)]
pub enum CallFailure {
    #[error("the plugin refused: {0}")]
    Refused(abi::HostError),
    #[error(transparent)]
    Host(#[from] PluginHostError),
}

pub struct PluginHostWorkers {
    handles: Vec<tokio::task::JoinHandle<()>>,
}

impl PluginHostWorkers {
    pub async fn shutdown(self) {
        for handle in &self.handles {
            handle.abort();
        }
        for handle in self.handles {
            let _ = handle.await;
        }
    }
}

const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(30);

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

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::config::{Config, LogFormat, SessionSecret};

    pub(crate) fn config() -> Config {
        Config {
            mongo_uri: "mongodb://127.0.0.1:27017".to_string(),
            bind_addr: "127.0.0.1:0".parse().expect("a literal address"),
            session_secret: SessionSecret::new(vec![7u8; 48]).expect("48 bytes is enough"),
            mongo_database: "ddd_pluginhost_unit".to_string(),
            max_attachment_bytes: 1024 * 1024,
            max_document_bytes: ddd_core::limits::MAX_DOCUMENT_BYTES,
            app_origins: vec!["http://localhost:5173".to_string()],
            public_url: None,
            log_format: LogFormat::Pretty,
            cookie_secure: false,
            trust_proxy_headers: false,
            trash_retention_days: 30,
            checkpoint_every_changes: 1000,
            raw_change_days: 30,
            history_squash_interval: Duration::from_secs(3600),
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
        assert_eq!(
            invocation.kind.timeout(&PluginLimits::default()),
            Duration::from_millis(abi::limits::CRON_CALL_TIMEOUT_MS)
        );
        assert_eq!(
            CallKind::Route.timeout(&PluginLimits::default()),
            Duration::from_millis(abi::limits::CALL_TIMEOUT_MS)
        );
    }

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

    #[test]
    fn only_host_side_failures_count_on_the_breaker() {
        assert!(!PluginHostError::NotActive("calendar".into()).counts_as_failure());
        assert!(
            !PluginHostError::NoExport {
                plugin: "calendar".into(),
                export: "ddd_cron".into()
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
                    export: "ddd_http".into(),
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

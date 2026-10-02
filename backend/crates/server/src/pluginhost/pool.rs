use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ddd_plugin_abi as abi;

use super::PluginHostError;
use super::host_fns::HostContext;
use super::limits::PluginLimits;

struct Blueprint {
    wasm: std::path::PathBuf,
    limits: PluginLimits,
    functions_for: Box<dyn Fn() -> Vec<extism::Function> + Send + Sync>,
}

impl Blueprint {
    fn compile(&self, plugin_id: &str) -> Result<extism::CompiledPlugin, PluginHostError> {
        let manifest = extism::Manifest::new([extism::Wasm::file(&self.wasm)])
            .disallow_all_hosts()
            .with_memory_max(self.limits.max_pages())
            .with_timeout(self.limits.cron_timeout.max(self.limits.call_timeout));

        extism::PluginBuilder::new(manifest)
            .with_wasi(false)
            .with_functions((self.functions_for)())
            .compile()
            .map_err(|err| PluginHostError::Instantiate {
                plugin: plugin_id.to_string(),
                message: format!("{err:#}"),
            })
    }
}

pub struct PluginPool {
    plugin_id: String,
    blueprint: Blueprint,
    limits: PluginLimits,
    permits: Arc<tokio::sync::Semaphore>,
    idle: Mutex<Vec<Pooled>>,
    spare: Mutex<Vec<extism::CompiledPlugin>>,
    init: Mutex<Option<Vec<u8>>>,
    live: AtomicUsize,
    in_flight: AtomicUsize,
    calls_total: AtomicU64,
    compiles: AtomicU64,
    draining: AtomicBool,
}

pub struct Pooled {
    plugin: extism::Plugin,
    compiled: extism::CompiledPlugin,
    initialised: bool,
    #[allow(dead_code)]
    created_at: Instant,
    last_used: Instant,
    calls: u64,
}

pub struct InstanceGuard {
    pooled: Option<Pooled>,
    pool: Arc<PluginPool>,
    _permit: tokio::sync::OwnedSemaphorePermit,
    poisoned: bool,
}

impl InstanceGuard {
    pub fn call_export(
        &mut self,
        export: &str,
        payload: &[u8],
        context: Arc<HostContext>,
    ) -> Result<Vec<u8>, PluginHostError> {
        let plugin_id = self.pool.plugin_id.clone();
        let deadline = context.deadline;

        if deadline.expired() {
            self.poison("the invocation deadline had already passed");
            return Err(PluginHostError::Timeout {
                plugin: plugin_id,
                budget_ms: 0,
            });
        }

        let Some(pooled) = self.pooled.as_mut() else {
            return Err(PluginHostError::Internal(anyhow::anyhow!(
                "instance guard used after it was poisoned"
            )));
        };

        let cancelled = Arc::new(AtomicBool::new(false));
        let handle = pooled.plugin.cancel_handle();
        let budget = deadline.remaining();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        let watchdog = {
            let cancelled = Arc::clone(&cancelled);
            let plugin_id = plugin_id.clone();
            std::thread::Builder::new()
                .name(format!("ddd-plugin-deadline-{plugin_id}"))
                .spawn(move || {
                    if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
                        done_rx.recv_timeout(budget)
                    {
                        cancelled.store(true, Ordering::SeqCst);
                        if let Err(err) = handle.cancel() {
                            tracing::warn!(
                                plugin = %plugin_id, error = %err,
                                "plugin host: could not cancel a call that passed its deadline"
                            );
                        }
                    }
                })
                .map_err(|err| PluginHostError::Internal(anyhow::Error::new(err)))?
        };

        let started = Instant::now();
        let result = pooled
            .plugin
            .call_with_host_context::<&[u8], Vec<u8>, Arc<HostContext>>(export, payload, context);
        pooled.calls += 1;
        pooled.last_used = Instant::now();
        drop(done_tx);
        let _ = watchdog.join();
        self.pool.calls_total.fetch_add(1, Ordering::Relaxed);

        match result {
            Ok(bytes) => {
                if bytes.len() > abi::limits::MAX_HOST_OUTPUT_BYTES {
                    self.poison("the export returned more than the output cap");
                    return Err(PluginHostError::BadResponse {
                        plugin: plugin_id,
                        message: format!(
                            "the export returned {} bytes, over the {} byte cap",
                            bytes.len(),
                            abi::limits::MAX_HOST_OUTPUT_BYTES
                        ),
                    });
                }
                Ok(bytes)
            }
            Err(err) => {
                let timed_out = cancelled.load(Ordering::SeqCst) || deadline.expired();
                self.poison(if timed_out { "deadline" } else { "trap" });
                if timed_out {
                    Err(PluginHostError::Timeout {
                        plugin: plugin_id,
                        budget_ms: u64::try_from(budget.as_millis()).unwrap_or(u64::MAX),
                    })
                } else {
                    Err(PluginHostError::Trap {
                        plugin: plugin_id,
                        message: format!("{err:#} (after {} ms)", started.elapsed().as_millis()),
                    })
                }
            }
        }
    }

    pub fn has_export(&self, export: &str) -> bool {
        self.pooled
            .as_ref()
            .is_some_and(|pooled| pooled.plugin.function_exists(export))
    }

    pub fn poison(&mut self, reason: &str) {
        if !self.poisoned {
            tracing::debug!(
                plugin = %self.pool.plugin_id, %reason,
                "plugin host: dropping a poisoned instance"
            );
        }
        self.poisoned = true;
    }
}

impl Drop for InstanceGuard {
    fn drop(&mut self) {
        self.pool.in_flight.fetch_sub(1, Ordering::Relaxed);
        match self.pooled.take() {
            Some(pooled) if !self.poisoned && !self.pool.draining.load(Ordering::Relaxed) => {
                let mut idle = self.pool.idle.lock().expect("plugin pool poisoned");
                idle.push(pooled);
            }
            Some(pooled) => {
                self.pool.live.fetch_sub(1, Ordering::Relaxed);
                self.pool.recycle_module(pooled.compiled);
            }
            None => {
                self.pool.live.fetch_sub(1, Ordering::Relaxed);
            }
        }
    }
}

impl PluginPool {
    pub fn compile(
        wasm: &Path,
        limits: &PluginLimits,
        functions_for: impl Fn() -> Vec<extism::Function> + Send + Sync + 'static,
    ) -> Result<Arc<PluginPool>, PluginHostError> {
        Self::compile_for("", wasm, limits, functions_for)
    }

    pub fn compile_for(
        plugin_id: &str,
        wasm: &Path,
        limits: &PluginLimits,
        functions_for: impl Fn() -> Vec<extism::Function> + Send + Sync + 'static,
    ) -> Result<Arc<PluginPool>, PluginHostError> {
        let blueprint = Blueprint {
            wasm: wasm.to_path_buf(),
            limits: *limits,
            functions_for: Box::new(functions_for),
        };
        let first = blueprint.compile(plugin_id)?;

        Ok(Arc::new(PluginPool {
            plugin_id: plugin_id.to_string(),
            blueprint,
            limits: *limits,
            permits: Arc::new(tokio::sync::Semaphore::new(limits.max_instances)),
            idle: Mutex::new(Vec::new()),
            spare: Mutex::new(vec![first]),
            init: Mutex::new(None),
            live: AtomicUsize::new(0),
            in_flight: AtomicUsize::new(0),
            calls_total: AtomicU64::new(0),
            compiles: AtomicU64::new(1),
            draining: AtomicBool::new(false),
        }))
    }

    pub fn probe_abi_version(&self) -> Result<u32, PluginHostError> {
        let mut pooled = self.instantiate()?;
        let outcome = self.probe_on(&mut pooled);
        match outcome {
            Ok(version) => {
                pooled.calls += 1;
                self.idle.lock().expect("plugin pool poisoned").push(pooled);
                Ok(version)
            }
            Err(err) => {
                self.discard(pooled);
                Err(err)
            }
        }
    }

    fn probe_on(&self, pooled: &mut Pooled) -> Result<u32, PluginHostError> {
        if !pooled.plugin.function_exists(abi::names::ABI_VERSION) {
            return Err(PluginHostError::NoExport {
                plugin: self.plugin_id.clone(),
                export: abi::names::ABI_VERSION.to_string(),
            });
        }
        let raw: Vec<u8> = pooled
            .plugin
            .call(abi::names::ABI_VERSION, "")
            .map_err(|err| PluginHostError::Trap {
                plugin: self.plugin_id.clone(),
                message: format!("{}: {err:#}", abi::names::ABI_VERSION),
            })?;
        let envelope: abi::Envelope<u32> =
            serde_json::from_slice(&raw).map_err(|err| PluginHostError::BadResponse {
                plugin: self.plugin_id.clone(),
                message: format!(
                    "{} did not answer with an envelope: {err}",
                    abi::names::ABI_VERSION
                ),
            })?;
        envelope
            .into_result()
            .map_err(|err| PluginHostError::BadResponse {
                plugin: self.plugin_id.clone(),
                message: format!("{} refused: {err}", abi::names::ABI_VERSION),
            })?
            .ok_or_else(|| PluginHostError::BadResponse {
                plugin: self.plugin_id.clone(),
                message: format!("{} answered with no value", abi::names::ABI_VERSION),
            })
    }

    pub fn exports(&self) -> Result<Vec<String>, PluginHostError> {
        let recycled = self.idle.lock().expect("plugin pool poisoned").pop();
        let pooled = match recycled {
            Some(pooled) => pooled,
            None => self.instantiate()?,
        };
        let found = abi::names::EXPORTS
            .iter()
            .filter(|name| pooled.plugin.function_exists(name))
            .map(|name| (*name).to_string())
            .collect();
        self.idle.lock().expect("plugin pool poisoned").push(pooled);
        Ok(found)
    }

    pub fn set_init_payload(&self, payload: Option<Vec<u8>>) {
        *self.init.lock().expect("plugin pool poisoned") = payload;
    }

    pub async fn acquire(
        self: &Arc<Self>,
        context: Arc<HostContext>,
    ) -> Result<InstanceGuard, PluginHostError> {
        if self.draining.load(Ordering::Relaxed) {
            return Err(PluginHostError::ShuttingDown);
        }
        let wait = self.limits.pool_acquire_timeout;
        let permit =
            match tokio::time::timeout(wait, Arc::clone(&self.permits).acquire_owned()).await {
                Ok(Ok(permit)) => permit,
                Ok(Err(_)) => return Err(PluginHostError::ShuttingDown),
                Err(_) => {
                    return Err(PluginHostError::PoolExhausted {
                        plugin: self.plugin_id.clone(),
                        waited_ms: u64::try_from(wait.as_millis()).unwrap_or(u64::MAX),
                    });
                }
            };
        if self.draining.load(Ordering::Relaxed) {
            return Err(PluginHostError::ShuttingDown);
        }

        let recycled = self.idle.lock().expect("plugin pool poisoned").pop();
        let pooled = match recycled {
            Some(pooled) => pooled,
            None => {
                let pool = Arc::clone(self);
                tokio::task::spawn_blocking(move || pool.instantiate())
                    .await
                    .map_err(|err| PluginHostError::Internal(anyhow::Error::new(err)))??
            }
        };

        let needs_init = !pooled.initialised;
        self.in_flight.fetch_add(1, Ordering::Relaxed);
        let mut guard = InstanceGuard {
            pooled: Some(pooled),
            pool: Arc::clone(self),
            _permit: permit,
            poisoned: false,
        };

        if needs_init {
            let payload = self.init.lock().expect("plugin pool poisoned").clone();
            if let Some(pooled) = guard.pooled.as_mut() {
                pooled.initialised = true;
            }
            if let Some(payload) = payload {
                let context = Arc::clone(&context);
                let (returned, outcome) = tokio::task::spawn_blocking(move || {
                    let out = guard.call_export(abi::names::INIT, &payload, context);
                    (guard, out)
                })
                .await
                .map_err(|err| PluginHostError::Internal(anyhow::Error::new(err)))?;
                guard = returned;
                let bytes = outcome?;
                let envelope: abi::Envelope<serde_json::Value> = serde_json::from_slice(&bytes)
                    .map_err(|err| PluginHostError::BadResponse {
                        plugin: self.plugin_id.clone(),
                        message: format!(
                            "{} did not answer with an envelope: {err}",
                            abi::names::INIT
                        ),
                    })?;
                if let Err(refusal) = envelope.into_result() {
                    guard.poison("ddd_init refused");
                    return Err(PluginHostError::BadResponse {
                        plugin: self.plugin_id.clone(),
                        message: format!("{} refused: {refusal}", abi::names::INIT),
                    });
                }
            }
        }

        Ok(guard)
    }

    pub fn evict_idle(&self, now: Instant) -> usize {
        let mut idle = self.idle.lock().expect("plugin pool poisoned");
        let before = idle.len();
        idle.retain(|pooled| {
            now.saturating_duration_since(pooled.last_used) < self.limits.instance_idle_timeout
        });
        let dropped = before - idle.len();
        if dropped > 0 {
            self.live.fetch_sub(dropped, Ordering::Relaxed);
            tracing::debug!(
                plugin = %self.plugin_id, instances = dropped,
                "plugin host: evicted idle instances"
            );
        }
        dropped
    }

    pub async fn drain(&self, grace: Duration) -> usize {
        self.draining.store(true, Ordering::Relaxed);
        let deadline = Instant::now() + grace;
        while self.in_flight.load(Ordering::Relaxed) > 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.permits.close();
        let stranded = self.in_flight.load(Ordering::Relaxed);
        let dropped = {
            let mut idle = self.idle.lock().expect("plugin pool poisoned");
            let count = idle.len();
            idle.clear();
            count
        };
        self.spare.lock().expect("plugin pool poisoned").clear();
        let _ = self
            .live
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |live| {
                Some(live.saturating_sub(dropped))
            });
        stranded
    }

    pub fn stats(&self) -> PoolStats {
        PoolStats {
            instances: self.live.load(Ordering::Relaxed),
            in_flight: self.in_flight.load(Ordering::Relaxed),
            waiters: self
                .limits
                .max_instances
                .saturating_sub(self.permits.available_permits())
                .saturating_sub(self.in_flight.load(Ordering::Relaxed)),
            calls_total: self.calls_total.load(Ordering::Relaxed),
            compiles: self.compiles.load(Ordering::Relaxed),
        }
    }

    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    fn instantiate(&self) -> Result<Pooled, PluginHostError> {
        let recycled = self.spare.lock().expect("plugin pool poisoned").pop();
        let compiled = match recycled {
            Some(compiled) => compiled,
            None => {
                tracing::debug!(
                    plugin = %self.plugin_id,
                    "plugin host: compiling another module for a new instance slot"
                );
                let compiled = self.blueprint.compile(&self.plugin_id)?;
                self.compiles.fetch_add(1, Ordering::Relaxed);
                compiled
            }
        };
        let plugin = match extism::Plugin::new_from_compiled(&compiled) {
            Ok(plugin) => plugin,
            Err(err) => {
                self.recycle_module(compiled);
                return Err(PluginHostError::Instantiate {
                    plugin: self.plugin_id.clone(),
                    message: format!("{err:#}"),
                });
            }
        };
        self.live.fetch_add(1, Ordering::Relaxed);
        Ok(Pooled {
            plugin,
            compiled,
            initialised: false,
            created_at: Instant::now(),
            last_used: Instant::now(),
            calls: 0,
        })
    }

    fn discard(&self, pooled: Pooled) {
        self.live.fetch_sub(1, Ordering::Relaxed);
        self.recycle_module(pooled.compiled);
    }

    fn recycle_module(&self, compiled: extism::CompiledPlugin) {
        if self.draining.load(Ordering::Relaxed) {
            return;
        }
        let mut spare = self.spare.lock().expect("plugin pool poisoned");
        if spare.len() < self.limits.max_instances {
            spare.push(compiled);
        }
    }
}

#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct PoolStats {
    pub instances: usize,
    pub in_flight: usize,
    pub waiters: usize,
    pub calls_total: u64,
    pub compiles: u64,
}

//! The instance pool: **Extism calls are not reentrant**, so an instance serves one call
//! at a time and a plugin's concurrency is its instance count (SPEC §6.3).
//!
//! # Why a pool and not an instance per call
//!
//! Compilation is expensive and instantiation is not: [`extism::CompiledPlugin`] holds the
//! compiled module, and each [`extism::Plugin`] is a fresh linear memory over it. So the
//! pool caches *instances* (cheap, but not free — a 128 MB budget each) behind a
//! per-plugin permit count, and caches the *compiled module* forever until unload.
//!
//! # One compiled module, many contexts
//!
//! Host functions are registered on the *builder*, so they are baked into the compiled
//! module and shared by every instance of it. The thing that is **not** shared is the
//! per-call [`HostContext`] — the deadline, the counters, the call stack, the user. It
//! travels through Extism's own per-call channel (`call_with_host_context`, read back by
//! `CurrentPlugin::host_context`), which is the only way four concurrent instances of one
//! plugin can each see their own deadline. Baking a context into the closures at compile
//! time would give every later call the first one's deadline.
//!
//! # One engine per instance, not one per plugin
//!
//! [`extism::CompiledPlugin`] owns a `wasmtime::Engine`, and every instance made from one
//! compiled module shares it. **Cancellation is engine-wide**: an
//! [`extism::CancelHandle`]'s `cancel()` sends `TimerAction::Cancel`, whose entire action is
//! `engine.increment_epoch()`, and every store on that engine runs with
//! `set_epoch_deadline(1)`. So one increment trips the deadline of *every* store on the
//! engine — not just the call that was cancelled.
//!
//! With one engine per plugin that made the deadline watchdog a plugin-wide weapon: the
//! calendar's 06:00 cron run hitting its 60 s budget trapped the three other in-flight calls
//! of the same plugin at their next Wasm instruction. Those calls reported
//! [`PluginHostError::Trap`] rather than `Timeout` (their own `cancelled` flag was false and
//! their deadlines had not passed), so the failure was misattributed, instances were poisoned
//! mid-write leaving a half-spliced document set, a user's route got a 502, and each
//! collateral trap counted against the breaker — five of them disabled a healthy plugin. The
//! `with_timeout` backstop in the manifest fired through the same engine-wide increment.
//!
//! So the pool compiles **one module per instance slot**. Compilation is the expensive step,
//! which is why a slot's [`extism::CompiledPlugin`] outlives its instance: a poisoned
//! instance returns its compiled module to [`PluginPool::spare`] and costs one
//! instantiation, not one compilation. The bound is `max_instances`, so the cost is a fixed
//! multiple of one compile per plugin, paid lazily as concurrency actually demands it.
//!
//! # Poisoning
//!
//! A trap leaves an instance in an undefined state. A poisoned instance is **dropped, not
//! returned**: reusing it would carry one plugin bug into the next unrelated call, which
//! is the kind of failure nobody ever reproduces. Extism's `Plugin::reset` exists, but
//! "throw it away" is one line and always correct.
//!
//! # Two timers, deliberately
//!
//! The Extism manifest carries a timeout (its epoch-interruption timer) set to the
//! *longest* budget any call may have — the cron one — because the manifest is fixed when
//! the module is compiled and a single module serves both hooks and cron. The **per-call**
//! budget is then enforced here with a [`extism::CancelHandle`] and a watchdog thread. The
//! manifest timer is the backstop for the case that matters: a plugin in a Wasm loop that
//! never returns to the host, where nothing on this side gets a chance to run.
//!
//! # Unload waits
//!
//! [`PluginPool::drain`] stops handing out permits and waits for outstanding guards —
//! SPEC §6.3's "hot unload waits on in-flight calls (refcount)". Cancelling a call
//! mid-write would leave a half-written document set with nobody to finish it.
//!
//! **Owner:** the `wasm-host` builder.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ddd_plugin_abi as abi;

use super::PluginHostError;
use super::host_fns::HostContext;
use super::limits::PluginLimits;

/// Everything needed to compile one more module for one more instance slot.
///
/// Held rather than a single [`extism::CompiledPlugin`] because each instance needs its own
/// engine (see the module docs: cancellation is engine-wide).
struct Blueprint {
    wasm: std::path::PathBuf,
    limits: PluginLimits,
    functions_for: Box<dyn Fn() -> Vec<extism::Function> + Send + Sync>,
}

impl Blueprint {
    /// Compile one module on its own engine. Synchronous and expensive: Wasmtime parses and
    /// codegens the whole module.
    fn compile(&self, plugin_id: &str) -> Result<extism::CompiledPlugin, PluginHostError> {
        let manifest = extism::Manifest::new([extism::Wasm::file(&self.wasm)])
            // SPEC §6.2: outbound HTTP is the *host's* business — the allowlist, the IP
            // policy and the address pinning all live in `host_fns::http_request`. The
            // PDK's built-in HTTP must therefore refuse, which it does when no host is
            // allowed. Stated explicitly rather than relying on the default.
            .disallow_all_hosts()
            .with_memory_max(self.limits.max_pages())
            // The *longest* budget a call may have. The per-call deadline is enforced by
            // `InstanceGuard::call_export`; this is the backstop for a plugin that never
            // returns to the host at all. It is per-engine, hence per-instance, so it
            // cannot reach a sibling call either.
            .with_timeout(self.limits.cron_timeout.max(self.limits.call_timeout));

        extism::PluginBuilder::new(manifest)
            // No WASI: a backend plugin has no business with files, clocks or argv. Its
            // whole world is the host functions.
            .with_wasi(false)
            .with_functions((self.functions_for)())
            .compile()
            .map_err(|err| PluginHostError::Instantiate {
                plugin: plugin_id.to_string(),
                message: format!("{err:#}"),
            })
    }
}

/// A pool of live instances, each on its own compiled module and engine.
pub struct PluginPool {
    plugin_id: String,
    blueprint: Blueprint,
    limits: PluginLimits,
    /// One permit per allowed concurrent call. Acquired *before* an instance is taken, so
    /// the permit count — not the idle list — is what bounds memory.
    permits: Arc<tokio::sync::Semaphore>,
    /// Warm instances, most recently used last.
    idle: Mutex<Vec<Pooled>>,
    /// Compiled modules whose instance was thrown away (poisoned, or drained). Kept so a
    /// trap costs one instantiation rather than one compilation, and capped at
    /// `max_instances` so a churning plugin cannot accumulate engines.
    spare: Mutex<Vec<extism::CompiledPlugin>>,
    /// The `ddd_init` payload, set once at activation. `None` ⇒ the module has no `ddd_init`
    /// and a fresh instance is usable immediately.
    init: Mutex<Option<Vec<u8>>>,
    /// Instances that exist right now (idle + checked out). The memory number.
    live: AtomicUsize,
    in_flight: AtomicUsize,
    calls_total: AtomicU64,
    /// How many modules this pool has compiled. One per instance slot, so this is also the
    /// observable form of "each instance has its own engine" — the property that keeps one
    /// call's cancel from trapping its siblings.
    compiles: AtomicU64,
    /// Set by [`PluginPool::drain`]: no new instance is handed out after it.
    draining: AtomicBool,
}

/// One warm instance and its bookkeeping.
pub struct Pooled {
    plugin: extism::Plugin,
    /// The instance's own compiled module — and therefore its own engine, which is what
    /// keeps a cancel from reaching a sibling call. Outlives the instance: on poison the
    /// module goes back to [`PluginPool::spare`] and the instance is dropped.
    compiled: extism::CompiledPlugin,
    /// Has this instance had its `ddd_init` attempted? Set by [`PluginPool::acquire`], which
    /// is the only place `ddd_init` runs. **Not** the same question as "was this instance made
    /// by this call": activation warms an instance before the init payload even exists.
    initialised: bool,
    #[allow(dead_code)]
    created_at: Instant,
    last_used: Instant,
    calls: u64,
}

/// A checked-out instance. Returns itself to the pool on drop — unless it was poisoned.
pub struct InstanceGuard {
    pooled: Option<Pooled>,
    pool: Arc<PluginPool>,
    /// Held for the lifetime of the guard; released on drop, which is what wakes a waiter.
    _permit: tokio::sync::OwnedSemaphorePermit,
    poisoned: bool,
}

impl InstanceGuard {
    /// Call an export with a JSON payload, under the invocation's deadline.
    ///
    /// Runs the Extism call and translates its outcome: a cancel from the deadline timer
    /// is [`PluginHostError::Timeout`], a Wasm trap is [`PluginHostError::Trap`], and a
    /// return value that is not an [`ddd_plugin_abi::Envelope`] is
    /// [`PluginHostError::BadResponse`]. All three poison the instance.
    ///
    /// **Blocking.** Extism calls are synchronous; the caller runs this on a
    /// [`tokio::task::spawn_blocking`] thread (see [`super::PluginHost::call`]).
    pub fn call_export(
        &mut self,
        export: &str,
        payload: &[u8],
        context: Arc<HostContext>,
    ) -> Result<Vec<u8>, PluginHostError> {
        let plugin_id = self.pool.plugin_id.clone();
        let deadline = context.deadline;

        // Refuse before the call rather than being cancelled one instruction in: a
        // `call_plugin` chain whose budget is already spent should not start a write it
        // cannot finish (HOST-ABI.md §5).
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

        // The watchdog: a thread that cancels the call if the deadline passes first. It is
        // woken by the sender being dropped when the call returns, so the common case costs
        // one thread for the duration of one call and no polling at all.
        //
        // `Disconnected` (the call finished) must *not* cancel: the cancel handle affects
        // the next call on this instance too, and a stray cancel would fail an innocent
        // one.
        //
        // The cancel reaches every store on this instance's engine — which is why each
        // instance has an engine of its own (see the module docs). Without that, this
        // watchdog trapped every concurrently-running call of the same plugin.
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
        // Wake the watchdog; then wait for it, so the handle can never outlive this call
        // and cancel the next one.
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
                // Every failure poisons: a trapped or cancelled instance has an undefined
                // linear memory, and the plugin's own allocator state is part of that.
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

    /// `true` when the module has this export. Checked before scheduling, so a hook is
    /// never dispatched to a plugin that cannot receive it.
    pub fn has_export(&self, export: &str) -> bool {
        self.pooled
            .as_ref()
            .is_some_and(|pooled| pooled.plugin.function_exists(export))
    }

    /// Mark the instance unusable: it is dropped instead of returned.
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
                // Dropped, not returned. The permit still comes back (it is released when
                // `_permit` drops), so the pool re-instantiates on the next call — and
                // re-instantiating over the *same* compiled module is cheap, so the module
                // (and the engine that makes this instance's cancels its own) is kept.
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
    /// Compile a module once. The expensive step, done at activation.
    ///
    /// The Extism manifest is built here with **no `allowed_hosts`** (so the PDK's
    /// built-in HTTP refuses — ours is the one with the allowlist), `max_pages` from the
    /// limits, and a timeout so Extism's own epoch timer interrupts a runaway call even if
    /// the host's deadline logic is bypassed. Belt and braces, because an uninterruptible
    /// Wasm loop would hold a blocking thread forever.
    pub fn compile(
        wasm: &Path,
        limits: &PluginLimits,
        functions_for: impl Fn() -> Vec<extism::Function> + Send + Sync + 'static,
    ) -> Result<Arc<PluginPool>, PluginHostError> {
        Self::compile_for("", wasm, limits, functions_for)
    }

    /// [`PluginPool::compile`], carrying the plugin id so every log line and error names
    /// which plugin it is about.
    ///
    /// Compiles **one** module here, eagerly: a `.wasm` Wasmtime cannot accept must fail
    /// activation rather than the first call. The rest are compiled lazily, one per instance
    /// slot, as concurrency demands them.
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

    /// Instantiate once and ask the module for its ABI version, **before** any of the
    /// plugin's own code has run against a context.
    ///
    /// This is the stale-`.wasm` guard of SPEC §6.4 applied to the backend half: the
    /// manifest can lie, and a `.wasm` can outlive the manifest that describes it. Run
    /// before `ddd_init` so a module built against another major never executes a line of
    /// its own logic.
    pub fn probe_abi_version(&self) -> Result<u32, PluginHostError> {
        let mut pooled = self.instantiate()?;
        let outcome = self.probe_on(&mut pooled);
        match outcome {
            // Keep the probe instance: it is already warm, and throwing it away would mean
            // paying for instantiation twice on the first real call. It has **not** run
            // `ddd_init` — `Pooled::initialised` says so, and `acquire` is what runs it.
            Ok(version) => {
                pooled.calls += 1;
                self.idle.lock().expect("plugin pool poisoned").push(pooled);
                Ok(version)
            }
            // A module that cannot answer the probe is not one to keep warm.
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

    /// Which of the ABI's exports this module actually has.
    ///
    /// Read once at activation so no hot path asks, and so a hook is never *scheduled* for
    /// a plugin that cannot receive it.
    /// Safe to do outside the permit system because activation happens before the plugin
    /// is published, so nothing else can be calling it yet.
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

    /// The payload every freshly instantiated instance is initialised with. `None` when
    /// the module has no `ddd_init`.
    pub fn set_init_payload(&self, payload: Option<Vec<u8>>) {
        *self.init.lock().expect("plugin pool poisoned") = payload;
    }

    /// Take an instance, instantiating one if the pool is below its permit count.
    ///
    /// Waits at most [`PluginLimits::pool_acquire_timeout`], then
    /// [`PluginHostError::PoolExhausted`] — which the caller turns into `unavailable`
    /// rather than queueing forever behind a slow cron run.
    ///
    /// An **uninitialised** instance is initialised here (`ddd_init`, once per instance —
    /// SPEC's pooling means "once per plugin" is not a thing the host can offer).
    ///
    /// The test is [`Pooled::initialised`], not "did this call instantiate it". Keying on
    /// freshness was wrong in the one case that always happens: activation's
    /// [`PluginPool::probe_abi_version`] and [`PluginPool::exports`] leave a warm instance in
    /// the idle list *before* [`PluginPool::set_init_payload`] has been called, so the very
    /// first invocation of every plugin popped an instance, saw `fresh == false`, and skipped
    /// `ddd_init` entirely. HOST-ABI.md §4.1 promises the payload — with the approved
    /// capability set, so a plugin can "degrade deliberately instead of discovering denials
    /// per call" — runs once per instance; a plugin caching it in a static saw its default
    /// until traffic forced a second instance, and an `ddd_init` refusal (which is supposed to
    /// mark the plugin failed) was unreachable on that one.
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
                // The semaphore was closed — `drain` did that.
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
                // Instantiation is synchronous and allocates the linear memory — and it may
                // have to compile this slot's module first — so it goes on a blocking thread
                // like a call does.
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
            // Marked before the call: a `ddd_init` that traps poisons the instance and it is
            // never returned, and one that succeeds must not be asked again. Either way this
            // instance's `ddd_init` has been attempted exactly once.
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
                // A refusal from `ddd_init` is the plugin saying it cannot work. Treat the
                // instance as unusable rather than handing back one that said no.
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

    /// Drop instances idle longer than [`PluginLimits::instance_idle_timeout`]; returns
    /// how many. Called from the maintenance loop — 128 MB of idle plugin is worth
    /// reclaiming.
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

    /// Stop handing out instances and wait for the outstanding ones (up to `grace`).
    ///
    /// Returns how many calls were still in flight when the grace ran out — a non-zero
    /// answer is worth a log line, because it means a plugin held a write past shutdown.
    pub async fn drain(&self, grace: Duration) -> usize {
        self.draining.store(true, Ordering::Relaxed);
        let deadline = Instant::now() + grace;
        while self.in_flight.load(Ordering::Relaxed) > 0 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // Closing the semaphore wakes every waiter with an error instead of leaving it on a
        // queue that will never move.
        self.permits.close();
        let stranded = self.in_flight.load(Ordering::Relaxed);
        let dropped = {
            let mut idle = self.idle.lock().expect("plugin pool poisoned");
            let count = idle.len();
            idle.clear();
            count
        };
        // The compiled modules go too: a drained pool is not coming back, and each one holds
        // a Wasmtime engine and its code memory.
        self.spare.lock().expect("plugin pool poisoned").clear();
        // `live` counts idle + checked out; only the idle ones just went away.
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

    /// Instantiate one [`extism::Plugin`], on a compiled module of its own.
    ///
    /// Reuses a module from [`PluginPool::spare`] when one is free and compiles a new one
    /// otherwise. Blocking and potentially expensive (a compile), which is why every caller
    /// is on a blocking thread or on the activation path.
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
                // The module is fine even though the instantiation was not — keep it.
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

    /// Throw an instance away but keep its compiled module for the next one.
    fn discard(&self, pooled: Pooled) {
        self.live.fetch_sub(1, Ordering::Relaxed);
        self.recycle_module(pooled.compiled);
    }

    /// Put a compiled module back on the free list, up to the concurrency bound. Beyond that
    /// it is dropped: an engine and its code memory are not worth hoarding.
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
    /// Compiled modules made for this plugin — one per instance slot ever used.
    pub compiles: u64,
}

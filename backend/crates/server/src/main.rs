//! Binary entry point. **Wiring only** — no business logic, no handlers, no SQL
//! (or rather, no Mongo queries). Boot order is deliberately visible here:
//!
//! 1. parse the CLI (the `reset-password` break-glass path exits early),
//! 2. load config, install tracing + metrics,
//! 3. connect to Mongo, run migrations, ensure indexes,
//! 4. build `AppState`, start the docstore workers,
//! 5. assemble the router, serve, and on SIGTERM flush dirty rooms and exit
//!    within the grace period (SPEC §8).

use std::process::ExitCode;
use std::sync::atomic::Ordering;
use std::time::Duration;

use clap::{Parser, Subcommand};
use life_manager_server::{
    auth, config::Config, db, pluginhost, plugininstall, plugins, routes, state::AppState,
    telemetry,
};
use tracing::{error, info, warn};

/// How often sampled gauges are refreshed and housekeeping runs.
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Debug, Parser)]
#[command(name = "life-manager", version, about = "Life Manager server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the server (default).
    Serve,
    /// Break-glass password reset (SPEC §5.1): prints a one-time reset token for
    /// the given account, without needing an admin session.
    ResetPassword {
        #[arg(long)]
        email: String,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();

    match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            // Tracing may not be installed yet, so print as well.
            eprintln!("fatal: {err:#}");
            tracing::error!(error = ?err, "fatal");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> anyhow::Result<()> {
    let config = Config::from_env()?;
    telemetry::init_tracing(config.log_format)?;

    match cli.command.unwrap_or(Command::Serve) {
        // Forwarded, not reimplemented: `auth::reset::issue` is the one path that
        // can mint a reset token, and it also invalidates any outstanding unused
        // token for the account — a second code path here would drift from it.
        Command::ResetPassword { email } => auth::cli::reset_password(config, email.trim()).await,
        Command::Serve => serve(config).await,
    }
}

async fn serve(config: Config) -> anyhow::Result<()> {
    let metrics = telemetry::init_metrics(&config)?;

    // Connect, migrate and seed *before* binding the listener: a failure in any
    // of them is a boot failure, not a server answering requests it cannot serve.
    let state = AppState::new(config).await?;
    let bind_addr = state.config.bind_addr;
    let grace = state.config.shutdown_grace;

    // Migrations, indexes, and the feed counter re-seeded on top of what the
    // migrations wrote (see `AppState::init_schema`).
    state.init_schema().await?;
    let schema_version = db::migrations::current_version(&state.db).await?;
    state
        .readiness
        .schema_version
        .store(schema_version, Ordering::Relaxed);
    state
        .readiness
        .migrations_complete
        .store(true, Ordering::Relaxed);
    info!(schema_version, "schema ready");

    // Scan the plugin directory at boot rather than lazily on the first request.
    // The registry is cached either way, so this is not about speed — it is about
    // *when the operator learns*. Scanned lazily, "0 plugins from …" and every
    // "plugin directory unreadable" line appears after someone has already loaded
    // the app into an empty shell; scanned here it is a startup log line next to
    // "schema ready", which is where a misdirected `PLUGINS_DIR` is cheap to spot.
    if state.config.disable_plugins {
        warn!("DISABLE_PLUGINS=1: no frontend plugins will be served (SPEC §6.1 recovery mode)");
    } else {
        let registry = plugins::reload(&state.config);
        let root = registry
            .root()
            .map(|root| root.display().to_string())
            .unwrap_or_else(|| "<none>".to_string());
        if registry.plugins().is_empty() {
            // Not fatal — an empty workspace is legal — but it is the M3
            // misconfiguration, so it is a warning rather than an info line.
            warn!(
                dir = %root,
                "no frontend plugins found: clients will boot into an empty shell"
            );
        } else {
            info!(dir = %root, plugins = registry.plugins().len(), "plugin registry loaded");
        }
        for problem in registry.problems() {
            warn!(path = %problem.path, message = %problem.message, "plugin not loaded");
        }
    }

    // M4: the backend plugin host. Boot order matters and is the same order the
    // frontend's is: reconcile what is on disk with the approval records, activate the
    // approved backend halves, *then* start cron and the hook dispatcher — a cron job
    // firing against a half-activated set would be the one bug nobody reproduces.
    //
    // None of it is fatal. A plugin that fails to compile or refuses its ABI check is
    // recorded and skipped (SPEC §6.4's rule for the frontend, applied here), because a
    // server that will not boot over a third-party plugin is a worse outcome than a
    // workspace missing one feature.
    let plugin_workers = if state.config.disable_plugins {
        None
    } else {
        match plugininstall::adopt_installed_directory(&state).await {
            Ok(0) => {}
            Ok(count) => info!(plugins = count, "adopted installed plugins into records"),
            Err(err) => {
                warn!(error = %err, "could not reconcile the plugin records with the directory")
            }
        }
        // The live wiring, before the first request asks for it: `welcome` reads the
        // in-memory copy (PLUGIN-PROTOCOLS §6).
        let wiring = life_manager_server::wiring::load(&state).await;
        info!(version = wiring.version, "wiring loaded");
        let host = pluginhost::PluginHost::get(&state);
        for (id, err) in host.reload(&state).await {
            warn!(plugin = %id, error = %err, "plugin backend not activated");
        }
        let stats = host.stats();
        info!(
            active = stats.active,
            disabled = stats.disabled,
            cron_jobs = stats.cron_jobs,
            "plugin host ready"
        );
        Some(pluginhost::spawn_workers(&state))
    };

    // The second install path of SPEC §6.2 — a `.zip` dropped into `PLUGIN_INBOX_DIR`.
    // `spawn` returns `None` when the variable is unset (the default) or plugins are
    // disabled, so this is a no-op on a server that has not asked for it. It lands the
    // package *pending*, exactly like an upload: dropping a file into a watched directory
    // is not evidence that a human read its capability list.
    let plugin_inbox = plugininstall::watcher::spawn(state.clone());
    if plugin_inbox.is_some() {
        info!(dir = ?state.config.plugin_inbox_dir, "watching the plugin inbox");
    }

    let maintenance = tokio::spawn(maintenance_loop(state.clone(), metrics.clone()));

    // Observability (request-id span + HTTP metrics) is part of `routes::router`'s
    // layer stack, so tests that build the router directly get it too.
    let app = routes::router(state.clone(), metrics);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    info!(%bind_addr, version = life_manager_server::VERSION, "listening");

    // SIGTERM: stop accepting, let in-flight requests finish, then flush. The
    // watchdog inside `shutdown` guarantees the process leaves within the grace
    // period even if a request hangs (SPEC §8).
    //
    // `into_make_service_with_connect_info` is not optional: it is what puts
    // `ConnectInfo<SocketAddr>` in the request extensions, and that is the only
    // honest client IP in the M1 deployment (Compose publishes this port
    // directly; no proxy sets `X-Forwarded-For`). Without it `auth::client_ip`
    // returns `None` and every IP-keyed control — the per-IP login backoff of
    // SPEC §5.2, the register and reset limiters — silently does nothing, while
    // every session row and audit entry records `ip: null` (SPEC §5.4).
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown(grace))
    .await?;

    maintenance.abort();

    // Close every sync socket with 4503 *before* the flush (SPEC §8). Sockets are
    // long-lived, so axum's graceful drain above has already returned with all of
    // them still open; telling clients "shutting down, come back" first means they
    // start their short-window reconnect while the flush runs, instead of waiting
    // for a TCP reset at process exit. The hub watches SIGTERM itself as a
    // backstop, but the explicit call is what makes the ordering deterministic.
    let closed = routes::sync::close_all_sockets(&state);
    if closed > 0 {
        info!(sockets = closed, "sync sockets closed with 4503");
    }

    // Plugins stop before the flush, and in this order for a reason: a cron job or a hook
    // still running would keep writing documents into the set we are about to flush, so
    // shutting the host down first means the flush is over a settled state. In-flight
    // calls are waited for rather than cancelled (SPEC §6.3's refcounted unload) — a
    // half-written machine-owned document has nobody to finish it.
    if let Some(inbox) = plugin_inbox {
        // Aborted rather than joined: the watcher's unit of work is one archive, and an
        // install in flight holds the Mongo queue lock whose TTL is the recovery path.
        inbox.abort();
    }
    if let Some(workers) = plugin_workers {
        workers.shutdown().await;
        pluginhost::PluginHost::get(&state).shutdown(grace).await;
        info!("plugin host stopped");
    }

    info!("shutting down: flushing documents");
    match tokio::time::timeout(grace, state.docs.flush_all()).await {
        Ok(Ok(())) => info!("flush complete"),
        Ok(Err(err)) => error!(error = %err, "flush failed"),
        Err(_) => error!("flush did not finish inside the shutdown grace period"),
    }

    Ok(())
}

/// Resolves when a shutdown signal arrives, and arms the hard deadline at that
/// moment rather than at boot.
async fn shutdown(grace: Duration) {
    telemetry::shutdown_signal().await;
    warn!(
        grace_secs = grace.as_secs(),
        "draining: no longer accepting connections"
    );
    telemetry::spawn_shutdown_watchdog(grace);
}

/// Periodic housekeeping that belongs to no single request: gauge sampling,
/// Prometheus upkeep (the recorder needs it to expire idle metrics), and the
/// login rate limiter's sweep, and expired chunked uploads.
async fn maintenance_loop(state: AppState, metrics: metrics_exporter_prometheus::PrometheusHandle) {
    let mut ticker = tokio::time::interval(MAINTENANCE_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // `interval`'s first tick fires immediately, so the gauges are sampled at boot
    // and then every `MAINTENANCE_INTERVAL`. Consequence worth knowing when reading
    // `/metrics`: a gauge is up to one period stale, and a scrape inside the first
    // period reports the *empty* workspace the server booted into. That is normal
    // for a sampled gauge against a 15–60 s Prometheus scrape, but it is why a
    // script that seeds data and scrapes two seconds later sees zeros.

    loop {
        ticker.tick().await;
        telemetry::sample_gauges(&state).await;
        metrics.run_upkeep();
        state.login_limiter.sweep();
        routes::uploads::sweep_expired(&state).await;
    }
}

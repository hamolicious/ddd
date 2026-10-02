use std::process::ExitCode;
use std::sync::atomic::Ordering;
use std::time::Duration;

use clap::{Parser, Subcommand};
use ddd_server::{
    auth, config::Config, db, pluginhost, plugininstall, plugins, routes, state::AppState,
    telemetry,
};
use tracing::{error, info, warn};

const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Debug, Parser)]
#[command(name = "ddd", version, about = "ddd server")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Serve,
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
        Command::ResetPassword { email } => auth::cli::reset_password(config, email.trim()).await,
        Command::Serve => serve(config).await,
    }
}

async fn serve(config: Config) -> anyhow::Result<()> {
    let metrics = telemetry::init_metrics(&config)?;

    let state = AppState::new(config).await?;
    let bind_addr = state.config.bind_addr;
    let grace = state.config.shutdown_grace;

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

    tokio::spawn({
        let query = std::sync::Arc::clone(&state.query);
        async move { query.warm().await }
    });

    if state.config.disable_plugins {
        warn!("DISABLE_PLUGINS=1: no frontend plugins will be served (SPEC §6.1 recovery mode)");
    } else {
        let registry = plugins::reload(&state.config);
        let root = registry
            .root()
            .map(|root| root.display().to_string())
            .unwrap_or_else(|| "<none>".to_string());
        if registry.plugins().is_empty() {
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

    let plugin_inbox = plugininstall::watcher::spawn(state.clone());
    if plugin_inbox.is_some() {
        info!(dir = ?state.config.plugin_inbox_dir, "watching the plugin inbox");
    }

    let maintenance = tokio::spawn(maintenance_loop(state.clone(), metrics.clone()));

    let app = routes::router(state.clone(), metrics);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    info!(%bind_addr, version = ddd_server::VERSION, "listening");

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown(grace))
    .await?;

    maintenance.abort();

    let closed = routes::sync::close_all_sockets(&state);
    if closed > 0 {
        info!(sockets = closed, "sync sockets closed with 4503");
    }

    if let Some(inbox) = plugin_inbox {
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

async fn shutdown(grace: Duration) {
    telemetry::shutdown_signal().await;
    warn!(
        grace_secs = grace.as_secs(),
        "draining: no longer accepting connections"
    );
    telemetry::spawn_shutdown_watchdog(grace);
}

async fn maintenance_loop(state: AppState, metrics: metrics_exporter_prometheus::PrometheusHandle) {
    let mut ticker = tokio::time::interval(MAINTENANCE_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        ticker.tick().await;
        telemetry::sample_gauges(&state).await;
        metrics.run_upkeep();
        state.login_limiter.sweep();
        routes::uploads::sweep_expired(&state).await;
    }
}

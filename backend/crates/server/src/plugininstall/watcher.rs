use std::path::{Path, PathBuf};
use std::time::Duration;

use tracing::{info, warn};

use crate::domain::Actor;
use crate::state::AppState;

use super::{InstallRequest, InstallSource, install, zipcheck};

pub const POLL_INTERVAL: Duration = Duration::from_secs(5);
pub const STABLE_WINDOW: Duration = Duration::from_secs(2);
pub const STABLE_TIMEOUT: Duration = Duration::from_secs(60);
pub const INSTALLED_DIR: &str = "installed";
pub const REJECTED_DIR: &str = "rejected";

pub fn spawn(state: AppState) -> Option<tokio::task::JoinHandle<()>> {
    if state.config.disable_plugins {
        return None;
    }
    let inbox = state.config.plugin_inbox_dir.clone()?;
    if let Err(err) = std::fs::create_dir_all(&inbox) {
        warn!(
            dir = %inbox.display(), error = %err,
            "PLUGIN_INBOX_DIR cannot be created; the drop-install path is off"
        );
        return None;
    }
    info!(dir = %inbox.display(), "watching for dropped plugin packages");

    Some(tokio::spawn(async move {
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            scan_once(&state, &inbox).await;
        }
    }))
}

pub async fn scan_once(state: &AppState, inbox: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(inbox) else {
        return 0;
    };

    let mut archives: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
        })
        .collect();
    archives.sort();

    let mut attempted = 0usize;
    for archive in archives {
        attempted += 1;
        handle_one(state, inbox, &archive).await;
    }
    attempted
}

async fn handle_one(state: &AppState, inbox: &Path, archive: &Path) {
    let probe = archive.to_path_buf();
    let stable = tokio::task::spawn_blocking(move || {
        zipcheck::wait_for_stable(&probe, STABLE_WINDOW, STABLE_TIMEOUT)
    })
    .await;

    match stable {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => {
            warn!(
                path = %archive.display(), error = %err,
                "a dropped package is not stable yet; retrying on the next scan"
            );
            return;
        }
        Err(err) => {
            warn!(path = %archive.display(), error = %err, "the stability check panicked");
            return;
        }
    }

    let request = InstallRequest {
        source: InstallSource::Directory {
            path: archive.display().to_string(),
        },
        archive: archive.to_path_buf(),
        actor: Actor::System,
        auto_approve: false,
    };

    match install(state, request).await {
        Ok(outcome) => {
            info!(
                plugin = %outcome.id, version = %outcome.version, state = outcome.state.as_str(),
                "installed a dropped plugin package"
            );
            move_aside(inbox, archive, INSTALLED_DIR, None);
        }
        Err(err) => {
            warn!(path = %archive.display(), error = %err, "a dropped plugin package was refused");
            move_aside(inbox, archive, REJECTED_DIR, Some(err.to_string()));
        }
    }
}

fn move_aside(inbox: &Path, archive: &Path, subdir: &str, error: Option<String>) {
    let target_dir = inbox.join(subdir);
    if let Err(err) = std::fs::create_dir_all(&target_dir) {
        warn!(dir = %target_dir.display(), error = %err, "could not create the inbox subdirectory");
        return;
    }
    let name = archive
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "package.zip".to_string());
    let stamped = format!("{}-{name}", crate::domain::new_id());
    let target = target_dir.join(&stamped);

    if let Err(err) = std::fs::rename(archive, &target) {
        warn!(
            from = %archive.display(), to = %target.display(), error = %err,
            "could not move a processed package out of the inbox; it will be retried"
        );
        return;
    }
    if let Some(error) = error {
        let sidecar = target_dir.join(format!("{stamped}.error.txt"));
        if let Err(err) = std::fs::write(&sidecar, format!("{error}\n")) {
            warn!(path = %sidecar.display(), error = %err, "could not write the rejection reason");
        }
    }
}

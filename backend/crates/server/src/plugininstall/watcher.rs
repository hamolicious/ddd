//! The directory-drop install path (SPEC §6.2: "admin upload and directory drop both land
//! as *pending* in admin").
//!
//! Drop `my-plugin-1.2.0.zip` into `PLUGIN_INBOX_DIR` and it is installed as pending. The
//! point is deployment without an HTTP session: a Compose volume, a Kubernetes
//! `initContainer`, an rsync from a build box.
//!
//! # Polling, not inotify
//!
//! A five-second poll instead of a filesystem-notification dependency. The rationale is
//! not laziness: the drop target is frequently a network or bind mount, where inotify
//! either does not fire or fires on a partially-written file, so a **stable-size check is
//! required either way** (SPEC §6.2: "the watcher waits for a stable file"). Once that
//! check exists, notifications buy latency nobody is waiting on — and cost a dependency
//! with platform-specific failure modes.
//!
//! # What happens to the file
//!
//! A successful install moves the archive to `<inbox>/installed/` and a failed one to
//! `<inbox>/rejected/` with a sibling `.error.txt`. Nothing is deleted: an operator who
//! dropped the wrong file gets it back, and a rejected package can be inspected.
//!
//! # The drop is not an approval
//!
//! A dropped package lands **pending**, exactly like an upload. Dropping a zip into a
//! directory the server watches is not evidence that a human read its capability list, and
//! the approval click is where that happens (SPEC §6.2). The only path that skips it is the
//! base distribution at first boot, and that is checked against
//! [`InstallSource::Base`](super::InstallSource::Base) inside the pipeline rather than
//! trusted from here.
//!
//! **Owner:** the `install-flow` builder.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tracing::{info, warn};

use crate::domain::Actor;
use crate::state::AppState;

use super::{InstallRequest, InstallSource, install, zipcheck};

/// How often the inbox is scanned.
pub const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// A file must not change size for this long before it is touched.
pub const STABLE_WINDOW: Duration = Duration::from_secs(2);
/// How long to wait for a file to become stable before giving up this round.
pub const STABLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Subdirectory a successful install moves the archive into.
pub const INSTALLED_DIR: &str = "installed";
/// Subdirectory a failed install moves it into, next to a `.error.txt`.
pub const REJECTED_DIR: &str = "rejected";

/// Start the watcher. Returns `None` when `PLUGIN_INBOX_DIR` is unset — the default, and
/// deliberately so: a server with no configured drop directory should not be watching
/// anything, and an unset path is clearer than a guessed one (the M3 lesson about relative
/// defaults resolving somewhere surprising).
pub fn spawn(state: AppState) -> Option<tokio::task::JoinHandle<()>> {
    if state.config.disable_plugins {
        // Safe mode: nothing installs, so nothing is watched (SPEC §6.1).
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
            // One scan at a time, and the install pipeline takes the queue lock itself, so
            // a slow install simply delays the next scan rather than overlapping with it.
            scan_once(&state, &inbox).await;
        }
    }))
}

/// One scan. Returns how many packages were installed (or attempted).
pub async fn scan_once(state: &AppState, inbox: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(inbox) else {
        // Not a warning per poll: an unmounted volume would fill the log with one line
        // every five seconds. The boot line above already said the directory is watched.
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
    // Deterministic order, so two packages dropped together install in the same order on
    // every machine — which matters when one depends on the other.
    archives.sort();

    let mut attempted = 0usize;
    for archive in archives {
        attempted += 1;
        handle_one(state, inbox, &archive).await;
    }
    attempted
}

async fn handle_one(state: &AppState, inbox: &Path, archive: &Path) {
    // The stable-size wait is blocking (it sleeps) and belongs off the runtime's worker
    // threads: a 20 MB copy over a network mount can hold it for a minute.
    let probe = archive.to_path_buf();
    let stable = tokio::task::spawn_blocking(move || {
        zipcheck::wait_for_stable(&probe, STABLE_WINDOW, STABLE_TIMEOUT)
    })
    .await;

    match stable {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => {
            // Still being written, or gone. Either way: leave it and look again next poll.
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
        // Not a user: a drop has no session, and `system` is what the audit log should say.
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

/// Move the archive out of the scan path, so the next poll does not retry it forever.
///
/// Nothing is deleted, on purpose: a rejected package is the only copy of the evidence, and
/// an operator who dropped the wrong file wants it back rather than gone.
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
    // A timestamp prefix rather than an overwrite: two attempts at the same filename are
    // two pieces of evidence, and the second is usually the interesting one.
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

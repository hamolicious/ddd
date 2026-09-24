//! Serializing installs (SPEC §6.2: "installs are serialized through a Mongo-locked
//! queue; partial installs roll back").
//!
//! # Why a lock at all on a single-replica server
//!
//! Two admins uploading at once, or an upload racing the directory watcher, is enough:
//! the pipeline ends in a rename into `PLUGINS_DIR` and a registry reload, and two of
//! those interleaving can leave a half-renamed version being served. An in-process mutex
//! would cover that — the lock is in **Mongo** as well because it survives a crash with a
//! visible holder and a TTL, so a process killed mid-install leaves evidence rather than a
//! silently stuck directory, and because HA is the named v2 seam (SPEC §8).
//!
//! The lock is the same pattern as the migration advisory lock (`db::migrations`), with
//! its own document so a long install cannot block a boot.
//!
//! # How it is taken, in two writes and no transaction
//!
//! 1. `insert_one` the lock document. Success ⇒ the lock was free and is now ours; a
//!    duplicate-key error ⇒ somebody has it.
//! 2. On the duplicate, `update_one` filtered on `expires_at <= now` — which matches only
//!    an **expired** holder. A match ⇒ we stole a dead install's lock.
//!
//! Both writes are conditional on the state they expect, so two callers racing cannot both
//! believe they won: the insert is atomic on `_id` and the steal is atomic on
//! `expires_at`. There is no read-then-write window anywhere in this file.
//!
//! Every write also carries a per-holder `token` (a ULID), and release and heartbeat
//! filter on it. Without that a heartbeat from a process whose lock had already expired and
//! been stolen would extend *the new holder's* lock, and a `release` would delete it.
//!
//! **Owner:** the `install-flow` builder.

use std::time::Duration;

use tokio::task::JoinHandle;
use tracing::{debug, warn};

use crate::db;
use crate::domain::{Timestamp, new_id};
use crate::state::AppState;

use super::InstallError;

/// `meta` document id holding the install lock.
pub const LOCK_ID: &str = "plugin_install_lock";
/// How long a holder's claim stays valid without a heartbeat. Long enough for a 50 MB
/// extraction on slow storage, short enough that a crashed install does not block the next
/// one for an hour.
pub const LOCK_TTL: Duration = Duration::from_secs(120);
/// Heartbeat interval while an install runs.
pub const LOCK_HEARTBEAT: Duration = Duration::from_secs(30);
/// How long a caller waits for the lock before giving up with [`InstallError::Locked`].
pub const LOCK_WAIT: Duration = Duration::from_secs(5);
/// How often a waiting caller retries.
const RETRY_INTERVAL: Duration = Duration::from_millis(200);

/// A held lock. Released on [`InstallLock::release`]; a dropped guard leaves the TTL to
/// expire, which is the correct behaviour for a panicking install.
pub struct InstallLock {
    state: AppState,
    holder: String,
    token: String,
    heartbeat: Option<JoinHandle<()>>,
}

impl InstallLock {
    /// Who is holding it, as the admin screen shows it.
    pub fn holder(&self) -> &str {
        &self.holder
    }

    /// Give the lock up immediately.
    pub async fn release(mut self) {
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.abort();
        }
        let filter = bson::doc! { "_id": LOCK_ID, "token": &self.token };
        match self
            .state
            .collections
            .raw(db::META)
            .delete_one(filter)
            .await
        {
            Ok(result) if result.deleted_count == 0 => {
                // Our claim had already expired and somebody else took it. Nothing to do,
                // and nothing to undo — but worth a line: it means an install ran longer
                // than `LOCK_TTL` without a heartbeat landing.
                warn!(
                    holder = %self.holder,
                    "the plugin install lock was no longer ours at release"
                );
            }
            Ok(_) => debug!(holder = %self.holder, "plugin install lock released"),
            Err(err) => warn!(error = %err, "could not release the plugin install lock"),
        }
    }
}

impl Drop for InstallLock {
    fn drop(&mut self) {
        // A panicking install leaves the TTL to expire rather than releasing a lock whose
        // directory state nobody has checked. Stopping the heartbeat is what makes that
        // expiry actually happen.
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.abort();
        }
    }
}

/// Take the lock, waiting up to [`LOCK_WAIT`].
pub async fn acquire(state: &AppState, holder: &str) -> Result<InstallLock, InstallError> {
    let deadline = tokio::time::Instant::now() + LOCK_WAIT;
    let token = new_id();
    let meta = state.collections.raw(db::META);

    loop {
        let now = Timestamp::now();
        let expires = expiry(now, LOCK_TTL);
        let claim = bson::doc! {
            "_id": LOCK_ID,
            "holder": holder,
            "token": &token,
            "acquired_at": now.to_bson(),
            "expires_at": expires.to_bson(),
        };

        match meta.insert_one(&claim).await {
            Ok(_) => return Ok(held(state, holder, token)),
            Err(err) if crate::auth::is_duplicate_key(&err) => {
                // Somebody holds it. Steal it only if their claim has expired — the filter
                // is the whole safety argument, so it is never relaxed.
                let stolen = meta
                    .update_one(
                        bson::doc! { "_id": LOCK_ID, "expires_at": { "$lte": now.to_bson() } },
                        bson::doc! { "$set": {
                            "holder": holder,
                            "token": &token,
                            "acquired_at": now.to_bson(),
                            "expires_at": expires.to_bson(),
                        } },
                    )
                    .await?;
                if stolen.matched_count == 1 {
                    warn!(
                        holder = %holder,
                        "took over an expired plugin install lock — a previous install did not finish"
                    );
                    return Ok(held(state, holder, token));
                }
            }
            Err(err) => return Err(InstallError::Db(err)),
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(InstallError::Locked);
        }
        tokio::time::sleep(RETRY_INTERVAL).await;
    }
}

/// Run `body` under the lock. The only way the pipeline should take it — a lock released
/// on every path, including the error ones.
pub async fn with_lock<F, T>(state: &AppState, holder: &str, body: F) -> Result<T, InstallError>
where
    F: AsyncFnOnce() -> Result<T, InstallError>,
{
    let lock = acquire(state, holder).await?;
    let outcome = body().await;
    lock.release().await;
    outcome
}

/// Who holds the lock right now, for the admin screen and for a boot-time log line.
pub async fn holder(state: &AppState) -> Result<Option<String>, InstallError> {
    let found = state
        .collections
        .raw(db::META)
        .find_one(bson::doc! { "_id": LOCK_ID })
        .await?;
    let Some(document) = found else {
        return Ok(None);
    };
    // An expired document is not a holder: reporting one would make every crashed install
    // look like a permanently stuck queue in the admin screen.
    let expired = document
        .get_datetime("expires_at")
        .map(|expires| expires.timestamp_millis() <= Timestamp::now().timestamp_millis())
        .unwrap_or(true);
    if expired {
        return Ok(None);
    }
    Ok(document
        .get_str("holder")
        .ok()
        .map(|holder| holder.to_string()))
}

fn held(state: &AppState, holder: &str, token: String) -> InstallLock {
    let heartbeat = spawn_heartbeat(state.clone(), token.clone());
    InstallLock {
        state: state.clone(),
        holder: holder.to_string(),
        token,
        heartbeat: Some(heartbeat),
    }
}

/// Extend our own claim while the install runs. Filtered on the token, so it can only ever
/// extend *this* lock.
fn spawn_heartbeat(state: AppState, token: String) -> JoinHandle<()> {
    tokio::spawn(async move {
        let collection = state.collections.raw(db::META);
        loop {
            tokio::time::sleep(LOCK_HEARTBEAT).await;
            let expires = expiry(Timestamp::now(), LOCK_TTL);
            let result = collection
                .update_one(
                    bson::doc! { "_id": LOCK_ID, "token": &token },
                    bson::doc! { "$set": { "expires_at": expires.to_bson() } },
                )
                .await;
            match result {
                Ok(outcome) if outcome.matched_count == 0 => {
                    // The lock is not ours any more. Stop rather than keep writing: the
                    // install that owns it now is not this one.
                    warn!("the plugin install lock expired while an install was running");
                    return;
                }
                Ok(_) => {}
                Err(err) => warn!(error = %err, "plugin install lock heartbeat failed"),
            }
        }
    })
}

fn expiry(from: Timestamp, ttl: Duration) -> Timestamp {
    Timestamp::from_millis(from.timestamp_millis() + ttl.as_millis() as i64)
}

/// A process-wide mutex in front of the Mongo lock.
///
/// Belt and braces for the case the Mongo lock is *worst* at: two requests in **this**
/// process racing. The Mongo lock is conditional and correct, so it cannot be held twice —
/// but a loser waits [`LOCK_WAIT`] and then answers "another install is in progress", which
/// for two clicks of the same admin's mouse is a confusing error rather than a queue. With
/// this, the second click waits on the mutex first and only then contends for the
/// database's lock, which is what "queue" in SPEC §6.2 means to the person clicking.
static IN_PROCESS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// [`with_lock`], plus the in-process queue in front of it.
pub async fn queued<F, T>(state: &AppState, holder: &str, body: F) -> Result<T, InstallError>
where
    F: AsyncFnOnce() -> Result<T, InstallError>,
{
    let _queued = IN_PROCESS.lock().await;
    with_lock(state, holder, body).await
}

/// Is an install in flight in **this** process? What the admin screen's "installing…"
/// state is, without a database round trip.
pub fn busy() -> bool {
    IN_PROCESS.try_lock().is_err()
}

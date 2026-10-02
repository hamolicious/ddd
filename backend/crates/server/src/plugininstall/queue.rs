use std::time::Duration;

use tokio::task::JoinHandle;
use tracing::{debug, warn};

use crate::db;
use crate::domain::{Timestamp, new_id};
use crate::state::AppState;

use super::InstallError;

pub const LOCK_ID: &str = "plugin_install_lock";
pub const LOCK_TTL: Duration = Duration::from_secs(120);
pub const LOCK_HEARTBEAT: Duration = Duration::from_secs(30);
pub const LOCK_WAIT: Duration = Duration::from_secs(5);
const RETRY_INTERVAL: Duration = Duration::from_millis(200);

pub struct InstallLock {
    state: AppState,
    holder: String,
    token: String,
    heartbeat: Option<JoinHandle<()>>,
}

impl InstallLock {
    pub fn holder(&self) -> &str {
        &self.holder
    }

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
        if let Some(heartbeat) = self.heartbeat.take() {
            heartbeat.abort();
        }
    }
}

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

pub async fn with_lock<F, T>(state: &AppState, holder: &str, body: F) -> Result<T, InstallError>
where
    F: AsyncFnOnce() -> Result<T, InstallError>,
{
    let lock = acquire(state, holder).await?;
    let outcome = body().await;
    lock.release().await;
    outcome
}

pub async fn holder(state: &AppState) -> Result<Option<String>, InstallError> {
    let found = state
        .collections
        .raw(db::META)
        .find_one(bson::doc! { "_id": LOCK_ID })
        .await?;
    let Some(document) = found else {
        return Ok(None);
    };
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

static IN_PROCESS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn queued<F, T>(state: &AppState, holder: &str, body: F) -> Result<T, InstallError>
where
    F: AsyncFnOnce() -> Result<T, InstallError>,
{
    let _queued = IN_PROCESS.lock().await;
    with_lock(state, holder, body).await
}

pub fn busy() -> bool {
    IN_PROCESS.try_lock().is_err()
}

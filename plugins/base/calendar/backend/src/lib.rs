//! The **calendar** plugin, backend half — the M4 proof (SPEC §9 M4).
//!
//! What it demonstrates, in the order the spec argues for it:
//!
//! 1. **Cron while nobody's looking.** `backend.cron` fires [`sync`]; there is no client
//!    involved and no user to be logged in.
//! 2. **Outbound HTTP with a configured destination.** The feed URL is admin config, the
//!    host enforces the declared host allowlist and the IP policy.
//! 3. **Machine-owned documents as the sharing mechanism.** One `VEVENT` becomes one
//!    document with `fm.date`; the change feed carries it to every client, offline
//!    included, searchable and linkable — and the frontend half renders a month grid from
//!    `fm.date` without any private channel (SPEC §1).
//!
//! The only per-plugin state that is *not* a document is the sync bookkeeping in KV: an
//! `ETag`, a `Last-Modified`, the last run's summary, and the list of uids a user deleted.
//! High-frequency machine state does not belong in a CRDT (SPEC §3.3).
//!
//! # This crate is glue, and that is the point
//!
//! Every decision worth testing — what a feed says, the exact text of a document, which
//! documents to create, rewrite, cancel or leave alone — lives in `calendar-ics`, a plain
//! crate that compiles and tests on the host target. A wasm plugin crate cannot be
//! unit-tested (it links the Extism host imports), so what is left here is the part that
//! can only be exercised against a real host: read config, make one request, ask
//! [`calendar_ics::plan`] what to do, make one host call per answer, record what happened.
//! Keep it that way. (`backend/HOST-ABI.md` §9.)
//!
//! # The document shape this plugin writes
//!
//! ```markdown
//! ---
//! title: Standup
//! date: 2026-09-24T09:00:00Z
//! date-end: 2026-09-24T09:15:00Z
//! path: calendar/work
//! source: ical
//! source-uid: 2f1c@google.com
//! ---
//!
//! # Standup
//!
//! Daily standup, 15 minutes.
//!
//! %%% calendar
//! feed: work
//! status: confirmed
//! sequence: 3
//! all-day: false
//! %%%
//! ```
//!
//! Frontmatter is the portable half — `date` is what every dated view already queries, and
//! `source`/`source-uid` say where the event came from in text that survives an export. The
//! `%%%` section is this plugin's bookkeeping and the only region a later write touches: a
//! vanished event is marked by splicing `status: cancelled` into it.
//!
//! Owner: the **calendar** builder (`backend/CONTRACTS.md`).

use life_manager_plugin_sdk as lm;

use calendar_ics::{Existing, SOURCE_ICAL, fm_keys, keys, plan};
use lm::abi::JsonMap;
use lm::{ErrorCode, HostError};
use serde_json::{Value, json};

lm::abi_version!();

/// This plugin's id: its `%%%` section, its KV namespace, its `plugin:<id>` actor and the
/// string `created_by` records. One constant, because they are all the same string
/// (SPEC §3.3, §6.3).
pub const PLUGIN_ID: &str = "calendar";

// ---------------------------------------------------------------------------
// Config keys (manifest `config`)
// ---------------------------------------------------------------------------

/// The ICS URL. Required; its host must be in the approved `capabilities.http.hosts`
/// (the manifest ships `[]` and the admin adds the host at approval — see
/// `backend/HOST-ABI.md`, §7.2 "the one capability an admin may widen").
pub const CONFIG_FEED_URL: &str = "feed_url";
/// `fm.path` prefix for imported events; default `calendar`.
pub const CONFIG_FOLDER: &str = "folder";
/// A short feed label, stored in the machine section so two feeds can share a workspace.
pub const CONFIG_FEED_ID: &str = "feed_id";
/// An optional `Authorization` header value, `secret: true` — the reason this half exists
/// at all (SPEC §6.3: outbound HTTP with secrets).
pub const CONFIG_AUTH_HEADER: &str = "auth_header";

/// The default for [`CONFIG_FOLDER`], matching the manifest's declared default.
pub const DEFAULT_FOLDER: &str = "calendar";
/// The default for [`CONFIG_FEED_ID`], matching the manifest's declared default.
pub const DEFAULT_FEED_ID: &str = "default";

/// KV keys. `pub` so the crate's own API is the documentation of what it stores.
pub mod kv_keys {
    /// The feed's `ETag`, for a conditional GET.
    pub const ETAG: &str = "feed.etag";
    /// The feed's `Last-Modified`.
    pub const LAST_MODIFIED: &str = "feed.last_modified";
    /// RFC 3339 of the last successful sync.
    pub const LAST_SYNC: &str = "feed.last_sync";
    /// The last sync's counts, for the admin screen and for `emit_client`.
    pub const LAST_SUMMARY: &str = "feed.last_summary";
    /// Uids a user deleted, so the next sync does not resurrect them.
    pub const SUPPRESSED: &str = "deleted.uids";
}

/// How many of this feed's documents one run will read.
///
/// A number, deliberately: "read the whole workspace" must be a decision with a bound
/// attached (`plugin-sdk`'s `query_all` takes one for the same reason). At 2 000 events a
/// feed is well past what a person reads, and the run would be near its 60 s cron deadline
/// anyway.
///
/// **A truncated read must never become a duplicate.** `plan` emits `Create` for every feed
/// uid it finds no match for, and "no match" from a capped read means *either* "there is no
/// document" *or* "its document was past the cap" — the same answer for two opposite
/// situations. A 2 500-event feed therefore created a second document for ~500 uids whose
/// originals simply had not been read, and since there is no `delete_document` those
/// duplicates were permanent. [`verify_absent`] is what closes that: every `Create` is
/// checked against a one-row targeted query first, so the bulk read is an *optimisation*
/// rather than the thing correctness rests on. That also covers the paging skew — offset
/// paging over a mutable sort key can skip a row, and a skipped row can only ever cause a
/// spurious create.
pub const MAX_EVENT_DOCUMENTS: usize = 2_000;

/// Rows per query page — the ABI's maximum, so the number of round trips is the minimum.
pub const QUERY_PAGE: u32 = 200;

/// How many deleted uids the suppression list remembers.
///
/// Bounded because a KV value is capped at 64 KiB (`backend/HOST-ABI.md` §5) and an
/// unbounded list would eventually fail *every* write, which is a much worse failure than
/// forgetting the oldest deletion. At ~80 bytes per uid this is comfortably inside the cap.
pub const MAX_SUPPRESSED: usize = 500;

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

lm::init!(init);

/// Report what the admin actually approved, once per instance.
///
/// The point is degrading deliberately rather than per call: a plugin whose `http` hosts are
/// still empty is *waiting for an operator*, not broken, and saying so once in the server's
/// log is the difference between a five-minute diagnosis and a support thread.
fn init(payload: lm::InitPayload) -> lm::Result<()> {
    if payload.capabilities.http_hosts.is_empty() {
        lm::log::warn(
            "no approved http hosts: this plugin ships `hosts: []` because it cannot know the \
             operator's feed host when it is packaged. Add the feed URL's host at approval \
             (admin → plugins) — nothing is fetched until you do.",
        );
    }
    if !payload.capabilities.can_write_documents() {
        lm::log::warn("documents:write is not approved: the feed can be read but not imported");
    }
    if !payload.config_keys.iter().any(|key| key == CONFIG_FEED_URL) {
        lm::log::warn("`feed_url` is not configured yet (admin → plugins → config)");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Cron: the whole job
// ---------------------------------------------------------------------------

lm::cron!(sync);

/// Fetch the feed and reconcile it into documents.
///
/// Shape of the run, and why each step is where it is:
///
/// 1. Read config; a missing `feed_url` is `InvalidArgument` with the key named — a plugin
///    waiting to be configured must not look like a broken one (it would otherwise trip
///    the circuit breaker after five cron runs).
/// 2. Conditional GET with the stored `ETag`/`Last-Modified`. A `304` ends the run: no
///    documents touched, no CRDT history written.
/// 3. Parse with [`calendar_ics::parse`]. Problems are logged and counted, never fatal.
/// 4. [`reconcile`] against what is already in the workspace.
/// 5. Store the bookkeeping in KV, `emit_client` a summary.
fn sync(schedule: lm::abi::cron::CronPayload) -> lm::Result<()> {
    lm::log::debug(&format!(
        "cron `{}` (slot {}, missed {}, {} ms budget)",
        schedule.expression, schedule.index, schedule.missed, schedule.deadline_ms
    ));
    // `missed` is deliberately not branched on: this job always does a full reconciliation,
    // so a server that was down for a day catches up in one run with no special case. That
    // is the same property that makes the hook optional rather than load-bearing.
    let summary = run_sync(&schedule.fired_at)?;
    lm::log::info(&summary.describe());
    Ok(())
}

/// The job itself, shared by cron and the `POST /sync` route.
///
/// `now` is RFC 3339 and comes from the host's payload rather than from a clock inside the
/// plugin: a Wasm module has no trustworthy time source, and the one number that must agree
/// with the server's log is the server's own.
pub fn run_sync(now: &str) -> lm::Result<SyncSummary> {
    let feed_url = lm::config::require_string(CONFIG_FEED_URL)?;
    let folder = config_or(CONFIG_FOLDER, DEFAULT_FOLDER)?;
    let feed_id = config_or(CONFIG_FEED_ID, DEFAULT_FEED_ID)?;

    let mut headers = JsonMap::new();
    headers.insert(
        "accept".to_string(),
        Value::String("text/calendar, text/plain;q=0.9, */*;q=0.1".to_string()),
    );
    // Conditional GET: a feed that has not changed costs one 304 and zero writes. Both
    // validators, because publishers implement one or the other.
    if let Some(etag) = lm::kv::get_string(kv_keys::ETAG)? {
        headers.insert("if-none-match".to_string(), Value::String(etag));
    }
    if let Some(modified) = lm::kv::get_string(kv_keys::LAST_MODIFIED)? {
        headers.insert("if-modified-since".to_string(), Value::String(modified));
    }
    // Fetched at the moment it is needed, never logged, never put in an error detail.
    if let Some(auth) = lm::config::string(CONFIG_AUTH_HEADER)? {
        headers.insert("authorization".to_string(), Value::String(auth));
    }

    let response = lm::http::get_with_headers(&feed_url, headers)?;
    if response.status() == 304 {
        lm::log::info("feed unchanged (304): nothing fetched, nothing written");
        lm::kv::set(kv_keys::LAST_SYNC, &now)?;
        let mut summary = last_summary()?.unwrap_or_default();
        summary.at = now.to_string();
        summary.feed = feed_id;
        summary.unchanged_feed = true;
        return Ok(summary);
    }
    let response = response.error_for_status()?;
    let etag = response.header("etag").map(str::to_string);
    let last_modified = response.header("last-modified").map(str::to_string);
    let body = response.text()?;

    let calendar = calendar_ics::parse(&body);
    report_problems(&calendar);

    let feed_name = calendar
        .name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(&feed_id);
    let path = calendar_ics::folder_path(&folder, feed_name);

    let mut summary = reconcile(&feed_id, &path, &calendar.events)?;
    summary.at = now.to_string();
    summary.problems = calendar.problems.len() as u32;
    summary.events = calendar.events.len() as u32;

    // The validators are stored **only** after a clean run. Storing an ETag while writes
    // failed would mean the next run gets a 304 and never retries them — the feed would be
    // "unchanged" forever and the workspace permanently half-synced.
    if summary.failed == 0 {
        store_optional(kv_keys::ETAG, etag)?;
        store_optional(kv_keys::LAST_MODIFIED, last_modified)?;
    } else {
        lm::log::warn(&format!(
            "{} write(s) failed: the feed validators are not stored, so the next run refetches \
             and retries",
            summary.failed
        ));
    }
    lm::kv::set(kv_keys::LAST_SYNC, &now)?;
    lm::kv::set(kv_keys::LAST_SUMMARY, &summary)?;

    // A nudge, not a payload: the documents themselves are already on their way to every
    // client through the change feed (SPEC §1, §6.3).
    if summary.wrote_anything() {
        let _ = lm::events::emit_client("synced", &summary);
    }
    Ok(summary)
}

/// Match parsed events against the documents this plugin already owns, and write the
/// difference.
///
/// The matching key is `fm.source-uid` — a query, not a KV index: a KV index of five
/// thousand uid→id pairs would blow the 64 KB value cap and would be a second source of
/// truth for something the projection already knows. One filtered `query_documents` page
/// per 200 documents is the cost, and it is self-healing after any failure.
///
/// The four outcomes per event, and the three refusals, are [`calendar_ics::plan`]'s — a
/// pure function over fixture states. This function is the half that cannot be tested
/// without a host: it turns each planned action into exactly one host call.
pub fn reconcile(
    feed_id: &str,
    path: &str,
    events: &[calendar_ics::Event],
) -> lm::Result<SyncSummary> {
    let existing = read_existing()?;
    let suppressed = suppressed_uids()?;

    let plan = plan(calendar_ics::plan::Inputs {
        feed_id,
        path,
        events,
        existing: &existing,
        suppressed: &suppressed,
    });

    let mut summary = SyncSummary {
        feed: feed_id.to_string(),
        unchanged: plan.unchanged,
        skipped: plan.suppressed + plan.foreign,
        ..SyncSummary::default()
    };
    if plan.duplicates > 0 {
        lm::log::warn(&format!(
            "{} document(s) share a source-uid with another; the lowest id wins and the rest \
             are left alone",
            plan.duplicates
        ));
    }
    // Remembered *before* the writes: if the run dies half-way, "the user deleted this" is
    // the one fact that must not be lost, because the next run would re-create the event.
    remember_deleted(&plan.newly_suppressed, &suppressed)?;

    for action in &plan.actions {
        let result = match action {
            // `plan` read "absent" off a bounded, offset-paged query; `verify_absent` asks
            // about this one uid directly. A duplicate document is the one mistake this
            // plugin cannot walk back, so the create is the one action worth a second query.
            calendar_ics::plan::Action::Create { uid, text } => {
                if verify_absent(uid) {
                    lm::documents::create(text).map(|_| Wrote::Created)
                } else {
                    lm::log::warn(&format!(
                        "event `{uid}` already has an imported document that this run did not \
                         read; not creating a second one"
                    ));
                    summary.skipped += 1;
                    continue;
                }
            }
            calendar_ics::plan::Action::Rewrite { id, text, .. } => {
                lm::documents::rewrite(id, text).map(|_| Wrote::Updated)
            }
            // One line, not a rewrite: the document may be open in somebody's editor, and a
            // line splice merges where a whole-text write would fight (SPEC §3.3, §11.2).
            calendar_ics::plan::Action::Cancel { id, .. } => {
                lm::documents::set_section(id, keys::STATUS, json!(calendar_ics::STATUS_CANCELLED))
                    .map(|_| Wrote::Cancelled)
            }
        };
        match result {
            Ok(Wrote::Created) => summary.created += 1,
            Ok(Wrote::Updated) => summary.updated += 1,
            Ok(Wrote::Cancelled) => summary.cancelled += 1,
            Err(error) if is_fatal(error.code) => {
                // Out of budget, out of write allowance, or not allowed to write at all.
                // Stopping is the honest answer: the remaining actions would fail the same
                // way, and reconciliation is idempotent, so the next run picks up exactly
                // where this one stopped.
                lm::log::error(&format!(
                    "stopping after {} write(s): {error}",
                    summary.written()
                ));
                return Err(error);
            }
            Err(error) => {
                summary.failed += 1;
                lm::log::warn(&format!("event `{}` not written: {error}", action.uid()));
            }
        }
    }
    Ok(summary)
}

enum Wrote {
    Created,
    Updated,
    Cancelled,
}

/// Which refusals end the run rather than costing one event.
///
/// The split is "would the next action fail the same way?". A deadline, an exhausted write
/// allowance, a missing capability or an unavailable database are all answers about the
/// *run*; a document that is gone, too large or not ours is an answer about one event.
fn is_fatal(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::Timeout
            | ErrorCode::Unavailable
            | ErrorCode::LimitExceeded
            | ErrorCode::CapabilityDenied
            | ErrorCode::Internal
    )
}

/// Render one event as a whole document (frontmatter + body + `%%% calendar`).
///
/// Pure — and it has to be: [`calendar_ics::plan`] decides "unchanged" by comparing this
/// text against what the workspace holds, so a clock read inside it would rewrite every
/// document on every run.
pub fn document_text(feed_id: &str, path: &str, event: &calendar_ics::Event) -> String {
    calendar_ics::document_text(feed_id, path, event)
}

// ---------------------------------------------------------------------------
// Reading the workspace
// ---------------------------------------------------------------------------

/// Every document this feed has ever produced, **trash included**.
///
/// `trash: All` is the interesting part. A tombstoned event must be *recognised*, not
/// skipped: without it the next run would find no live document for that uid and re-create
/// the meeting a user just deleted, which looks exactly like the Trash being broken
/// (`calendar_ics::plan` then records the uid so it survives the 30-day purge).
///
/// The filter is the shared DSL (SPEC §4.2), parsed by the core and compiled to Mongo by the
/// host — a plugin cannot smuggle an operator through it.
///
/// **Not scoped to one feed**, deliberately. A `UID` is globally unique in RFC 5545, so two
/// feeds carrying one event must share one document rather than each creating their own; a
/// feed-scoped query would hide the other's copy and duplicate it on every run. Cancelling
/// *is* feed-scoped, and [`calendar_ics::plan`] is where that asymmetry lives.
fn read_existing() -> lm::Result<Vec<Existing>> {
    // INTEGRATION (wasm-host): `get_document` forces a materialization flush
    // (`backend/HOST-ABI.md` §3.1) but §3.2 says nothing about `query_documents`. If a query
    // can return `content` that trails a write this plugin made moments ago, the
    // "unchanged" comparison below sees a stale text and rewrites one document one extra
    // time — self-healing, never wrong, but worth a line in the ABI doc either way.
    let input = lm::abi::documents::QueryDocumentsInput {
        filter: Some(json!({
            "and": [
                {"cmp": {"field": format!("fm.{}", fm_keys::SOURCE), "op": "eq",
                         "value": {"str": SOURCE_ICAL}}},
                {"exists": {"field": format!("fm.{}", fm_keys::SOURCE_UID)}},
            ]
        })),
        // **By document id, ascending.** `query_documents` pages by offset (`skip`), and an
        // offset over a *mutable* sort key is not a stable enumeration: `-updated_at` is
        // rewritten by this plugin's own syncs and by every human edit, so a row that moves
        // between two pages is read twice or not at all. A ULID is immutable and totally
        // ordered, which makes the only way to skew it a document being inserted or purged
        // mid-read — and `verify_absent` covers what that could otherwise cause.
        sort: vec!["id".to_string()],
        search: None,
        limit: Some(QUERY_PAGE),
        cursor: None,
        trash: lm::abi::documents::TrashScope::All,
        // `content` is wanted: comparing the rendered text against it is what makes an
        // unchanged feed write nothing.
        metadata_only: false,
    };
    let rows = lm::documents::query_all(&input, MAX_EVENT_DOCUMENTS)?;
    if rows.len() == MAX_EVENT_DOCUMENTS {
        // Says what actually happens, not what would be convenient: the documents past the
        // cap are neither updated nor cancelled this run, and a feed event whose document is
        // among them looks absent to `plan` — which is why every create is verified before it
        // is made rather than trusted from this list.
        lm::log::warn(&format!(
            "read the first {MAX_EVENT_DOCUMENTS} imported documents by id; any beyond that \
             are not updated or cancelled this run, and their events are re-checked \
             individually before anything is created"
        ));
    }
    Ok(rows
        .into_iter()
        .map(|row| Existing {
            source_uid: string_at(&row.fm, fm_keys::SOURCE_UID),
            feed: row
                .section_value(PLUGIN_ID, keys::FEED)
                .and_then(Value::as_str)
                .map(str::to_string),
            status: row
                .section_value(PLUGIN_ID, keys::STATUS)
                .and_then(Value::as_str)
                .map(str::to_string),
            // `created_by == "plugin:calendar"` is the machine-ownership record, and the
            // same check the host applies to `rewrite_document` (SPEC §3.3).
            owned: row.is_owned_by(PLUGIN_ID),
            deleted: row.deleted,
            content: row.content.clone(),
            id: row.id,
        })
        .filter(|row| {
            // Another feed's documents are matched (a uid is globally unique) but never
            // cancelled; `plan` enforces that. What is filtered here is only what cannot be
            // reconciled at all.
            row.source_uid.is_some()
        })
        .collect())
}

fn string_at(map: &JsonMap, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Is there really no imported document for this uid?
///
/// The last check before a `Create`, and the reason [`MAX_EVENT_DOCUMENTS`] is a performance
/// bound rather than a correctness one. `plan` decides "absent" from the bulk read, which can
/// be short for two reasons that have nothing to do with the uid — the cap, and offset paging
/// skew — and a wrong "absent" is not a missed update but a *permanent duplicate*: a second
/// document for an event, which no later run can clean up because there is no
/// `delete_document`.
///
/// One row, metadata only, `trash: All` (a tombstoned document counts as present — the same
/// reason [`read_existing`] asks for the trash). Cheap where it matters: steady state has few
/// creates, and the run that has thousands of them is the first import, which is doing
/// thousands of writes anyway.
///
/// A query failure answers "do not create": skipping an event costs one sync cycle, and the
/// next run retries. Creating on a failed check is the outcome that cannot be undone.
fn verify_absent(uid: &str) -> bool {
    let input = lm::abi::documents::QueryDocumentsInput {
        filter: Some(json!({
            "and": [
                {"cmp": {"field": format!("fm.{}", fm_keys::SOURCE), "op": "eq",
                         "value": {"str": SOURCE_ICAL}}},
                {"cmp": {"field": format!("fm.{}", fm_keys::SOURCE_UID), "op": "eq",
                         "value": {"str": uid}}},
            ]
        })),
        sort: vec!["id".to_string()],
        search: None,
        limit: Some(1),
        cursor: None,
        trash: lm::abi::documents::TrashScope::All,
        metadata_only: true,
    };
    match lm::documents::query(&input) {
        Ok(page) => page.documents.is_empty(),
        Err(error) => {
            lm::log::warn(&format!(
                "could not confirm `{uid}` has no document yet ({error}); not creating one this \
                 run"
            ));
            false
        }
    }
}

// ---------------------------------------------------------------------------
// The suppression list
// ---------------------------------------------------------------------------

fn suppressed_uids() -> lm::Result<Vec<String>> {
    Ok(lm::kv::get::<Vec<String>>(kv_keys::SUPPRESSED)?.unwrap_or_default())
}

/// Add uids to the bounded suppression list, oldest first out.
fn remember_deleted(uids: &[String], known: &[String]) -> lm::Result<()> {
    if uids.is_empty() {
        return Ok(());
    }
    let mut list: Vec<String> = known.to_vec();
    for uid in uids {
        if !list.iter().any(|seen| seen == uid) {
            list.push(uid.clone());
        }
    }
    if list.len() > MAX_SUPPRESSED {
        let dropped = list.len() - MAX_SUPPRESSED;
        lm::log::warn(&format!(
            "the deleted-event list is full: forgetting the {dropped} oldest, which may be \
             re-imported if they are still in the feed"
        ));
        list.drain(..dropped);
    }
    lm::kv::set(kv_keys::SUPPRESSED, &list)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Inbound routes: the manual "sync now" button in the frontend half
// ---------------------------------------------------------------------------

// INTEGRATION (agenda-admin, install-flow): this plugin is unusable until an admin *widens*
// `capabilities.http.hosts` with the feed URL's host at approval — the one widening an
// approval may make (`backend/HOST-ABI.md` §7.2). The approval screen therefore needs an
// editable hosts field, not just a read-only capability list; without it the package's
// `"hosts": []` is final and every sync answers `capability_denied`.
lm::http_routes!(route);

/// `POST /api/plugins/calendar/sync` — run the job now.
/// `GET /api/plugins/calendar/status` — what the last run did.
///
/// Both are session-authenticated (neither is in `capabilities.public-routes`), which is
/// what makes the first one safe for a frontend button: a "refresh" anyone on the internet
/// could trigger is a free outbound-request amplifier.
///
/// **Known cost of the manual path:** a route invocation gets the 5 s per-call deadline, not
/// cron's 60 s (`backend/HOST-ABI.md` §5). On a feed large enough to need more, the button
/// answers `timeout` and the scheduled run — which has the bigger budget and is idempotent —
/// finishes the job.
fn route(request: lm::abi::http::HttpRouteRequest) -> lm::Result<lm::abi::http::HttpRouteResponse> {
    if request.user.is_none() {
        // Belt and braces: the host already refuses an unauthenticated call to a route that
        // is not declared public, and this plugin declares none.
        return Err(HostError::new(
            ErrorCode::Forbidden,
            "this route needs a signed-in user",
        ));
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/sync") => {
            let summary = run_sync(&now_from(&request))?;
            Ok(lm::abi::http::HttpRouteResponse::json(
                200,
                &serde_json::to_value(&summary).unwrap_or(Value::Null),
            ))
        }
        ("GET", "/status") => {
            let configured = lm::config::string(CONFIG_FEED_URL)?.is_some();
            let body = json!({
                "configured": configured,
                "feed": lm::config::string(CONFIG_FEED_ID)?.unwrap_or_else(|| DEFAULT_FEED_ID.to_string()),
                "last_sync": lm::kv::get_string(kv_keys::LAST_SYNC)?,
                "last_summary": last_summary()?,
                "suppressed": suppressed_uids()?.len(),
            });
            Ok(lm::abi::http::HttpRouteResponse::json(200, &body))
        }
        (method, path) => Err(HostError::new(
            ErrorCode::NotFound,
            format!("calendar has no route `{method} {path}`"),
        )),
    }
}

/// The run timestamp for a manual sync.
///
/// A route payload has no `fired_at`, and a Wasm module has no clock; the request id is the
/// one identifier that ties the summary to a line in the server's log, so it stands in until
/// a caller needs a real stamp (the next cron run overwrites it with one).
fn now_from(request: &lm::abi::http::HttpRouteRequest) -> String {
    format!("request:{}", request.request_id)
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

lm::hook_document_deleted!(on_deleted);

/// A user trashing an imported event means "I do not want this one back".
///
/// Without this the next sync would re-create it, and the user would learn that the Trash
/// does not work. The uid goes on the KV suppression list instead.
///
/// The hook is a *shortcut*, not the mechanism: `document.deleted` is at-most-once and
/// carries no document (`backend/HOST-ABI.md` §4.2), so this handler re-reads the row to
/// find the uid, and a delivery that never arrives is caught anyway by the next run's
/// `trash: All` query. Belt and braces, because at-most-once plus "the Trash looks broken"
/// is a bad combination.
fn on_deleted(event: lm::abi::hooks::DocumentEvent) -> lm::Result<()> {
    if event.origin.is_plugin(PLUGIN_ID) {
        // The host does not deliver a plugin its own changes, so this is unreachable — and
        // it is here because "a sync that deletes and then suppresses its own events" is the
        // one loop that would be invisible in the counts.
        return Ok(());
    }
    // A tombstoned document is still readable (SPEC §3.5), which is what makes this work at
    // all: the row is in Trash, not gone.
    let document = match lm::documents::get_metadata(&event.id) {
        Ok(document) => document,
        Err(error)
            if matches!(
                error.code,
                ErrorCode::NotFound | ErrorCode::Gone | ErrorCode::CapabilityDenied
            ) =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    };
    if !document.is_owned_by(PLUGIN_ID) {
        return Ok(());
    }
    let Some(uid) = string_at(&document.fm, fm_keys::SOURCE_UID) else {
        return Ok(());
    };
    let known = suppressed_uids()?;
    if known.iter().any(|seen| seen == &uid) {
        return Ok(());
    }
    remember_deleted(std::slice::from_ref(&uid), &known)?;
    lm::log::info(&format!(
        "`{uid}` was deleted by a user; it will not be re-imported"
    ));
    Ok(())
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/// What one run did. Stored in KV, answered by `GET /status`, and sent to clients as
/// `plugin:calendar:synced`.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SyncSummary {
    pub created: u32,
    pub updated: u32,
    pub unchanged: u32,
    pub cancelled: u32,
    /// Events the sync deliberately left alone: a user deleted them, or the matching
    /// document belongs to a human rather than to this plugin.
    #[serde(default)]
    pub skipped: u32,
    /// Writes the host refused, one event each. The feed validators are not stored when this
    /// is non-zero, so the next run retries.
    #[serde(default)]
    pub failed: u32,
    /// Lines and events the parser could not use.
    #[serde(default)]
    pub problems: u32,
    /// Events the feed contained.
    #[serde(default)]
    pub events: u32,
    /// The feed label these counts are about.
    #[serde(default)]
    pub feed: String,
    /// `true` when the feed answered `304` and these counts are the previous run's.
    #[serde(default)]
    pub unchanged_feed: bool,
    /// RFC 3339 of this run, from the host's cron payload — or `request:<id>` for a manual
    /// sync, because a route invocation carries no clock and a Wasm module has none of its
    /// own. Either way it ties the summary to a line in the server's log.
    pub at: String,
}

impl SyncSummary {
    /// Documents this run wrote.
    pub fn written(&self) -> u32 {
        self.created + self.updated + self.cancelled
    }

    pub fn wrote_anything(&self) -> bool {
        self.written() > 0
    }

    /// One log line, in the order an operator asks the questions.
    pub fn describe(&self) -> String {
        format!(
            "feed `{}`: {} event(s) → {} created, {} updated, {} cancelled, {} unchanged, \
             {} skipped, {} failed, {} parse problem(s)",
            self.feed,
            self.events,
            self.created,
            self.updated,
            self.cancelled,
            self.unchanged,
            self.skipped,
            self.failed,
            self.problems
        )
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// One config string, or the manifest's declared default.
///
/// A blank value counts as unset: an admin who cleared a field means "use the default", and
/// an empty `fm.path` prefix would put imported events at the workspace root.
fn config_or(key: &str, fallback: &str) -> lm::Result<String> {
    Ok(lm::config::string(key)?
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string()))
}

fn last_summary() -> lm::Result<Option<SyncSummary>> {
    lm::kv::get::<SyncSummary>(kv_keys::LAST_SUMMARY)
}

fn store_optional(key: &str, value: Option<String>) -> lm::Result<()> {
    match value {
        Some(value) => {
            lm::kv::set(key, &value)?;
        }
        // Removed rather than left stale: a publisher that stopped sending an ETag would
        // otherwise be sent a validator it no longer honours, and a wrong 304 is a feed that
        // never updates again.
        None => {
            lm::kv::remove(key)?;
        }
    }
    Ok(())
}

/// Log what the parser could not use — a few examples, then a count.
///
/// Bounded on purpose: a feed with three hundred malformed events is one operator problem,
/// not three hundred log lines, and the ABI rate-limits a plugin to 100 log lines per
/// invocation anyway (`backend/HOST-ABI.md` §3.12).
fn report_problems(calendar: &calendar_ics::Calendar) {
    const SHOWN: usize = 5;
    for problem in calendar.problems.iter().take(SHOWN) {
        lm::log::warn(&format!("feed line {}: {}", problem.line, problem.message));
    }
    if calendar.problems.len() > SHOWN {
        lm::log::warn(&format!(
            "... and {} more feed problem(s)",
            calendar.problems.len() - SHOWN
        ));
    }
}

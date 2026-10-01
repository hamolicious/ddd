//! The host functions a backend plugin imports — the whole of what a plugin can do
//! (SPEC §6.3), and the capability checks that gate them (SPEC §6.2).
//!
//! `backend/HOST-ABI.md` is the contract; [`life_manager_plugin_abi`] is its type form.
//! This module is the implementation and the enforcement point, and it is the file to read
//! if you want to know what a plugin can reach.
//!
//! # Every function has the same shape
//!
//! One `i64` in (an Extism memory handle holding UTF-8 JSON), one `i64` out (the same,
//! holding an [`abi::Envelope`]). That uniformity is not decoration:
//!
//! - **A refusal is a value, not a trap.** SPEC §6.2 requires undeclared capabilities to
//!   be linked as *erroring stubs* so instantiation never fails on imports and optional
//!   use is expressible. A trap would poison the instance and lose the call.
//! - **One serializer, one size cap, one log line** per host call, instead of fourteen
//!   near-identical ones.
//!
//! # Capability gating, in one table
//!
//! | Function | Capability |
//! |---|---|
//! | `get_document`, `query_documents`, `query` | `documents: ["read"]` |
//! | `create_document`, `splice_section`, `rewrite_document` | `documents: ["write"]` |
//! | `http_request` | `http.hosts` contains the URL's host |
//! | `kv_get`, `kv_set`, `config_get`, `emit`, `emit_client`, `call_plugin`, `log` | none |
//!
//! The ungated set is deliberate. KV, config and cron are the "cron-and-KV plugin"
//! SPEC §6.3 names as the archetype, and requiring a capability for a plugin's *own*
//! namespace would be theatre. `call_plugin` is gated by the manifest's `dependencies` and the
//! callee's `backend.exports` instead, and
//! `emit_client` reaches only sessions of this workspace's users.
//!
//! The check lives in each **body**, never in the registration: all fourteen imports are
//! linked into every instance whatever an admin approved, because SPEC §6.2 requires an
//! undeclared one to be an *erroring stub* rather than a missing import.
//!
//! # Synchronous host, asynchronous server
//!
//! Extism host functions are synchronous; Mongo is not. Each context carries a
//! [`tokio::runtime::Handle`] and host functions do their async work through
//! `handle.block_on(...)`. **The rule that keeps this safe:** a plugin call always runs on
//! a [`tokio::task::spawn_blocking`] thread, never on a runtime worker, so blocking here
//! cannot starve the reactor — and nothing inside a host function may wait on a task that
//! needs *this* thread to make progress (there is no such task today, and the reason to
//! keep it that way is written here).
//!
//! `call_plugin` is the one place that comes close, because the callee wants a blocking
//! thread too. It is safe because `spawn_blocking` grows its pool on demand: the nested
//! call gets a *different* thread, and the depth cap of three bounds how many are stacked.
//! What would break the rule is `block_in_place`, a blocking pool sized to the depth, or a
//! lock this thread holds while a nested call needs it.
//!
//! # Where the per-call context comes from
//!
//! Not from a closure capture. The functions are registered on the *compiled module*,
//! which four concurrent instances share, so a captured context would hand every later
//! call the first one's deadline. It travels through Extism's per-call channel instead
//! ([`extism::Plugin::call_with_host_context`] →
//! [`extism::CurrentPlugin::host_context`]), which is also why [`functions`] takes no
//! arguments.
//!
//! **Owner:** the `wasm-host` builder. Two bodies inside it — [`emit`] and [`emit_client`]
//! — belong to the `hooks-cron` builder (`backend/CONTRACTS.md`); the shared validation
//! they need is [`check_event`].

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use extism::{CurrentPlugin, Function, UserData, Val, ValType};
use life_manager_core as core;
use life_manager_plugin_abi as abi;
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::limits::{CallCounters, Deadline, PluginLimits, WriteLedger};
use super::{ActivePlugin, CallKind};
use crate::docstore::DocStoreError;
use crate::state::AppState;

/// Everything a host function needs to answer, for one invocation.
///
/// Built per call (not per instance) because half of it — the deadline, the counters, the
/// user — belongs to the call. The instance is reused; the context is not.
pub struct HostContext {
    pub state: AppState,
    pub plugin: Arc<ActivePlugin>,
    pub kind: CallKind,
    pub limits: PluginLimits,
    pub deadline: Deadline,
    /// Depth of this invocation in a `call_plugin` chain (0 = top level).
    pub depth: u32,
    /// Plugin ids already on the stack, for the reentrancy check.
    pub stack: Vec<String>,
    /// The user behind the chain, if any.
    pub user_id: Option<String>,
    pub counters: CallCounters,
    pub write_ledger: Arc<WriteLedger>,
    /// How host functions reach the async world. See the module docs.
    pub runtime: tokio::runtime::Handle,
}

impl HostContext {
    /// `true` when the plugin may read documents.
    pub fn can_read(&self) -> bool {
        self.plugin.capabilities.can_read_documents()
    }

    /// `true` when the plugin may write documents.
    pub fn can_write(&self) -> bool {
        self.plugin.capabilities.can_write_documents()
    }

    /// The actor every write of this call is attributed to: `plugin:<id>`.
    pub fn actor(&self) -> crate::domain::Actor {
        self.plugin.actor()
    }

    /// Run one async operation on the server's runtime, from this synchronous thread.
    fn block_on<F: std::future::Future>(&self, future: F) -> F::Output {
        self.runtime.block_on(future)
    }

    /// Count a document write against both caps: the per-invocation one, then the
    /// per-(plugin, document) sliding window (SPEC §6.3's loop backstop).
    fn charge_write(&self, document_id: &str) -> Result<(), abi::HostError> {
        self.counters.record_write(self.limits.writes_per_call)?;
        self.write_ledger.record(&self.plugin.id, document_id)
    }
}

/// The fourteen host functions.
///
/// **All of them are always registered**, including the ones whose capability is missing:
/// those refuse in the body with [`abi::ErrorCode::CapabilityDenied`]. Registering only the
/// approved ones would make instantiation fail on the import (SPEC §6.2 forbids exactly
/// that) — and a plugin could not then probe for an optional capability.
pub fn functions() -> Vec<Function> {
    let mut functions = Vec::with_capacity(abi::names::HOST_FUNCTIONS.len());

    macro_rules! host_fn {
        ($name:expr, $body:path) => {
            let (params, results) = signature();
            functions.push(
                Function::new(
                    $name,
                    params,
                    results,
                    UserData::new(()),
                    move |plugin, inputs, outputs, _user| {
                        dispatch(plugin, inputs, outputs, $name, $body)
                    },
                )
                .with_namespace(super::HOST_NAMESPACE),
            );
        };
    }

    host_fn!(abi::names::GET_DOCUMENT, get_document);
    host_fn!(abi::names::QUERY_DOCUMENTS, query_documents);
    host_fn!(abi::names::QUERY, query);
    host_fn!(abi::names::CREATE_DOCUMENT, create_document);
    host_fn!(abi::names::SPLICE_SECTION, splice_section);
    host_fn!(abi::names::REWRITE_DOCUMENT, rewrite_document);
    host_fn!(abi::names::KV_GET, kv_get);
    host_fn!(abi::names::KV_SET, kv_set);
    host_fn!(abi::names::CONFIG_GET, config_get);
    host_fn!(abi::names::EMIT, emit);
    host_fn!(abi::names::EMIT_CLIENT, emit_client);
    host_fn!(abi::names::CALL_PLUGIN, call_plugin);
    host_fn!(abi::names::HTTP_REQUEST, http_request);
    host_fn!(abi::names::LOG, log);

    debug_assert_eq!(
        functions.len(),
        abi::names::HOST_FUNCTIONS.len(),
        "every name in abi::names::HOST_FUNCTIONS must be registered"
    );
    functions
}

/// The wrapper every host function body goes through: read the handle, enforce the input
/// cap, deserialize, check the deadline, run, serialize the envelope, write the handle.
///
/// Refusals never reach Extism as errors. The `Result` in the signature is for the two
/// cases that genuinely cannot be reported in-band — a memory handle the host cannot read
/// or allocate — which are host bugs and *should* trap.
pub fn dispatch<I, O, F>(
    plugin: &mut CurrentPlugin,
    inputs: &[Val],
    outputs: &mut [Val],
    name: &'static str,
    body: F,
) -> Result<(), extism::Error>
where
    I: DeserializeOwned,
    O: Serialize,
    F: FnOnce(&HostContext, I) -> Result<O, abi::HostError>,
{
    // Cloned out first, before anything else borrows `plugin`.
    let context: Arc<HostContext> = match plugin.host_context::<Arc<HostContext>>() {
        Ok(context) => Arc::clone(context),
        Err(err) => {
            // Reachable only when an export runs without a context, which is exactly what
            // `PluginPool::probe_abi_version` does — deliberately, so the ABI check cannot
            // reach a host function. Answering rather than trapping keeps that honest.
            return write_envelope(
                plugin,
                outputs,
                &abi::Envelope::<()>::err(abi::HostError::new(
                    abi::ErrorCode::Internal,
                    format!("`{name}` was called outside an invocation: {err}"),
                )),
            );
        }
    };

    let raw: String = plugin.memory_get_val(&inputs[0])?;
    let envelope = run_body(&context, name, raw, body);
    write_envelope(plugin, outputs, &envelope)
}

/// The in/out path with no Extism in it, so `dispatch` stays about memory handles and the
/// caps below are readable in one screen.
///
/// A **panic** in a body becomes `internal`. That is not defensive decoration: a panic here
/// unwinds through Wasmtime's stack, and the friendliest thing that can happen is a
/// poisoned instance with the reason lost. Catching it keeps the reason in the server's log
/// and turns a host bug into one call's failure.
fn run_body<I, O, F>(
    context: &HostContext,
    name: &'static str,
    raw: String,
    body: F,
) -> abi::Envelope<O>
where
    I: DeserializeOwned,
    O: Serialize,
    F: FnOnce(&HostContext, I) -> Result<O, abi::HostError>,
{
    if raw.len() > abi::limits::MAX_HOST_INPUT_BYTES {
        return abi::Envelope::err(
            abi::HostError::new(
                abi::ErrorCode::TooLarge,
                format!(
                    "`{name}` was handed {} bytes of JSON, over the {} byte cap",
                    raw.len(),
                    abi::limits::MAX_HOST_INPUT_BYTES
                ),
            )
            .with_detail(serde_json::json!({ "limit": abi::limits::MAX_HOST_INPUT_BYTES })),
        );
    }

    let input: I = match serde_json::from_str(&raw) {
        Ok(input) => input,
        Err(err) => {
            return abi::Envelope::err(abi::HostError::new(
                abi::ErrorCode::InvalidArgument,
                format!("`{name}` did not receive the JSON it expects: {err}"),
            ));
        }
    };

    // Checked here rather than in each body: an invocation whose budget is gone must not
    // start a write, and one place to enforce that is one place to get right
    // (HOST-ABI.md §5).
    if context.deadline.expired() {
        return abi::Envelope::err(abi::HostError::new(
            abi::ErrorCode::Timeout,
            format!("this invocation's deadline passed before `{name}` could run"),
        ));
    }

    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(context, input))) {
        Ok(Ok(value)) => abi::Envelope::ok(value),
        Ok(Err(error)) => {
            tracing::debug!(
                plugin = %context.plugin.id, host_fn = name,
                code = error.code.as_str(), message = %error.message,
                "plugin host: host function refused"
            );
            abi::Envelope::err(error)
        }
        Err(panic) => {
            tracing::error!(
                plugin = %context.plugin.id, host_fn = name, panic = %panic_message(&panic),
                "plugin host: a host function panicked"
            );
            // The plugin is told nothing about server internals (SPEC §8: 5xx detail is
            // never leaked); the reason is in the log with the plugin id beside it.
            abi::Envelope::err(abi::HostError::new(
                abi::ErrorCode::Internal,
                format!("`{name}` failed inside the host"),
            ))
        }
    }
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = panic.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = panic.downcast_ref::<String>() {
        message.clone()
    } else {
        "a panic with no message".to_string()
    }
}

/// Serialize an envelope into plugin memory, enforcing the output cap.
fn write_envelope<O: Serialize>(
    plugin: &mut CurrentPlugin,
    outputs: &mut [Val],
    envelope: &abi::Envelope<O>,
) -> Result<(), extism::Error> {
    let json = match serde_json::to_string(envelope) {
        Ok(json) if json.len() <= abi::limits::MAX_HOST_OUTPUT_BYTES => json,
        Ok(json) => {
            // Never a truncated answer: half an ICS feed makes confidently wrong documents
            // (HOST-ABI.md §2.3).
            let bytes = json.len();
            serde_json::to_string(&abi::Envelope::<()>::err(
                abi::HostError::new(
                    abi::ErrorCode::TooLarge,
                    format!(
                        "the answer is {bytes} bytes, over the {} byte cap; ask for fewer rows \
                         or set metadata_only",
                        abi::limits::MAX_HOST_OUTPUT_BYTES
                    ),
                )
                .with_detail(serde_json::json!({ "bytes": bytes })),
            ))
            .expect("a static envelope serializes")
        }
        Err(err) => serde_json::to_string(&abi::Envelope::<()>::err(abi::HostError::new(
            abi::ErrorCode::Internal,
            format!("the host's own answer would not serialize: {err}"),
        )))
        .expect("a static envelope serializes"),
    };
    let handle = plugin.memory_new(json)?;
    outputs[0] = plugin.memory_to_val(handle);
    Ok(())
}

/// The body every ungranted capability gets.
///
/// Every gated function refuses inline (see [`require_read`] and friends); this is the same
/// refusal as a standalone, so "what does a plugin see when it calls something it may not"
/// has one answer to read.
pub fn erroring_stub(
    plugin: &mut CurrentPlugin,
    outputs: &mut [Val],
    capability: &str,
) -> Result<(), extism::Error> {
    write_envelope(
        plugin,
        outputs,
        &abi::Envelope::<()>::err(abi::HostError::capability_denied(capability)),
    )
}

/// The Extism signature every one of these functions has: `(i64) -> i64`.
pub fn signature() -> ([ValType; 1], [ValType; 1]) {
    ([ValType::I64], [ValType::I64])
}

/// `UserData` wrapper, so the closures can be `Fn` and still see the context.
///
/// Empty in practice: the per-call context arrives through Extism's own host-context
/// channel instead (see the module docs). Kept as the named type because "where does the
/// context come from" is the first question anyone asks of this file.
pub type Context = UserData<()>;

/// `documents: ["read"]`, or the refusal.
fn require_read(context: &HostContext) -> Result<(), abi::HostError> {
    if context.can_read() {
        Ok(())
    } else {
        Err(abi::HostError::capability_denied("documents:read"))
    }
}

/// `documents: ["write"]`, or the refusal.
fn require_write(context: &HostContext) -> Result<(), abi::HostError> {
    if context.can_write() {
        Ok(())
    } else {
        Err(abi::HostError::capability_denied("documents:write"))
    }
}

fn invalid(message: impl Into<String>) -> abi::HostError {
    abi::HostError::new(abi::ErrorCode::InvalidArgument, message.into())
}

/// Validate a document id before it reaches Mongo. A ULID, or `invalid_argument`.
fn document_id(raw: &str) -> Result<&str, abi::HostError> {
    if crate::domain::is_valid_id(raw) {
        Ok(raw)
    } else {
        Err(invalid(format!("`{raw}` is not a document id")))
    }
}

/// One mapping from the storage layer's errors to the ABI's codes, so every document host
/// function reports the same thing for the same cause.
fn map_docstore_error(error: DocStoreError) -> abi::HostError {
    match error {
        DocStoreError::NotFound(id) => {
            abi::HostError::new(abi::ErrorCode::NotFound, format!("no document {id}"))
        }
        DocStoreError::AlreadyExists(id) => abi::HostError::new(
            abi::ErrorCode::AlreadyExists,
            format!("document {id} already exists"),
        ),
        DocStoreError::Graveyarded(id) => abi::HostError::new(
            abi::ErrorCode::Gone,
            format!("document {id} was permanently deleted and can never come back"),
        ),
        DocStoreError::TooLarge { len, limit } => abi::HostError::new(
            abi::ErrorCode::TooLarge,
            format!("the document text is {len} bytes, the limit is {limit}"),
        )
        .with_detail(serde_json::json!({ "len": len, "limit": limit })),
        DocStoreError::InvalidId(id) => invalid(format!("`{id}` is not a document id")),
        DocStoreError::MalformedUpdate(message) => invalid(message),
        // A lost optimistic-concurrency race is transient and retryable, which is what
        // `unavailable` means to a plugin. It also counts on the breaker, and that is
        // right: a plugin that keeps losing the race is hammering one document.
        DocStoreError::Contended(id) => abi::HostError::new(
            abi::ErrorCode::Unavailable,
            format!("document {id} is being written by someone else; retry"),
        ),
        DocStoreError::SnapshotNotFound(id) => {
            abi::HostError::new(abi::ErrorCode::NotFound, format!("no snapshot {id}"))
        }
        DocStoreError::HistoryGap(id, seq) => abi::HostError::new(
            abi::ErrorCode::NotFound,
            format!("the history of {id} cannot be rebuilt at seq {seq}"),
        ),
        // The caller's own message: a section edit the fence grammar cannot hold.
        DocStoreError::SpliceRefused(message) => invalid(message),
        // Never the database's own message: it can carry a connection string.
        DocStoreError::Db(err) => {
            tracing::warn!(error = %err, "plugin host: a document operation failed in Mongo");
            abi::HostError::new(
                abi::ErrorCode::Unavailable,
                "the document store is unavailable",
            )
        }
        DocStoreError::Bson(message) => {
            tracing::warn!(%message, "plugin host: a document operation failed to encode");
            abi::HostError::new(
                abi::ErrorCode::Internal,
                "the document could not be encoded",
            )
        }
        DocStoreError::Other(err) => {
            tracing::warn!(error = %err, "plugin host: a document operation failed");
            abi::HostError::new(abi::ErrorCode::Internal, "the document operation failed")
        }
    }
}

/// `fm` / `plugins` as the ABI carries them: the shared core's value model as plain JSON,
/// never extended JSON (HOST-ABI.md §2.4).
fn bson_map_to_json(document: &bson::Document) -> abi::JsonMap {
    core::value::map_from_bson(document)
        .into_iter()
        .map(|(key, value)| (key, value.to_json()))
        .collect()
}

fn timestamp(at: bson::DateTime) -> String {
    crate::domain::Timestamp::from(at).to_rfc3339()
}

/// A stored [`crate::domain::Document`] as the ABI's [`abi::documents::DocumentValue`].
fn document_value(
    document: &crate::domain::Document,
    metadata_only: bool,
) -> abi::documents::DocumentValue {
    abi::documents::DocumentValue {
        id: document.id.clone(),
        title: document.title.clone(),
        content: (!metadata_only).then(|| document.content.clone()),
        fm: bson_map_to_json(&document.fm),
        plugins: bson_map_to_json(&document.plugins),
        fm_parse_error: document.fm_parse_error,
        materialized_version: document.materialized_version.clone(),
        created_at: timestamp(document.created_at),
        created_by: document.created_by.clone(),
        updated_at: timestamp(document.updated_at),
        updated_by: document.updated_by.clone(),
        deleted: document.deleted_at.is_some(),
    }
}

/// The same, for a projection row — what a query returns.
fn row_value(
    row: &crate::domain::DocumentRow,
    metadata_only: bool,
) -> abi::documents::DocumentValue {
    abi::documents::DocumentValue {
        id: row.id.clone(),
        title: row.title.clone(),
        content: (!metadata_only).then(|| row.content.clone()),
        fm: bson_map_to_json(&row.fm),
        plugins: bson_map_to_json(&row.plugins),
        fm_parse_error: row.fm_parse_error,
        materialized_version: row.materialized_version.clone(),
        created_at: timestamp(row.created_at),
        created_by: row.created_by.clone(),
        updated_at: timestamp(row.updated_at),
        updated_by: row.updated_by.clone(),
        deleted: row.deleted_at.is_some(),
    }
}

// ---------------------------------------------------------------------------
// documents — `documents: ["read"]` / `["write"]`
// ---------------------------------------------------------------------------

/// `get_document` — one document by id.
///
/// Forces a materialization flush for read-your-writes (SPEC §3.5), so a plugin that
/// splices and re-reads inside one call sees its own edit.
pub fn get_document(
    context: &HostContext,
    input: abi::documents::GetDocumentInput,
) -> Result<abi::documents::GetDocumentOutput, abi::HostError> {
    require_read(context)?;
    let id = document_id(&input.id)?;

    let document = context
        .block_on(async {
            // `get`, not `get_stale`: the flush *is* the read-your-writes rule, and a plugin
            // that splices and re-reads inside one invocation is the case it exists for.
            match context.state.docs.get(id).await {
                Ok(document) => Ok(document),
                Err(DocStoreError::NotFound(missing)) => {
                    // A purged id is `gone`, not `not_found` — the difference tells a plugin
                    // whether a retry could ever work (HOST-ABI.md §3.1).
                    match context.state.docs.is_graveyarded(&missing).await {
                        Ok(true) => Err(DocStoreError::Graveyarded(missing)),
                        _ => Err(DocStoreError::NotFound(missing)),
                    }
                }
                Err(other) => Err(other),
            }
        })
        .map_err(map_docstore_error)?;

    Ok(abi::documents::GetDocumentOutput {
        document: document_value(&document, input.metadata_only),
    })
}

/// `query_documents` — the filter DSL, search and sort, answered by the query engine
/// (`query_index.rs`), the same one the REST list and the browser run.
///
/// The DSL is parsed by `core::filter`, never handed to Mongo as client JSON — the same
/// rule the REST list route follows, and the reason a plugin cannot smuggle a `$where`.
pub fn query_documents(
    context: &HostContext,
    input: abi::documents::QueryDocumentsInput,
) -> Result<abi::documents::QueryDocumentsOutput, abi::HostError> {
    require_read(context)?;

    let filter = match input.filter.as_ref() {
        None | Some(serde_json::Value::Null) => None,
        Some(json) => Some(
            core::filter::ast::Filter::from_json(json)
                .map_err(|err| invalid(format!("the filter is not valid: {err}")))?,
        ),
    };
    let sort = input
        .sort
        .iter()
        .map(|token| {
            core::query::Sort::parse(token)
                .map_err(|err| invalid(format!("`{token}` is not a sort key: {err}")))
        })
        .collect::<Result<Vec<_>, _>>()?;

    let plan = core::query::Plan {
        text: input
            .search
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .to_string(),
        filter,
        sort,
        trash: trash_of(input.trash),
        // **Clamped, not refused** (HOST-ABI.md §3.2): paging is the caller's job, and a
        // plugin that asks for 10 000 rows gets 200 and a cursor rather than an error it has
        // to learn about.
        limit: Some(
            input
                .limit
                .unwrap_or(abi::limits::DEFAULT_QUERY_LIMIT)
                .clamp(1, abi::limits::MAX_QUERY_LIMIT),
        ),
        cursor: input.cursor.clone(),
        snippets: false,
        offset: None,
    };
    let found = run_plan(context, &plan, input.metadata_only)?;
    Ok(abi::documents::QueryDocumentsOutput {
        documents: found
            .rows
            .iter()
            .map(|row| row_value(row, input.metadata_only))
            .collect(),
        next_cursor: found.page.next_cursor,
    })
}

/// `query` — a query plan (`core::query::Plan`), as the SDK's `Query` builder writes it.
pub fn query(
    context: &HostContext,
    input: abi::documents::QueryInput,
) -> Result<abi::documents::QueryOutput, abi::HostError> {
    require_read(context)?;
    let mut plan = core::query::Plan::from_json(&input.plan)
        .map_err(|err| invalid(format!("the query is not valid: {err}")))?;
    // The same ceiling `query_documents` clamps to.
    plan.limit = Some(
        plan.limit
            .unwrap_or(abi::limits::DEFAULT_QUERY_LIMIT)
            .clamp(1, abi::limits::MAX_QUERY_LIMIT),
    );
    let found = run_plan(context, &plan, input.metadata_only)?;
    Ok(abi::documents::QueryOutput {
        documents: found
            .rows
            .iter()
            .map(|row| row_value(row, input.metadata_only))
            .collect(),
        total: found.page.total as u64,
        next_cursor: found.page.next_cursor,
        hits: found
            .page
            .hits
            .into_iter()
            .map(|(id, hit)| (id, serde_json::to_value(hit).unwrap_or_default()))
            .collect(),
    })
}

fn trash_of(scope: abi::documents::TrashScope) -> core::query::Trash {
    match scope {
        abi::documents::TrashScope::Live => core::query::Trash::Live,
        abi::documents::TrashScope::Trashed => core::query::Trash::Trashed,
        abi::documents::TrashScope::All => core::query::Trash::All,
    }
}

fn run_plan(
    context: &HostContext,
    plan: &core::query::Plan,
    metadata_only: bool,
) -> Result<crate::query_index::RowPage, abi::HostError> {
    context
        .block_on(context.state.query.rows(plan, !metadata_only))
        .map_err(|err| match err {
            crate::query_index::QueryIndexError::Query(err) => invalid(err.to_string()),
            other => abi::HostError::new(abi::ErrorCode::Internal, other.to_string()),
        })
}

/// `create_document` — a machine-owned document.
///
/// `created_by` is `plugin:<id>`, and **that is the ownership record** `rewrite_document`
/// checks later (SPEC §3.3). No new column, no second source of truth: the existing
/// [`crate::domain::Actor`] already says who created a row.
pub fn create_document(
    context: &HostContext,
    input: abi::documents::CreateDocumentInput,
) -> Result<abi::documents::WriteDocumentOutput, abi::HostError> {
    require_write(context)?;

    if input.text.len() > abi::limits::MAX_DOCUMENT_BYTES {
        return Err(abi::HostError::new(
            abi::ErrorCode::TooLarge,
            format!(
                "the document text is {} bytes, the limit is {}",
                input.text.len(),
                abi::limits::MAX_DOCUMENT_BYTES
            ),
        ));
    }
    let id = match input.id.as_deref() {
        None => None,
        Some(raw) => Some(document_id(raw)?.to_string()),
    };

    // The per-call cap is charged before the write. The per-document window needs an id, so
    // it only applies when the plugin supplied one — a create is the first write to a
    // document that did not exist, so the window can never be the thing that refuses it.
    context
        .counters
        .record_write(context.limits.writes_per_call)?;
    if let Some(id) = id.as_deref() {
        context.write_ledger.record(&context.plugin.id, id)?;
    }

    let actor = context.actor();
    let outcome = context
        .block_on(context.state.docs.create(id, &input.text, &actor))
        .map_err(map_docstore_error)?;

    Ok(abi::documents::WriteDocumentOutput {
        id: outcome.id,
        title: outcome.title,
        materialized_version: outcome.materialized_version,
        changed: true,
    })
}

/// `splice_section` — line splices into the **caller's own** `%%%` section.
///
/// Implemented with `core::splice::splice_section`, whose plugin id comes from the
/// context and never from the payload. That is the whole boundary: one plugin's machine
/// data cannot be written by another, and the line-splice form is what makes concurrent
/// writes merge per key instead of clobbering (SPEC §3.3, §11.2).
///
/// # Why everything happens inside one [`DocStore::splice`] closure
///
/// Every decision here — which requested keys actually differ from what is stored, and where
/// this plugin's fence sits — is a function of the document's text, and the result is a set of
/// **byte-offset spans**. Reading the text in one critical section and applying spans derived
/// from it in another was a silent corruption: a concurrent CRDT write in between shifted
/// every offset, and nothing downstream could tell, because `edit_deltas` checks bounds and
/// character boundaries, not whether a span still holds the line it was computed from. The
/// observed shape was a `status: cancelled` line spliced over the tail of a user's prose —
/// well past what SPEC §11.2 accepts, which is losing one machine value, never user text.
///
/// So the text is never read out here. The closure below runs once, with the room lock held,
/// and reports back through `decision` what it decided to do.
pub fn splice_section(
    context: &HostContext,
    input: abi::documents::SpliceSectionInput,
) -> Result<abi::documents::SpliceSectionOutput, abi::HostError> {
    require_write(context)?;
    let id = document_id(&input.id)?.to_string();

    if input.edits.len() > abi::limits::MAX_SECTION_EDITS {
        return Err(abi::HostError::new(
            abi::ErrorCode::LimitExceeded,
            format!(
                "{} section edits in one call, the limit is {}",
                input.edits.len(),
                abi::limits::MAX_SECTION_EDITS
            ),
        ));
    }
    if input.edits.is_empty() {
        return Err(invalid("`edits` is empty"));
    }

    let requested = section_edits(&input.edits)?;
    let plugin_id = context.plugin.id.clone();

    /// What the closure decided, read back after the write returns.
    #[derive(Default)]
    struct Decision {
        /// How many of the requested keys actually differed and were written.
        edits_applied: u32,
        /// A typed refusal the closure could not return itself (it may only answer with a
        /// message): the per-call / per-document write caps.
        refusal: Option<abi::HostError>,
        /// The text the closure was shown, for the `changed: false` answer's fingerprint.
        seen: Option<String>,
    }
    let decision = std::sync::Mutex::new(Decision::default());

    let compute = |text: &str| -> Result<Vec<core::splice::TextEdit>, String> {
        let mut decision = decision.lock().expect("splice decision lock poisoned");
        decision.seen = Some(text.to_string());

        // Drop the edits that would write what is already there. That is what makes an
        // idempotent sync produce no CRDT history at all (HOST-ABI.md §3.4) — the
        // alternative is a calendar rewriting every event every morning, and an update log
        // that grows forever for no change anybody made.
        let current = core::sections::parse(text);
        let existing = current.get(&plugin_id).map(|section| &section.map);
        let changing: Vec<core::splice::SectionLineEdit> = requested
            .iter()
            .filter(|edit| {
                let present = existing.and_then(|map| map.get(&edit.key));
                match (&edit.value, present) {
                    // Removing a key that is not there changes nothing.
                    (None, None) => false,
                    (None, Some(_)) => true,
                    (Some(wanted), Some(found)) => wanted != found,
                    (Some(_), None) => true,
                }
            })
            .cloned()
            .collect();
        if changing.is_empty() {
            return Ok(Vec::new());
        }

        let edits = core::splice::splice_section(text, &plugin_id, &changing)
            .map_err(|err| format!("the section edit is not representable: {err}"))?;
        if edits.is_empty() {
            return Ok(Vec::new());
        }

        // Charged here rather than before the call, so a splice that turns out to be a no-op
        // costs nothing against the per-document write cap. A refusal is carried out rather
        // than thrown: the closure's error channel is a plain message, and a `LimitExceeded`
        // must not arrive as `invalid_argument`.
        if let Err(err) = context.charge_write(&id) {
            decision.refusal = Some(err);
            return Ok(Vec::new());
        }

        decision.edits_applied = u32::try_from(changing.len()).unwrap_or(u32::MAX);
        Ok(edits)
    };

    let actor = context.actor();
    let outcome = context
        .block_on(context.state.docs.splice(&id, &compute, &actor))
        .map_err(map_docstore_error)?;

    let decision = decision
        .into_inner()
        .expect("splice decision lock poisoned");
    if let Some(refusal) = decision.refusal {
        return Err(refusal);
    }
    if decision.edits_applied == 0 {
        return Ok(abi::documents::SpliceSectionOutput {
            id,
            materialized_version: decision
                .seen
                .as_deref()
                .map(core::document::content_fingerprint)
                .unwrap_or(outcome.materialized_version),
            edits_applied: 0,
            changed: false,
        });
    }

    Ok(abi::documents::SpliceSectionOutput {
        id: outcome.id,
        materialized_version: outcome.materialized_version,
        edits_applied: decision.edits_applied,
        changed: !outcome.update.is_empty(),
    })
}

/// Turn the ABI's [`abi::documents::SectionEdit`]s into the shared core's line edits.
///
/// Every refusal is `invalid_argument`, and each is a mistake a plugin author makes once: a
/// key the fence grammar cannot hold, a nested value (a `%%%` section is one key per line —
/// SPEC §3.3), and an edit that says neither "write this" nor "remove it".
fn section_edits(
    edits: &[abi::documents::SectionEdit],
) -> Result<Vec<core::splice::SectionLineEdit>, abi::HostError> {
    edits
        .iter()
        .map(|edit| {
            if !core::limits::is_valid_key(&edit.key) {
                return Err(invalid(format!(
                    "`{}` is not a section key (`^[A-Za-z0-9_-]{{1,64}}$`)",
                    edit.key
                )));
            }
            if edit.remove {
                if edit.value.is_some() {
                    return Err(invalid(format!(
                        "the edit for `{}` sets both `value` and `remove`",
                        edit.key
                    )));
                }
                return Ok(core::splice::SectionLineEdit {
                    key: edit.key.clone(),
                    value: None,
                });
            }
            let Some(json) = edit.value.as_ref() else {
                return Err(invalid(format!(
                    "the edit for `{}` has no `value` and is not a `remove`",
                    edit.key
                )));
            };
            let value = core::value::Value::from_json(json);
            let nested = match &value {
                core::value::Value::Map(_) => true,
                core::value::Value::List(items) => items.iter().any(|item| {
                    matches!(
                        item,
                        core::value::Value::Map(_) | core::value::Value::List(_)
                    )
                }),
                _ => false,
            };
            if nested {
                return Err(invalid(format!(
                    "`{}` is nested; a `%%%` section is one key per line, so only scalars and \
                     flat flow sequences fit",
                    edit.key
                )));
            }
            Ok(core::splice::SectionLineEdit {
                key: edit.key.clone(),
                value: Some(value),
            })
        })
        .collect()
}

/// `rewrite_document` — the whole text, for a document the caller created.
pub fn rewrite_document(
    context: &HostContext,
    input: abi::documents::RewriteDocumentInput,
) -> Result<abi::documents::WriteDocumentOutput, abi::HostError> {
    require_write(context)?;
    let id = document_id(&input.id)?.to_string();

    if input.text.len() > abi::limits::MAX_DOCUMENT_BYTES {
        return Err(abi::HostError::new(
            abi::ErrorCode::TooLarge,
            format!(
                "the document text is {} bytes, the limit is {}",
                input.text.len(),
                abi::limits::MAX_DOCUMENT_BYTES
            ),
        ));
    }

    let owner = format!("plugin:{}", context.plugin.id);
    context.block_on(async move {
        // `get_stale` deliberately: the ownership check reads `created_by`, which
        // materialization never changes, so forcing a flush here would cost a write for
        // nothing.
        let existing = context
            .state
            .docs
            .get_stale(&id)
            .await
            .map_err(map_docstore_error)?;
        if existing.created_by.as_deref() != Some(owner.as_str()) {
            return Err(abi::HostError::new(
                abi::ErrorCode::Forbidden,
                format!(
                    "document {id} was not created by `{}`; only its creator may rewrite it \
                     wholesale (SPEC §3.3)",
                    context.plugin.id
                ),
            )
            .with_detail(serde_json::json!({ "created_by": existing.created_by })));
        }

        context.charge_write(&id)?;
        let actor = context.actor();
        let outcome = context
            .state
            .docs
            .replace_text(&id, &input.text, &actor)
            .await
            .map_err(map_docstore_error)?;

        Ok(abi::documents::WriteDocumentOutput {
            id: outcome.id,
            title: outcome.title,
            materialized_version: outcome.materialized_version,
            changed: !outcome.update.is_empty(),
        })
    })
}

// ---------------------------------------------------------------------------
// kv / config — ungated, plugin-scoped
// ---------------------------------------------------------------------------

/// `_id` for a KV row: `<plugin_id>:<key>`.
///
/// The namespace is **structural**, not a filter someone has to remember: there is no query
/// a plugin could ask that reaches another plugin's keys, because the key it names is only
/// ever half of the id — and `:` is not in the key charset, so it cannot forge the rest.
fn kv_id(plugin_id: &str, key: &str) -> String {
    format!("{plugin_id}:{key}")
}

/// `^[A-Za-z0-9._:-]{1,256}$` (HOST-ABI.md §3.6).
fn valid_kv_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= abi::limits::MAX_KV_KEY_BYTES
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn check_kv_key(key: &str) -> Result<(), abi::HostError> {
    if valid_kv_key(key) {
        Ok(())
    } else {
        Err(invalid(format!(
            "`{key}` is not a KV key (`^[A-Za-z0-9._:-]{{1,{}}}$`)",
            abi::limits::MAX_KV_KEY_BYTES
        )))
    }
}

fn map_mongo_error(err: mongodb::error::Error) -> abi::HostError {
    tracing::warn!(error = %err, "plugin host: a Mongo operation failed");
    abi::HostError::new(abi::ErrorCode::Unavailable, "the database is unavailable")
}

/// `kv_get` — `plugin_kv`, namespaced by the calling plugin.
pub fn kv_get(
    context: &HostContext,
    input: abi::kv::KvGetInput,
) -> Result<abi::kv::KvGetOutput, abi::HostError> {
    check_kv_key(&input.key)?;
    let collection = context.state.collections.raw(crate::db::PLUGIN_KV);
    let id = kv_id(&context.plugin.id, &input.key);

    let found = context
        .block_on(async { collection.find_one(bson::doc! { "_id": &id }).await })
        .map_err(map_mongo_error)?;

    let value = match found.and_then(|row| row.get("value").cloned()) {
        None => None,
        Some(stored) => Some(bson::from_bson::<serde_json::Value>(stored).map_err(|err| {
            tracing::warn!(
                plugin = %context.plugin.id, key = %input.key, error = %err,
                "plugin host: a stored KV value could not be decoded"
            );
            abi::HostError::new(
                abi::ErrorCode::Internal,
                format!("the stored value for `{}` could not be decoded", input.key),
            )
        })?),
    };

    Ok(abi::kv::KvGetOutput {
        found: value.is_some(),
        key: input.key,
        value,
    })
}

/// `kv_set` — write or delete, with the value/key/count caps.
pub fn kv_set(
    context: &HostContext,
    input: abi::kv::KvSetInput,
) -> Result<abi::kv::KvSetOutput, abi::HostError> {
    check_kv_key(&input.key)?;
    let collection = context.state.collections.raw(crate::db::PLUGIN_KV);
    let id = kv_id(&context.plugin.id, &input.key);
    let plugin_id = context.plugin.id.clone();

    if input.remove {
        return context.block_on(async {
            let deleted = collection
                .delete_one(bson::doc! { "_id": &id })
                .await
                .map_err(map_mongo_error)?;
            let keys = count_kv_keys(context, &collection).await?;
            Ok(abi::kv::KvSetOutput {
                key: input.key,
                existed: deleted.deleted_count > 0,
                keys,
            })
        });
    }

    let value = input.value.clone().unwrap_or(serde_json::Value::Null);
    let encoded = serde_json::to_string(&value).map_err(|err| invalid(err.to_string()))?;
    if encoded.len() > abi::limits::MAX_KV_VALUE_BYTES {
        return Err(abi::HostError::new(
            abi::ErrorCode::TooLarge,
            format!(
                "the value for `{}` is {} bytes, the limit is {}",
                input.key,
                encoded.len(),
                abi::limits::MAX_KV_VALUE_BYTES
            ),
        ));
    }
    let stored = bson::to_bson(&value).map_err(|err| invalid(err.to_string()))?;

    context.block_on(async {
        let existed = collection
            .find_one(bson::doc! { "_id": &id })
            .await
            .map_err(map_mongo_error)?
            .is_some();

        // The key-count budget is checked only for a **new** key: overwriting one a plugin
        // already owns cannot grow the namespace, and refusing it would strand a plugin at
        // its limit with no way to correct a value.
        if !existed {
            let keys = count_kv_keys(context, &collection).await?;
            if keys >= abi::limits::MAX_KV_KEYS_PER_PLUGIN {
                return Err(abi::HostError::new(
                    abi::ErrorCode::LimitExceeded,
                    format!(
                        "`{plugin_id}` already has {keys} KV keys, the limit is {}",
                        abi::limits::MAX_KV_KEYS_PER_PLUGIN
                    ),
                )
                .with_detail(serde_json::json!({ "limit": abi::limits::MAX_KV_KEYS_PER_PLUGIN })));
            }
        }

        collection
            .update_one(
                bson::doc! { "_id": &id },
                bson::doc! { "$set": {
                    "plugin_id": &plugin_id,
                    "key": &input.key,
                    "value": stored,
                    "updated_at": bson::DateTime::now(),
                } },
            )
            .upsert(true)
            .await
            .map_err(map_mongo_error)?;

        let keys = count_kv_keys(context, &collection).await?;
        Ok(abi::kv::KvSetOutput {
            key: input.key,
            existed,
            keys,
        })
    })
}

async fn count_kv_keys(
    context: &HostContext,
    collection: &mongodb::Collection<bson::Document>,
) -> Result<u32, abi::HostError> {
    let count = collection
        .count_documents(bson::doc! { "plugin_id": &context.plugin.id })
        .await
        .map_err(map_mongo_error)?;
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}

/// `config_get` — admin config, **secrets decrypted** (SPEC §6.2).
///
/// Never logged, never echoed into an error `detail`. The decryption lives in
/// [`crate::plugininstall::config`]; this function is only the gate and the shape.
pub fn config_get(
    context: &HostContext,
    input: abi::config::ConfigGetInput,
) -> Result<abi::config::ConfigGetOutput, abi::HostError> {
    if let Some(key) = input.key.as_deref() {
        // A key the manifest never declared is a plugin bug, and saying so beats returning
        // an empty map that reads as "the admin has not set it yet".
        if !context.plugin.config.contains_key(key) {
            return Err(invalid(format!(
                "`{key}` is not a config key this plugin's manifest declares"
            )));
        }
    }

    context
        .block_on(crate::plugininstall::config::for_plugin(
            &context.state,
            &context.plugin.id,
            &context.plugin.config,
            input.key.as_deref(),
        ))
        .map_err(|err| {
            // The install layer's message never contains a value — the whole point of
            // pulling secrets rather than pushing them — but it is kept to the log anyway.
            tracing::warn!(
                plugin = %context.plugin.id, error = %err,
                "plugin host: could not read plugin config"
            );
            abi::HostError::new(
                abi::ErrorCode::Unavailable,
                "the plugin configuration could not be read",
            )
        })
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/// The name and payload caps both event functions share.
///
/// Here rather than in each body because the caps are the ABI's (`abi::limits`), and an
/// event refused for its size must be refused identically whichever bus it was aimed at.
///
/// The name may not contain `:`. The host owns that separator — it is what prefixes
/// `<plugin-id>:` — so a plugin that could type one could spell a name that reads as
/// another plugin's event.
pub fn check_event(event: &str, payload: &serde_json::Value) -> Result<(), abi::HostError> {
    if event.is_empty() || event.len() > abi::limits::MAX_EVENT_NAME_BYTES {
        return Err(invalid(format!(
            "an event name must be 1..={} bytes",
            abi::limits::MAX_EVENT_NAME_BYTES
        )));
    }
    if !event
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(invalid(format!(
            "`{event}` is not an event name (`^[A-Za-z0-9._-]+$`); the host adds the \
             `<plugin-id>:` prefix"
        )));
    }
    let encoded = serde_json::to_string(payload).map_err(|err| invalid(err.to_string()))?;
    if encoded.len() > abi::limits::MAX_EVENT_PAYLOAD_BYTES {
        return Err(abi::HostError::new(
            abi::ErrorCode::TooLarge,
            format!(
                "the event payload is {} bytes, the limit is {}",
                encoded.len(),
                abi::limits::MAX_EVENT_PAYLOAD_BYTES
            ),
        ));
    }
    Ok(())
}

/// `emit` — the server-side bus. Namespaced `<plugin-id>:<event>`, never delivered back to
/// the emitter, fan-out is a nested invocation (depth and deadline apply).
///
/// Validate with [`check_event`] first.
pub fn emit(
    context: &HostContext,
    input: abi::events::EmitInput,
) -> Result<abi::events::EmitOutput, abi::HostError> {
    // Implemented in `super::hooks` — the hooks-cron builder's file — so that the one file
    // three areas share carries the registration and not a second implementation. It calls
    // [`check_event`] first, as this doc comment requires.
    super::hooks::emit_to_plugins(context, input)
}

/// `emit_client` — relayed to browsers over the sync socket as
/// `plugin:<id>:<event>` (PROTOCOL.md §9's forward-compatible unknown `t`).
///
/// Ephemeral by construction: a socket whose queue is full drops it, and nothing is
/// replayed to a client that reconnects. State belongs in documents (SPEC §1).
///
/// Validate with [`check_event`] first.
pub fn emit_client(
    context: &HostContext,
    input: abi::events::EmitClientInput,
) -> Result<abi::events::EmitClientOutput, abi::HostError> {
    // See `emit` above: the body lives in `super::hooks`, next to the sync-hub relay and
    // the hook dispatcher it shares its rules with.
    super::hooks::emit_to_clients(context, input)
}

// ---------------------------------------------------------------------------
// call_plugin
// ---------------------------------------------------------------------------

/// `call_plugin` — invoke a dependency's `lm_call` (HOST-ABI.md §3.10).
///
/// The refusals, in order:
///
/// - the callee is not in the caller's `dependencies` or `optionalDependencies`, or its
///   version is outside the declared range → `forbidden`;
/// - the function is not in the callee's `backend.exports` → `forbidden`;
/// - the payload does not fit the export's `input` shape → `invalid_argument`;
/// - the callee is already on the stack → `reentrancy`; deeper than
///   [`abi::limits::MAX_CALL_DEPTH`] → `limit_exceeded`;
/// - the returned value does not fit the export's `output` shape → `internal` (the
///   callee broke its own contract; the caller cannot fix it).
///
/// A callee named by an id it only `provides` is reached the same way. The callee shares
/// this invocation's deadline.
pub fn call_plugin(
    context: &HostContext,
    input: abi::call::CallPluginInput,
) -> Result<abi::call::CallPluginOutput, abi::HostError> {
    if input.function.is_empty() {
        return Err(invalid("`function` is empty"));
    }
    let host = super::PluginHost::get(&context.state);
    let callee = host.get_active(&input.plugin).or_else(|| {
        host.active().into_iter().find(|active| {
            active
                .provides
                .as_ref()
                .is_some_and(|(id, _)| id == &input.plugin)
        })
    });
    // With no active callee there is nothing to check its exports against; the dispatch
    // below reports why it is not there (`not_found`, or `unavailable` when disabled).
    check_call(
        &context.plugin,
        callee.as_deref(),
        &input.plugin,
        &input.function,
        &input.payload,
    )?;
    let target = callee
        .as_ref()
        .map_or_else(|| input.plugin.clone(), |callee| callee.id.clone());

    let invocation = super::Invocation {
        plugin_id: context.plugin.id.clone(),
        kind: context.kind.clone(),
        payload: serde_json::Value::Null,
        deadline: context.deadline,
        depth: context.depth,
        stack: context.stack.clone(),
        user_id: context.user_id.clone(),
    }
    .nested(&target, &input.function, input.payload)?;

    let value = context
        .block_on(host.call_typed::<serde_json::Value>(&context.state, invocation))
        .map_err(|failure| match failure {
            // The callee's own refusal is forwarded with **its** code, so a chain reports
            // the real cause instead of "the call failed".
            super::CallFailure::Refused(error) => error,
            super::CallFailure::Host(error) => error.as_host_error(),
        })?
        .unwrap_or(serde_json::Value::Null);

    if let Some(callee) = callee.as_deref() {
        check_output(callee, &input.function, &value)?;
    }
    Ok(abi::call::CallPluginOutput { value })
}

/// Everything about a `call_plugin` that can be refused before dispatch: the dependency,
/// its version, the export and the payload's shape. `callee` is the active plugin the id
/// resolved to (possibly through `provides`), when there is one.
pub fn check_call(
    caller: &super::ActivePlugin,
    callee: Option<&super::ActivePlugin>,
    requested: &str,
    function: &str,
    payload: &serde_json::Value,
) -> Result<(), abi::HostError> {
    // The dependency check comes first: it is the one refusal that is about the caller's
    // *manifest* rather than about this call, so a plugin author should see it first.
    let Some(range) = caller.deps.get(requested) else {
        return Err(abi::HostError::new(
            abi::ErrorCode::Forbidden,
            format!(
                "`{requested}` is not a dependency of `{}`; add it to `dependencies` (or \
                 `optionalDependencies`) in the manifest",
                caller.id
            ),
        )
        .with_detail(serde_json::json!({ "plugin": requested })));
    };
    let Some(callee) = callee else {
        return Ok(());
    };
    // The version the caller's range is about: the stand-in's provided one, when the id
    // is one it provides.
    let version = match callee.provides.as_ref() {
        Some((id, version)) if callee.id != requested && id == requested => version.as_str(),
        _ => callee.version.as_str(),
    };
    if !matches!(crate::plugins::satisfies(version, range), Ok(true)) {
        return Err(abi::HostError::new(
            abi::ErrorCode::Forbidden,
            format!(
                "`{}` depends on `{requested}` {range}, but {version} is active",
                caller.id
            ),
        )
        .with_detail(serde_json::json!({ "plugin": requested, "version": version })));
    }
    let Some(export) = callee.callable.get(function) else {
        return Err(abi::HostError::new(
            abi::ErrorCode::Forbidden,
            format!(
                "`{requested}` does not export `{function}`; only the functions in its \
                 `backend.exports` may be called"
            ),
        )
        .with_detail(serde_json::json!({ "plugin": requested, "function": function })));
    };
    if let Some(shape) = export.input.as_ref() {
        let issues = life_manager_core::shape::validate(payload, shape);
        if !issues.is_empty() {
            return Err(abi::HostError::new(
                abi::ErrorCode::InvalidArgument,
                format!(
                    "the payload for `{requested}`.`{function}` does not fit its input shape: {}",
                    describe_issues(&issues)
                ),
            )
            .with_detail(serde_json::json!({ "issues": issues })));
        }
    }
    Ok(())
}

/// The callee's side of the contract: what it returned fits its `output` shape.
pub fn check_output(
    callee: &super::ActivePlugin,
    function: &str,
    value: &serde_json::Value,
) -> Result<(), abi::HostError> {
    let Some(shape) = callee
        .callable
        .get(function)
        .and_then(|export| export.output.as_ref())
    else {
        return Ok(());
    };
    let issues = life_manager_core::shape::validate(value, shape);
    if issues.is_empty() {
        return Ok(());
    }
    Err(abi::HostError::new(
        abi::ErrorCode::Internal,
        format!(
            "`{}`.`{function}` returned a value that does not fit its output shape: {}",
            callee.id,
            describe_issues(&issues)
        ),
    )
    .with_detail(serde_json::json!({ "issues": issues })))
}

fn describe_issues(issues: &[life_manager_core::shape::Issue]) -> String {
    issues
        .iter()
        .take(5)
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("; ")
}

// ---------------------------------------------------------------------------
// http_request
// ---------------------------------------------------------------------------

/// Headers a plugin may not set on an outbound request: the ones that describe the
/// connection rather than the message, plus `host` — which would otherwise let a request
/// pass the allowlist under one name and arrive under another.
///
/// `authorization` is emphatically **not** here. Outbound HTTP with secrets is the reason
/// backend plugins exist (SPEC §6.3).
const REFUSED_REQUEST_HEADERS: &[&str] = &[
    "host",
    "connection",
    "proxy-connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "content-length",
];

/// Cloud metadata endpoints — AWS/GCP/Azure IMDS, ECS task credentials, Alibaba.
///
/// Refused as addresses **even when an operator has widened the CIDR list**: "let my LAN
/// through" never means "let the instance credentials through", and an operator who allows
/// `169.254.0.0/16` to reach one appliance should not thereby hand a plugin an IAM role.
const METADATA_ADDRESSES: &[IpAddr] = &[
    IpAddr::V4(std::net::Ipv4Addr::new(169, 254, 169, 254)),
    IpAddr::V4(std::net::Ipv4Addr::new(169, 254, 170, 2)),
    IpAddr::V4(std::net::Ipv4Addr::new(100, 100, 100, 200)),
];

/// `http_request` — outbound HTTP, per the declared hosts (SPEC §6.2).
///
/// The order of checks is the security property, so it is spelled out rather than left to
/// the reader:
///
/// 1. capability present at all → else `capability_denied`;
/// 2. URL parses, scheme is `http`/`https`, host is in the **approved** list → else
///    `blocked`;
/// 3. resolve the name (Hickory), check **every** returned address against the IP policy
///    → else `blocked`;
/// 4. dial the *pinned* address (`reqwest`'s `resolve_to_addrs`) so the name cannot be
///    re-resolved to something else after the check;
/// 5. each redirect hop repeats 2–4;
/// 6. timeout = `min(request, PLUGIN_HTTP_TIMEOUT_MS, deadline remaining)`;
/// 7. response over the cap → `too_large`, **never** a truncated body.
pub fn http_request(
    context: &HostContext,
    input: abi::http::HttpRequestInput,
) -> Result<abi::http::HttpResponseOutput, abi::HostError> {
    let approved = &context.plugin.capabilities.http_hosts;
    if approved.is_empty() {
        return Err(abi::HostError::capability_denied("http"));
    }

    let method = reqwest::Method::from_bytes(input.method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|_| invalid(format!("`{}` is not an HTTP method", input.method)))?;

    if input.headers.len() > abi::limits::MAX_HTTP_REQUEST_HEADERS {
        return Err(abi::HostError::new(
            abi::ErrorCode::LimitExceeded,
            format!(
                "{} request headers, the limit is {}",
                input.headers.len(),
                abi::limits::MAX_HTTP_REQUEST_HEADERS
            ),
        ));
    }
    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in &input.headers {
        let lower = name.to_ascii_lowercase();
        if REFUSED_REQUEST_HEADERS.contains(&lower.as_str()) {
            return Err(invalid(format!(
                "`{name}` describes the connection, not the request, and the host sets it"
            )));
        }
        let Some(value) = value.as_str() else {
            return Err(invalid(format!("header `{name}` is not a string")));
        };
        if name.len() + value.len() > abi::limits::MAX_HTTP_HEADER_BYTES {
            return Err(abi::HostError::new(
                abi::ErrorCode::TooLarge,
                format!(
                    "header `{name}` is over the {} byte cap",
                    abi::limits::MAX_HTTP_HEADER_BYTES
                ),
            ));
        }
        let header_name = reqwest::header::HeaderName::from_bytes(lower.as_bytes())
            .map_err(|_| invalid(format!("`{name}` is not a header name")))?;
        let header_value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|_| invalid(format!("the value of `{name}` is not a legal header value")))?;
        headers.insert(header_name, header_value);
    }

    let body = match input.body_base64.as_deref() {
        None => None,
        Some(encoded) => {
            let bytes = BASE64
                .decode(encoded)
                .map_err(|err| invalid(format!("`body_base64` is not base64: {err}")))?;
            if bytes.len() > abi::limits::MAX_HTTP_REQUEST_BODY_BYTES {
                return Err(abi::HostError::new(
                    abi::ErrorCode::TooLarge,
                    format!(
                        "the request body is {} bytes, the limit is {}",
                        bytes.len(),
                        abi::limits::MAX_HTTP_REQUEST_BODY_BYTES
                    ),
                ));
            }
            Some(bytes)
        }
    };

    // `min(requested, configured, what is left of the invocation)` — a `timeout_ms` may only
    // *lower* the cap, and an outbound request can never outlive the hook that started it
    // (HOST-ABI.md §5).
    let mut timeout = context.deadline.capped(context.limits.http_timeout);
    if let Some(requested) = input.timeout_ms {
        timeout = timeout.min(Duration::from_millis(requested));
    }
    if timeout.is_zero() {
        return Err(abi::HostError::new(
            abi::ErrorCode::Timeout,
            "there is no time left in this invocation for an outbound request",
        ));
    }

    // Counted *and checked*: the wall clock is not a request cap (see
    // `abi::limits::MAX_HTTP_REQUESTS_PER_CALL`).
    context
        .counters
        .record_http(context.limits.http_requests_per_call)?;
    let plugin_id = context.plugin.id.clone();
    let max_response = context.limits.max_http_response_bytes;
    let allow_cidrs = context.state.config.plugin_http_allow_cidrs.clone();
    let approved = approved.clone();
    let follow = input.follow_redirects;
    let url = input.url.clone();

    let outcome = context.block_on(async move {
        fetch(FetchRequest {
            plugin_id: &plugin_id,
            url: &url,
            method,
            headers,
            body,
            timeout,
            follow_redirects: follow,
            approved: &approved,
            allow_cidrs: &allow_cidrs,
            max_response_bytes: max_response,
        })
        .await
    });

    // The `blocked` series is the one worth alerting on: a plugin repeatedly aiming at a
    // refused destination is either misconfigured or probing.
    let label = match &outcome {
        Ok(_) => "ok",
        Err(error) => match error.code {
            abi::ErrorCode::Blocked => "blocked",
            abi::ErrorCode::Timeout => "timeout",
            abi::ErrorCode::TooLarge => "too_large",
            _ => "error",
        },
    };
    metrics::counter!(
        crate::telemetry::names::PLUGIN_HTTP_REQUESTS,
        "plugin" => context.plugin.id.clone(),
        "outcome" => label
    )
    .increment(1);

    outcome
}

/// Everything one outbound attempt needs, so the redirect loop is a loop over this rather
/// than over ten arguments.
struct FetchRequest<'a> {
    plugin_id: &'a str,
    url: &'a str,
    method: reqwest::Method,
    headers: reqwest::header::HeaderMap,
    body: Option<Vec<u8>>,
    timeout: Duration,
    follow_redirects: bool,
    approved: &'a [String],
    allow_cidrs: &'a [ipnet::IpNet],
    max_response_bytes: u64,
}

/// The redirect loop. **Every hop repeats the full check** — scheme, allowlist, resolve, IP
/// policy, pin — because a redirect is a new destination chosen by the server we were
/// talking to, and a check that only runs on the first URL is not a check.
///
/// `reqwest`'s own redirect following is therefore switched off: it would dial the next hop
/// before this code could look at it.
async fn fetch(request: FetchRequest<'_>) -> Result<abi::http::HttpResponseOutput, abi::HostError> {
    let deadline = std::time::Instant::now() + request.timeout;
    let mut url = reqwest::Url::parse(request.url)
        .map_err(|err| invalid(format!("`{}` is not a URL: {err}", request.url)))?;
    let mut hops = 0u32;
    // Replayed verbatim only while the origin is the same one the plugin addressed. See
    // `strip_sensitive_headers`.
    let mut headers = request.headers.clone();
    let mut origin = origin_of(&url);

    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err(abi::HostError::new(
                abi::ErrorCode::Timeout,
                format!("the request to {url} ran out of time"),
            ));
        }

        let (host, port) = check_destination(&url, request.approved)?;
        let addresses = resolve_pinned(&host, port, request.allow_cidrs, remaining).await?;

        let client = reqwest::Client::builder()
            // The pin. The *name* was checked; this is what makes the connection go to the
            // address that was checked rather than to whatever a second lookup returns —
            // the DNS-rebinding window between check and dial.
            .resolve_to_addrs(&host, &addresses)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(remaining)
            .user_agent(concat!("life-manager/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|err| {
                tracing::warn!(
                    plugin = %request.plugin_id, error = %err,
                    "plugin host: the outbound HTTP client could not be built"
                );
                abi::HostError::new(
                    abi::ErrorCode::Internal,
                    "the HTTP client could not be built",
                )
            })?;

        let mut builder = client
            .request(request.method.clone(), url.clone())
            .headers(headers.clone());
        if let Some(body) = request.body.clone() {
            builder = builder.body(body);
        }

        let response = builder.send().await.map_err(|err| {
            if err.is_timeout() {
                abi::HostError::new(
                    abi::ErrorCode::Timeout,
                    format!("the request to {url} timed out"),
                )
            } else {
                // The message names the destination the plugin itself chose, so it leaks
                // nothing about this server.
                abi::HostError::new(
                    abi::ErrorCode::Unavailable,
                    format!("the request to {url} failed: {err}"),
                )
            }
        })?;

        if is_redirect(response.status()) && request.follow_redirects {
            if hops >= abi::limits::MAX_HTTP_REDIRECTS {
                return Err(abi::HostError::new(
                    abi::ErrorCode::Blocked,
                    format!(
                        "more than {} redirects from {}",
                        abi::limits::MAX_HTTP_REDIRECTS,
                        request.url
                    ),
                ));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    abi::HostError::new(
                        abi::ErrorCode::Unavailable,
                        format!("{url} answered {} with no Location", response.status()),
                    )
                })?;
            url = url.join(location).map_err(|err| {
                abi::HostError::new(
                    abi::ErrorCode::Unavailable,
                    format!("{url} redirected to something unparseable: {err}"),
                )
            })?;
            let next = origin_of(&url);
            if next != origin {
                strip_sensitive_headers(request.plugin_id, &mut headers, &origin, &next);
                origin = next;
            }
            hops += 1;
            continue;
        }

        return read_response(response, request.max_response_bytes).await;
    }
}

/// `scheme://host:port` — what "same origin" means for header replay.
fn origin_of(url: &reqwest::Url) -> String {
    format!(
        "{}://{}:{}",
        url.scheme(),
        url.host_str().unwrap_or_default().to_ascii_lowercase(),
        url.port_or_known_default().unwrap_or_default()
    )
}

/// Headers a plugin's request may not carry across an origin boundary.
///
/// `authorization` is deliberately *absent* from [`REFUSED_REQUEST_HEADERS`] — "outbound HTTP
/// with secrets is the reason backend plugins exist" — so it is here instead: a credential the
/// plugin addressed to *one* host must not be handed to another because that host asked for it
/// with a `302`.
///
/// This is the protection `reqwest`'s own redirect policy provides and that switching it off
/// (necessary: every hop has to be re-checked before it is dialled) took away. Being on the
/// approved host list is not consent to receive another host's credential — a plugin approved
/// for its API host plus a CDN could have the first host's sealed `auth_header` redirected
/// straight to the second, and the operator who granted the second host would have no way to
/// know that is what they granted.
const CROSS_ORIGIN_STRIPPED_HEADERS: &[&str] = &["authorization", "cookie", "proxy-authorization"];

fn strip_sensitive_headers(
    plugin_id: &str,
    headers: &mut reqwest::header::HeaderMap,
    from: &str,
    to: &str,
) {
    let mut stripped = Vec::new();
    for name in CROSS_ORIGIN_STRIPPED_HEADERS {
        if headers.remove(*name).is_some() {
            stripped.push(*name);
        }
    }
    if !stripped.is_empty() {
        tracing::debug!(
            plugin = %plugin_id, %from, %to, headers = ?stripped,
            "plugin host: dropped credential headers across a redirect to another origin"
        );
    }
}

/// The status codes that actually mean "go to `Location` instead".
///
/// **Not** `StatusCode::is_redirection()`, which is every 3xx. Two of those are not
/// redirects and carry no `Location`:
///
/// - **304 Not Modified** — the answer to a conditional `GET`, and the entire point of a
///   plugin storing `ETag`/`Last-Modified` between runs. Treating it as a redirect refused
///   every unchanged feed with "answered 304 Not Modified with no Location", so the
///   cheapest, most correct thing a well-behaved plugin can do was the one thing that
///   failed — and only on the *second* sync, once it had a validator to send.
/// - **305 Use Proxy** — deprecated and a redirect-to-a-proxy an outbound policy must not
///   honour.
///
/// 300 Multiple Choices is left out too: with no `Location` there is nothing to follow, and
/// with one the server is offering a choice rather than moving the resource. All three are
/// returned to the plugin as the responses they are.
fn is_redirect(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

/// Scheme and allowlist. Returns the host name and the port to dial.
fn check_destination(
    url: &reqwest::Url,
    approved: &[String],
) -> Result<(String, u16), abi::HostError> {
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(abi::HostError::new(
            abi::ErrorCode::Blocked,
            format!("`{scheme}` is not a scheme a plugin may request; use http or https"),
        ));
    }
    let Some(host) = url.host_str() else {
        return Err(abi::HostError::new(
            abi::ErrorCode::Blocked,
            format!("{url} has no host"),
        ));
    };
    if !host_allowed(host, approved) {
        return Err(abi::HostError::new(
            abi::ErrorCode::Blocked,
            format!(
                "`{host}` is not in this plugin's approved host list; an admin adds a host at \
                 approval time"
            ),
        )
        .with_detail(serde_json::json!({ "host": host })));
    }
    let port = url
        .port_or_known_default()
        .unwrap_or(if scheme == "https" { 443 } else { 80 });
    Ok((host.to_string(), port))
}

/// Resolve the name ourselves and check **every** address before any of them is dialled.
///
/// All of them, not the first: a name that resolves to one public address and one private
/// one is the cheapest way to reach a metadata service, because `connect` would happily try
/// the second when the first refused.
async fn resolve_pinned(
    host: &str,
    port: u16,
    allow_cidrs: &[ipnet::IpNet],
    timeout: Duration,
) -> Result<Vec<std::net::SocketAddr>, abi::HostError> {
    // A literal address needs no resolver — and must still pass the policy.
    if let Ok(literal) = host.parse::<IpAddr>() {
        return if address_allowed(literal, allow_cidrs) {
            Ok(vec![std::net::SocketAddr::new(literal, port)])
        } else {
            Err(blocked_address(host, literal))
        };
    }

    let resolver = hickory_resolver::TokioResolver::builder_tokio()
        .and_then(hickory_resolver::ResolverBuilder::build)
        .map_err(|err| {
            tracing::warn!(error = %err, "plugin host: could not build a DNS resolver");
            abi::HostError::new(abi::ErrorCode::Internal, "DNS is not available")
        })?;

    let lookup = tokio::time::timeout(timeout, resolver.lookup_ip(host))
        .await
        .map_err(|_| {
            abi::HostError::new(
                abi::ErrorCode::Timeout,
                format!("resolving `{host}` ran out of time"),
            )
        })?
        .map_err(|err| {
            abi::HostError::new(
                abi::ErrorCode::Unavailable,
                format!("`{host}` could not be resolved: {err}"),
            )
        })?;

    let mut addresses = Vec::new();
    for address in lookup.iter() {
        if !address_allowed(address, allow_cidrs) {
            return Err(blocked_address(host, address));
        }
        addresses.push(std::net::SocketAddr::new(address, port));
    }
    if addresses.is_empty() {
        return Err(abi::HostError::new(
            abi::ErrorCode::Unavailable,
            format!("`{host}` resolved to no addresses"),
        ));
    }
    Ok(addresses)
}

fn blocked_address(host: &str, address: IpAddr) -> abi::HostError {
    abi::HostError::new(
        abi::ErrorCode::Blocked,
        format!(
            "`{host}` resolves to {address}, which the host's IP policy refuses; an operator \
             may allow a specific range with PLUGIN_HTTP_ALLOW_CIDRS"
        ),
    )
    .with_detail(serde_json::json!({ "host": host, "address": address.to_string() }))
}

/// Read a body under the cap, and **never** truncate.
///
/// Streamed chunk by chunk rather than through `bytes()`, which would buffer a 4 GB answer
/// before anyone could complain about it. `content-length` is checked first as a courtesy;
/// the streamed count is the one that is enforced, because a `content-length` is a claim and
/// not a fact.
async fn read_response(
    mut response: reqwest::Response,
    max_bytes: u64,
) -> Result<abi::http::HttpResponseOutput, abi::HostError> {
    let status = response.status().as_u16();
    let final_url = response.url().to_string();

    if let Some(claimed) = response.content_length()
        && claimed > max_bytes
    {
        return Err(too_large(claimed, max_bytes));
    }

    let mut headers = abi::JsonMap::new();
    for (name, value) in response.headers() {
        // A plugin does not run a cookie jar, so the header it would need never arrives
        // (HOST-ABI.md §3.11).
        if name == reqwest::header::SET_COOKIE {
            continue;
        }
        if let Ok(text) = value.to_str() {
            headers.insert(
                name.as_str().to_ascii_lowercase(),
                serde_json::Value::String(text.to_string()),
            );
        }
    }

    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|err| {
        abi::HostError::new(
            abi::ErrorCode::Unavailable,
            format!("the response body could not be read: {err}"),
        )
    })? {
        let would_be = body.len() as u64 + chunk.len() as u64;
        if would_be > max_bytes {
            return Err(too_large(would_be, max_bytes));
        }
        body.extend_from_slice(&chunk);
    }

    let body_bytes = body.len() as u64;
    Ok(abi::http::HttpResponseOutput {
        status,
        headers,
        body_base64: (!body.is_empty()).then(|| BASE64.encode(&body)),
        body_bytes,
        final_url,
    })
}

fn too_large(bytes: u64, limit: u64) -> abi::HostError {
    abi::HostError::new(
        abi::ErrorCode::TooLarge,
        format!("the response body is {bytes} bytes, the limit is {limit}"),
    )
    .with_detail(serde_json::json!({ "bytes": bytes, "limit": limit }))
}

/// Is this address allowed as an outbound destination?
///
/// Refused by default: loopback, unspecified, private (RFC 1918), link-local
/// (169.254/16, fe80::/10), site-local (fec0::/10), unique-local (fc00::/7), CGNAT
/// (100.64/10), multicast, documentation ranges, the 6to4/Teredo/NAT64-local prefixes whose
/// embedded IPv4 cannot be read out reliably, and the cloud metadata addresses — plus any
/// IPv6 address carrying an embedded IPv4, re-checked as its IPv4 form (see
/// [`embedded_ipv4`]: `::ffff:169.254.169.254` is the classic bypass and
/// `64:ff9b::a9fe:a9fe` is the one that still works on a NAT64 network).
/// An admin may allow specific CIDRs through `PLUGIN_HTTP_ALLOW_CIDRS` (SPEC §6.2:
/// "admin-configurable allowlist") — which is how a self-hosted LAN service becomes
/// reachable deliberately.
pub fn address_allowed(address: IpAddr, allowed: &[ipnet::IpNet]) -> bool {
    // Normalised first, so every rule below sees the IPv4 form of an address that carries an
    // embedded one, and no embedding is a special case anyone can forget further down.
    let address = match address {
        IpAddr::V6(v6) => match embedded_ipv4(v6) {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        other => other,
    };

    if METADATA_ADDRESSES.contains(&address) {
        return false;
    }
    if allowed.iter().any(|net| net.contains(&address)) {
        return true;
    }

    match address {
        IpAddr::V4(v4) => {
            let octets = v4.octets();
            !(v4.is_loopback()
                || v4.is_unspecified()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_documentation()
                // CGNAT, 100.64.0.0/10.
                || (octets[0] == 100 && (64..128).contains(&octets[1]))
                // Benchmarking, 198.18.0.0/15.
                || (octets[0] == 198 && (18..20).contains(&octets[1]))
                // "This network", 0.0.0.0/8.
                || octets[0] == 0
                // Reserved, 240.0.0.0/4.
                || octets[0] >= 240)
        }
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // Unique-local, fc00::/7.
                || (segments[0] & 0xfe00) == 0xfc00
                // Link-local, fe80::/10.
                || (segments[0] & 0xffc0) == 0xfe80
                // Deprecated site-local, fec0::/10. Deprecated is not unrouted: stacks and
                // appliances still answer on it, so it belongs with fe80::/10 rather than
                // being left to `is_unique_local`, which does not cover it.
                || (segments[0] & 0xffc0) == 0xfec0
                // Documentation, 2001:db8::/32.
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                // Discard-only, 100::/64.
                || (segments[0] == 0x0100 && segments[1..4] == [0, 0, 0])
                // 6to4 and Teredo carry an embedded IPv4 this check cannot see through, so
                // they are refused rather than half-checked.
                || segments[0] == 0x2002
                || (segments[0] == 0x2001 && segments[1] == 0x0000)
                // Any remaining NAT64 form. `embedded_ipv4` normalises the well-known
                // 64:ff9b::/96 prefix; RFC 8215's local-use 64:ff9b:1::/48 encodes the IPv4
                // at a prefix-length-dependent offset this code cannot know, so it is
                // refused rather than half-checked — same reasoning as 6to4.
                || (segments[0] == 0x0064 && segments[1] == 0xff9b))
        }
    }
}

/// The IPv4 address embedded in an IPv6 one, for every embedding a dual-stack or NAT64
/// network will actually route.
///
/// This is the whole of the `::ffff:169.254.169.254` lesson generalised. `to_ipv4_mapped`
/// alone left three live bypasses of the checks below — and because `http_request` resolves
/// then *pins* the address, [`address_allowed`] is the only defence: `connect` never
/// re-resolves, so a name whose AAAA the plugin controls is dialled exactly as returned.
///
/// - **`::ffff:a.b.c.d`** — IPv4-mapped (RFC 4291 §2.5.5.2), the classic.
/// - **`::ffff:0:a.b.c.d`** — IPv4-translated (RFC 2765).
/// - **`::a.b.c.d`** — IPv4-compatible (RFC 4291 §2.5.5.1); deprecated, still accepted by
///   stacks in the field.
/// - **`64:ff9b::a.b.c.d`** — the NAT64 well-known prefix (RFC 6052). This is the one that
///   matters most in production: on an IPv6-only or dual-stack host behind a NAT64/DNS64
///   gateway — the default in several managed Kubernetes and IPv6-only cloud networks —
///   `64:ff9b::a9fe:a9fe` is translated to 169.254.169.254 and returns instance credentials.
fn embedded_ipv4(v6: std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let segments = v6.segments();
    let low = |segments: &[u16; 8]| {
        let [a, b] = [segments[6].to_be_bytes(), segments[7].to_be_bytes()];
        std::net::Ipv4Addr::new(a[0], a[1], b[0], b[1])
    };

    // ::ffff:a.b.c.d
    if segments[..5] == [0, 0, 0, 0, 0] && segments[5] == 0xffff {
        return Some(low(&segments));
    }
    // ::ffff:0:a.b.c.d
    if segments[..4] == [0, 0, 0, 0] && segments[4] == 0xffff && segments[5] == 0 {
        return Some(low(&segments));
    }
    // ::a.b.c.d — excluding `::` and `::1`, which `is_unspecified`/`is_loopback` own.
    if segments[..6] == [0, 0, 0, 0, 0, 0] && !(segments[6] == 0 && segments[7] <= 1) {
        return Some(low(&segments));
    }
    // 64:ff9b::a.b.c.d
    if segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2..6] == [0, 0, 0, 0] {
        return Some(low(&segments));
    }
    None
}

/// Is this host name in the plugin's approved list? Exact, case-insensitive, no wildcards
/// and no suffix matching (`calendar.google.com.evil.test` is why).
pub fn host_allowed(host: &str, approved: &[String]) -> bool {
    // A trailing dot is the same name to DNS and a different string to a naive compare, so
    // it is normalised away rather than becoming a bypass.
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    approved.iter().any(|entry| {
        entry
            .trim()
            .trim_end_matches('.')
            .eq_ignore_ascii_case(&host)
    })
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

/// `log` — a plugin line in the server's structured log, attributed and rate-limited.
pub fn log(
    context: &HostContext,
    input: abi::log::LogInput,
) -> Result<serde_json::Value, abi::HostError> {
    if !context.counters.allow_log() {
        if context.counters.log_cap_reached() {
            tracing::warn!(
                plugin = %context.plugin.id, kind = context.kind.label(),
                limit = abi::log::MAX_LOG_LINES_PER_CALL,
                "plugin host: log line cap reached for this invocation; the rest are dropped"
            );
        }
        // Not an error: a plugin that logs too much is noisy, not broken, and failing its
        // call over a log line would be worse than dropping the line.
        return Ok(serde_json::Value::Null);
    }

    // Truncated, not refused (HOST-ABI.md §3.12): a long message is still a message.
    let message = if input.message.len() > abi::log::MAX_LOG_MESSAGE_BYTES {
        let mut cut = abi::log::MAX_LOG_MESSAGE_BYTES;
        while cut > 0 && !input.message.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}… [truncated]", &input.message[..cut])
    } else {
        input.message.clone()
    };

    let plugin = context.plugin.id.as_str();
    let kind = context.kind.label();
    match input.level {
        abi::log::LogLevel::Trace => tracing::trace!(plugin, kind, "{message}"),
        abi::log::LogLevel::Debug => tracing::debug!(plugin, kind, "{message}"),
        abi::log::LogLevel::Info => tracing::info!(plugin, kind, "{message}"),
        abi::log::LogLevel::Warn => tracing::warn!(plugin, kind, "{message}"),
        abi::log::LogLevel::Error => tracing::error!(plugin, kind, "{message}"),
    }
    Ok(serde_json::Value::Null)
}

#[cfg(test)]
mod tests {
    // The IP policy is the one thing in this file that must be unit-tested exhaustively —
    // one case per refused range, plus the IPv4-mapped-IPv6 bypass, plus an
    // admin-allowed CIDR. It is pure (`address_allowed`), so it needs no host, no plugin
    // and no database, and it is the check whose failure is invisible until it is abused.
    use super::*;

    fn active(id: &str, version: &str) -> crate::pluginhost::ActivePlugin {
        crate::pluginhost::ActivePlugin {
            id: id.to_string(),
            version: version.to_string(),
            capabilities: abi::Capabilities {
                documents: Vec::new(),
                http_hosts: Vec::new(),
                public_routes: Vec::new(),
                notifications: false,
            },
            deps: Default::default(),
            provides: None,
            callable: Default::default(),
            hooks: Vec::new(),
            cron: Vec::new(),
            routes: Vec::new(),
            events: Vec::new(),
            config_keys: Vec::new(),
            config: Default::default(),
            wasm_path: std::path::PathBuf::from("backend.wasm"),
            module_sha256: String::new(),
            abi_version: abi::ABI_VERSION,
            exports: Vec::new(),
        }
    }

    fn export(
        input: Option<serde_json::Value>,
        output: Option<serde_json::Value>,
    ) -> crate::pluginhost::CallableExport {
        crate::pluginhost::CallableExport::from_manifest(&crate::plugins::BackendExport {
            input,
            output,
            description: None,
        })
    }

    fn caller_of(id: &str, range: &str) -> crate::pluginhost::ActivePlugin {
        let mut caller = active("caller", "1.0.0");
        caller.deps.insert(id.to_string(), range.to_string());
        caller
    }

    fn callee() -> crate::pluginhost::ActivePlugin {
        let mut callee = active("calendar", "1.4.0");
        callee.callable.insert(
            "normalize".to_string(),
            export(
                Some(serde_json::json!({ "object": { "title": "string" } })),
                Some(serde_json::json!("string")),
            ),
        );
        callee
            .callable
            .insert("ping".to_string(), export(None, None));
        callee
    }

    #[test]
    fn a_call_needs_a_dependency_in_range() {
        let payload = serde_json::json!({ "title": "x" });
        // Not a dependency at all.
        let stranger = active("caller", "1.0.0");
        let err = check_call(
            &stranger,
            Some(&callee()),
            "calendar",
            "normalize",
            &payload,
        )
        .unwrap_err();
        assert_eq!(err.code, abi::ErrorCode::Forbidden);
        assert!(err.message.contains("dependencies"), "{}", err.message);
        // …even when the callee is not active: the manifest is checked first.
        let err = check_call(&stranger, None, "calendar", "normalize", &payload).unwrap_err();
        assert_eq!(err.code, abi::ErrorCode::Forbidden);
        // A dependency at the wrong version.
        let err = check_call(
            &caller_of("calendar", "^2.0"),
            Some(&callee()),
            "calendar",
            "normalize",
            &payload,
        )
        .unwrap_err();
        assert_eq!(err.code, abi::ErrorCode::Forbidden);
        assert!(err.message.contains("1.4.0"), "{}", err.message);
        // In range.
        assert!(
            check_call(
                &caller_of("calendar", "^1.2"),
                Some(&callee()),
                "calendar",
                "normalize",
                &payload
            )
            .is_ok()
        );
    }

    #[test]
    fn only_exported_functions_are_callable() {
        let caller = caller_of("calendar", "*");
        let err = check_call(
            &caller,
            Some(&callee()),
            "calendar",
            "secret",
            &serde_json::Value::Null,
        )
        .unwrap_err();
        assert_eq!(err.code, abi::ErrorCode::Forbidden);
        assert!(err.message.contains("backend.exports"), "{}", err.message);
        // An export with no shapes takes anything.
        assert!(
            check_call(
                &caller,
                Some(&callee()),
                "calendar",
                "ping",
                &serde_json::json!([1, 2])
            )
            .is_ok()
        );
    }

    #[test]
    fn payloads_and_results_are_checked_against_the_export_shapes() {
        let caller = caller_of("calendar", "*");
        let err = check_call(
            &caller,
            Some(&callee()),
            "calendar",
            "normalize",
            &serde_json::json!({ "title": 5 }),
        )
        .unwrap_err();
        assert_eq!(err.code, abi::ErrorCode::InvalidArgument);
        assert!(err.message.contains("title"), "{}", err.message);

        assert!(check_output(&callee(), "normalize", &serde_json::json!("ok")).is_ok());
        let err = check_output(&callee(), "normalize", &serde_json::json!(1)).unwrap_err();
        assert_eq!(err.code, abi::ErrorCode::Internal);
        assert!(check_output(&callee(), "ping", &serde_json::json!(1)).is_ok());
    }

    #[test]
    fn a_stand_in_is_called_at_its_provided_version() {
        let mut stand_in = callee();
        stand_in.id = "alt-calendar".to_string();
        stand_in.version = "0.1.0".to_string();
        stand_in.provides = Some(("calendar".to_string(), "1.5.0".to_string()));
        let payload = serde_json::json!({ "title": "x" });
        assert!(
            check_call(
                &caller_of("calendar", "^1.5"),
                Some(&stand_in),
                "calendar",
                "normalize",
                &payload
            )
            .is_ok()
        );
        assert!(
            check_call(
                &caller_of("calendar", "^0.1"),
                Some(&stand_in),
                "calendar",
                "normalize",
                &payload
            )
            .is_err()
        );
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().expect("a literal address")
    }

    fn cidr(text: &str) -> ipnet::IpNet {
        text.parse().expect("a literal CIDR")
    }

    /// `is_redirect` is deliberately narrower than `StatusCode::is_redirection()`.
    /// Following every 3xx meant looking for a `Location` on a **304 Not Modified**, which
    /// never has one — so a plugin that stored an `ETag` and asked politely on its second
    /// run got `unavailable` instead of "nothing changed".
    #[test]
    fn only_the_codes_that_carry_a_location_are_redirects() {
        for code in [301, 302, 303, 307, 308] {
            let status = reqwest::StatusCode::from_u16(code).expect("a status");
            assert!(is_redirect(status), "{code} moves the resource");
        }
        for code in [200, 204, 300, 304, 305, 400, 404, 500] {
            let status = reqwest::StatusCode::from_u16(code).expect("a status");
            assert!(
                !is_redirect(status),
                "{code} is an answer the plugin must see"
            );
        }
    }

    #[test]
    fn public_addresses_are_allowed() {
        for address in [
            "8.8.8.8",
            "1.1.1.1",
            "93.184.216.34",
            "2606:2800:220:1:248:1893:25c8:1946",
        ] {
            assert!(
                address_allowed(ip(address), &[]),
                "{address} should be reachable"
            );
        }
    }

    /// One case per refused range. Every one of these is a real SSRF target, and the list is
    /// the reason this function exists at all.
    #[test]
    fn the_private_and_special_ranges_are_refused_by_default() {
        for address in [
            // loopback
            "127.0.0.1",
            "127.1.2.3",
            "::1",
            // unspecified
            "0.0.0.0",
            "::",
            // RFC 1918
            "10.0.0.1",
            "172.16.5.4",
            "172.31.255.255",
            "192.168.1.1",
            // link-local
            "169.254.1.1",
            "fe80::1",
            // unique-local
            "fc00::1",
            "fd12:3456::1",
            // CGNAT
            "100.64.0.1",
            "100.127.255.255",
            // multicast / broadcast
            "224.0.0.1",
            "255.255.255.255",
            "ff02::1",
            // documentation
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "2001:db8::1",
            // benchmarking, "this network", reserved
            "198.18.0.1",
            "0.1.2.3",
            "240.0.0.1",
            // 6to4 and Teredo hide an IPv4 inside
            "2002:c0a8:101::1",
            "2001:0:1234::1",
        ] {
            assert!(
                !address_allowed(ip(address), &[]),
                "{address} must be refused"
            );
        }
    }

    /// `::ffff:169.254.169.254` is the classic bypass: an IPv6 literal that is an IPv4
    /// address in disguise. The policy has to look through the disguise.
    #[test]
    fn ipv4_mapped_ipv6_is_rechecked_as_ipv4() {
        for address in [
            "::ffff:169.254.169.254",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:192.168.0.1",
        ] {
            assert!(
                !address_allowed(ip(address), &[]),
                "{address} must be refused as its IPv4 form"
            );
        }
        assert!(
            address_allowed(ip("::ffff:8.8.8.8"), &[]),
            "a mapped public address is still public"
        );
    }

    /// `::ffff:` is not the only disguise. NAT64 is the one that still works in production:
    /// on an IPv6-only or dual-stack host behind a DNS64/NAT64 gateway, `64:ff9b::a9fe:a9fe`
    /// *is* 169.254.169.254, and because `http_request` pins the resolved address this check
    /// is the only thing standing between a plugin-controlled AAAA and the instance
    /// credentials.
    #[test]
    fn every_embedded_ipv4_form_is_rechecked_as_ipv4() {
        for address in [
            // NAT64 well-known prefix, RFC 6052.
            "64:ff9b::a9fe:a9fe",
            "64:ff9b::7f00:1",
            "64:ff9b::a00:1",
            // IPv4-compatible, RFC 4291 §2.5.5.1.
            "::a9fe:a9fe",
            "::7f00:1",
            "::c0a8:1",
            // IPv4-translated, RFC 2765.
            "::ffff:0:a9fe:a9fe",
            "::ffff:0:7f00:1",
            // Deprecated site-local.
            "fec0::1",
            "feff::1",
            // NAT64 local-use prefix: the embedded IPv4 sits at a prefix-length-dependent
            // offset, so it is refused outright rather than half-checked.
            "64:ff9b:1::1",
            // Discard-only.
            "100::1",
        ] {
            assert!(
                !address_allowed(ip(address), &[]),
                "{address} must be refused"
            );
        }

        // A public embedded address is still public — the point is to read through the
        // encoding, not to refuse the encoding.
        assert!(address_allowed(ip("64:ff9b::808:808"), &[]));
        assert!(address_allowed(ip("::808:808"), &[]));
    }

    /// The metadata refusal has to survive every encoding too, not just the mapped one.
    #[test]
    fn the_metadata_addresses_survive_every_embedding() {
        let wide = vec![cidr("::/0"), cidr("0.0.0.0/0")];
        for address in [
            "64:ff9b::a9fe:a9fe",
            "64:ff9b::a9fe:aa02",
            "64:ff9b::6464:64c8",
            "::a9fe:a9fe",
            "::ffff:0:a9fe:a9fe",
            "::ffff:169.254.169.254",
        ] {
            assert!(
                !address_allowed(ip(address), &wide),
                "{address} must be refused even inside an operator allowlist"
            );
        }
    }

    #[test]
    fn an_operator_may_allow_a_specific_range() {
        let allowed = vec![cidr("10.1.2.0/24"), cidr("fd00::/8")];
        assert!(address_allowed(ip("10.1.2.7"), &allowed));
        assert!(address_allowed(ip("fd00::1"), &allowed));
        // Only the range they named.
        assert!(!address_allowed(ip("10.1.3.7"), &allowed));
        assert!(!address_allowed(ip("192.168.1.1"), &allowed));
    }

    /// Widening a CIDR means "let my LAN through", never "let the instance credentials
    /// through". The metadata addresses stay refused even inside an allowed range.
    #[test]
    fn the_metadata_addresses_survive_an_operator_allowlist() {
        let wide = vec![cidr("0.0.0.0/0"), cidr("169.254.0.0/16")];
        assert!(!address_allowed(ip("169.254.169.254"), &wide));
        assert!(!address_allowed(ip("169.254.170.2"), &wide));
        assert!(!address_allowed(ip("100.100.100.200"), &wide));
        assert!(!address_allowed(ip("::ffff:169.254.169.254"), &wide));
        // The rest of a deliberately-allowed range does open up.
        assert!(address_allowed(ip("169.254.1.1"), &wide));
    }

    #[test]
    fn the_host_allowlist_is_exact_and_case_insensitive() {
        let approved = vec![
            "calendar.google.com".to_string(),
            "Feeds.Example.COM".to_string(),
        ];
        assert!(host_allowed("calendar.google.com", &approved));
        assert!(host_allowed("CALENDAR.GOOGLE.COM", &approved));
        assert!(host_allowed("feeds.example.com", &approved));
        // A trailing dot is the same name to DNS; it must not be a way past the compare.
        assert!(host_allowed("calendar.google.com.", &approved));

        // No suffix matching, no prefix matching, no wildcards — which is the whole reason
        // the check is not `ends_with`.
        assert!(!host_allowed("calendar.google.com.evil.test", &approved));
        assert!(!host_allowed("evil.calendar.google.com", &approved));
        assert!(!host_allowed("google.com", &approved));
        assert!(!host_allowed("", &approved));
        assert!(!host_allowed("calendar.google.com", &[]));
    }

    #[test]
    fn kv_keys_are_namespaced_by_construction() {
        assert_eq!(kv_id("calendar", "feed.etag"), "calendar:feed.etag");
        assert!(valid_kv_key("feed.etag"));
        assert!(valid_kv_key("sync:cursor-1"));
        assert!(!valid_kv_key(""));
        assert!(!valid_kv_key("has space"));
        assert!(!valid_kv_key("has/slash"));
        assert!(!valid_kv_key(
            &"x".repeat(abi::limits::MAX_KV_KEY_BYTES + 1)
        ));
    }

    #[test]
    fn a_section_edit_distinguishes_a_null_from_a_removal() {
        let edits = vec![
            abi::documents::SectionEdit {
                key: "source_uid".into(),
                value: Some(serde_json::json!("abc@example.com")),
                remove: false,
            },
            abi::documents::SectionEdit {
                key: "cleared".into(),
                value: Some(serde_json::Value::Null),
                remove: false,
            },
            abi::documents::SectionEdit {
                key: "gone".into(),
                value: None,
                remove: true,
            },
        ];
        let converted = section_edits(&edits).expect("all three are representable");
        assert_eq!(
            converted[0].value,
            Some(core::value::Value::Str("abc@example.com".into()))
        );
        assert_eq!(
            converted[1].value,
            Some(core::value::Value::Null),
            "`value: null` writes the line `cleared: null`"
        );
        assert_eq!(converted[2].value, None, "`remove` deletes the line");
    }

    /// A `%%%` section is one key per line (SPEC §3.3), so a nested value has nowhere to go.
    /// Refusing it beats writing something that will not parse back.
    #[test]
    fn a_nested_value_is_not_representable_one_key_per_line() {
        let nested = vec![abi::documents::SectionEdit {
            key: "event".into(),
            value: Some(serde_json::json!({ "start": "2026-09-24" })),
            remove: false,
        }];
        let err = section_edits(&nested).expect_err("a map is refused");
        assert_eq!(err.code, abi::ErrorCode::InvalidArgument);

        let nested_list = vec![abi::documents::SectionEdit {
            key: "attendees".into(),
            value: Some(serde_json::json!([["a"], ["b"]])),
            remove: false,
        }];
        assert!(section_edits(&nested_list).is_err());

        // A flat flow sequence is fine — that is what the strict YAML subset allows.
        let flat = vec![abi::documents::SectionEdit {
            key: "attendees".into(),
            value: Some(serde_json::json!(["ada", "grace"])),
            remove: false,
        }];
        assert!(section_edits(&flat).is_ok());
    }

    #[test]
    fn a_section_edit_that_says_nothing_is_refused() {
        let empty = vec![abi::documents::SectionEdit {
            key: "k".into(),
            value: None,
            remove: false,
        }];
        assert_eq!(
            section_edits(&empty)
                .expect_err("neither set nor remove")
                .code,
            abi::ErrorCode::InvalidArgument
        );

        let both = vec![abi::documents::SectionEdit {
            key: "k".into(),
            value: Some(serde_json::json!(1)),
            remove: true,
        }];
        assert_eq!(
            section_edits(&both).expect_err("both at once").code,
            abi::ErrorCode::InvalidArgument
        );

        let bad_key = vec![abi::documents::SectionEdit {
            key: "not a key".into(),
            value: Some(serde_json::json!(1)),
            remove: false,
        }];
        assert_eq!(
            section_edits(&bad_key).expect_err("bad key").code,
            abi::ErrorCode::InvalidArgument
        );
    }

    /// The host owns the `<plugin-id>:` prefix, so an event name may not contain a colon —
    /// otherwise a plugin could spell a name that reads as another plugin's.
    #[test]
    fn an_event_name_cannot_spoof_another_plugins_namespace() {
        let payload = serde_json::json!({ "created": 1 });
        assert!(check_event("synced", &payload).is_ok());
        assert!(check_event("feed.synced", &payload).is_ok());
        assert!(check_event("calendar:synced", &payload).is_err());
        assert!(check_event("", &payload).is_err());
        assert!(check_event(&"x".repeat(65), &payload).is_err());

        let huge = serde_json::json!({ "blob": "x".repeat(abi::limits::MAX_EVENT_PAYLOAD_BYTES) });
        assert_eq!(
            check_event("synced", &huge).expect_err("over the cap").code,
            abi::ErrorCode::TooLarge
        );
    }

    /// The set of linked imports must be the *same* for every plugin whatever an admin
    /// approved (SPEC §6.2's erroring stubs), and all of them in `extism:host/user` so
    /// nothing here can shadow Extism's own built-ins in `extism:host/env`.
    #[test]
    fn every_abi_host_function_is_registered_exactly_once_in_the_user_namespace() {
        let functions = functions();
        let mut names: Vec<&str> = functions.iter().map(extism::Function::name).collect();
        names.sort_unstable();
        let mut expected = abi::names::HOST_FUNCTIONS.to_vec();
        expected.sort_unstable();
        assert_eq!(names, expected);

        for function in &functions {
            assert_eq!(function.namespace(), Some(super::super::HOST_NAMESPACE));
        }
    }

    /// `host` is the interesting one: a request that names an allowed host in the URL and a
    /// different one in the header would pass the allowlist and arrive somewhere else.
    #[test]
    fn the_connection_headers_are_refused_and_authorization_is_not() {
        assert!(REFUSED_REQUEST_HEADERS.contains(&"host"));
        assert!(REFUSED_REQUEST_HEADERS.contains(&"transfer-encoding"));
        assert!(!REFUSED_REQUEST_HEADERS.contains(&"authorization"));
        // The comparison is done lowercased, so the list must be lowercase too.
        for header in REFUSED_REQUEST_HEADERS {
            assert_eq!(*header, header.to_ascii_lowercase());
        }
    }
}

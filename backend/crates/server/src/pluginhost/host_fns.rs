use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use ddd_core as core;
use ddd_plugin_abi as abi;
use extism::{CurrentPlugin, Function, UserData, Val, ValType};
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::limits::{CallCounters, Deadline, PluginLimits, WriteLedger};
use super::{ActivePlugin, CallKind};
use crate::docstore::DocStoreError;
use crate::state::AppState;

pub struct HostContext {
    pub state: AppState,
    pub plugin: Arc<ActivePlugin>,
    pub kind: CallKind,
    pub limits: PluginLimits,
    pub deadline: Deadline,
    pub depth: u32,
    pub stack: Vec<String>,
    pub user_id: Option<String>,
    pub counters: CallCounters,
    pub write_ledger: Arc<WriteLedger>,
    pub runtime: tokio::runtime::Handle,
}

impl HostContext {
    pub fn can_read(&self) -> bool {
        self.plugin.capabilities.can_read_documents()
    }

    pub fn can_write(&self) -> bool {
        self.plugin.capabilities.can_write_documents()
    }

    pub fn actor(&self) -> crate::domain::Actor {
        self.plugin.actor()
    }

    fn block_on<F: std::future::Future>(&self, future: F) -> F::Output {
        self.runtime.block_on(future)
    }

    fn charge_write(&self, document_id: &str) -> Result<(), abi::HostError> {
        self.counters.record_write(self.limits.writes_per_call)?;
        self.write_ledger.record(&self.plugin.id, document_id)
    }
}

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
    let context: Arc<HostContext> = match plugin.host_context::<Arc<HostContext>>() {
        Ok(context) => Arc::clone(context),
        Err(err) => {
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

fn write_envelope<O: Serialize>(
    plugin: &mut CurrentPlugin,
    outputs: &mut [Val],
    envelope: &abi::Envelope<O>,
) -> Result<(), extism::Error> {
    let json = match serde_json::to_string(envelope) {
        Ok(json) if json.len() <= abi::limits::MAX_HOST_OUTPUT_BYTES => json,
        Ok(json) => {
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

pub fn signature() -> ([ValType; 1], [ValType; 1]) {
    ([ValType::I64], [ValType::I64])
}

pub type Context = UserData<()>;

fn require_read(context: &HostContext) -> Result<(), abi::HostError> {
    if context.can_read() {
        Ok(())
    } else {
        Err(abi::HostError::capability_denied("documents:read"))
    }
}

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

fn document_id(raw: &str) -> Result<&str, abi::HostError> {
    if crate::domain::is_valid_id(raw) {
        Ok(raw)
    } else {
        Err(invalid(format!("`{raw}` is not a document id")))
    }
}

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
        DocStoreError::SpliceRefused(message) => invalid(message),
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

fn bson_map_to_json(document: &bson::Document) -> abi::JsonMap {
    core::value::map_from_bson(document)
        .into_iter()
        .map(|(key, value)| (key, value.to_json()))
        .collect()
}

fn timestamp(at: bson::DateTime) -> String {
    crate::domain::Timestamp::from(at).to_rfc3339()
}

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

pub fn get_document(
    context: &HostContext,
    input: abi::documents::GetDocumentInput,
) -> Result<abi::documents::GetDocumentOutput, abi::HostError> {
    require_read(context)?;
    let id = document_id(&input.id)?;

    let document = context
        .block_on(async {
            match context.state.docs.get(id).await {
                Ok(document) => Ok(document),
                Err(DocStoreError::NotFound(missing)) => {
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

pub fn query(
    context: &HostContext,
    input: abi::documents::QueryInput,
) -> Result<abi::documents::QueryOutput, abi::HostError> {
    require_read(context)?;
    let mut plan = core::query::Plan::from_json(&input.plan)
        .map_err(|err| invalid(format!("the query is not valid: {err}")))?;
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

    #[derive(Default)]
    struct Decision {
        edits_applied: u32,
        refusal: Option<abi::HostError>,
        seen: Option<String>,
    }
    let decision = std::sync::Mutex::new(Decision::default());

    let compute = |text: &str| -> Result<Vec<core::splice::TextEdit>, String> {
        let mut decision = decision.lock().expect("splice decision lock poisoned");
        decision.seen = Some(text.to_string());

        let current = core::sections::parse(text);
        let existing = current.get(&plugin_id).map(|section| &section.map);
        let changing: Vec<core::splice::SectionLineEdit> = requested
            .iter()
            .filter(|edit| {
                let present = existing.and_then(|map| map.get(&edit.key));
                match (&edit.value, present) {
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

fn kv_id(plugin_id: &str, key: &str) -> String {
    format!("{plugin_id}:{key}")
}

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

pub fn config_get(
    context: &HostContext,
    input: abi::config::ConfigGetInput,
) -> Result<abi::config::ConfigGetOutput, abi::HostError> {
    if let Some(key) = input.key.as_deref() {
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

pub fn emit(
    context: &HostContext,
    input: abi::events::EmitInput,
) -> Result<abi::events::EmitOutput, abi::HostError> {
    super::hooks::emit_to_plugins(context, input)
}

pub fn emit_client(
    context: &HostContext,
    input: abi::events::EmitClientInput,
) -> Result<abi::events::EmitClientOutput, abi::HostError> {
    super::hooks::emit_to_clients(context, input)
}

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
            super::CallFailure::Refused(error) => error,
            super::CallFailure::Host(error) => error.as_host_error(),
        })?
        .unwrap_or(serde_json::Value::Null);

    if let Some(callee) = callee.as_deref() {
        check_output(callee, &input.function, &value)?;
    }
    Ok(abi::call::CallPluginOutput { value })
}

pub fn check_call(
    caller: &super::ActivePlugin,
    callee: Option<&super::ActivePlugin>,
    requested: &str,
    function: &str,
    payload: &serde_json::Value,
) -> Result<(), abi::HostError> {
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
        let issues = ddd_core::shape::validate(payload, shape);
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
    let issues = ddd_core::shape::validate(value, shape);
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

fn describe_issues(issues: &[ddd_core::shape::Issue]) -> String {
    issues
        .iter()
        .take(5)
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("; ")
}

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

const METADATA_ADDRESSES: &[IpAddr] = &[
    IpAddr::V4(std::net::Ipv4Addr::new(169, 254, 169, 254)),
    IpAddr::V4(std::net::Ipv4Addr::new(169, 254, 170, 2)),
    IpAddr::V4(std::net::Ipv4Addr::new(100, 100, 100, 200)),
];

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

async fn fetch(request: FetchRequest<'_>) -> Result<abi::http::HttpResponseOutput, abi::HostError> {
    let deadline = std::time::Instant::now() + request.timeout;
    let mut url = reqwest::Url::parse(request.url)
        .map_err(|err| invalid(format!("`{}` is not a URL: {err}", request.url)))?;
    let mut hops = 0u32;
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
            .resolve_to_addrs(&host, &addresses)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(remaining)
            .user_agent(concat!("ddd/", env!("CARGO_PKG_VERSION")))
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

fn origin_of(url: &reqwest::Url) -> String {
    format!(
        "{}://{}:{}",
        url.scheme(),
        url.host_str().unwrap_or_default().to_ascii_lowercase(),
        url.port_or_known_default().unwrap_or_default()
    )
}

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

fn is_redirect(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

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

async fn resolve_pinned(
    host: &str,
    port: u16,
    allow_cidrs: &[ipnet::IpNet],
    timeout: Duration,
) -> Result<Vec<std::net::SocketAddr>, abi::HostError> {
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

pub fn address_allowed(address: IpAddr, allowed: &[ipnet::IpNet]) -> bool {
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
                || (octets[0] == 100 && (64..128).contains(&octets[1]))
                || (octets[0] == 198 && (18..20).contains(&octets[1]))
                || octets[0] == 0
                || octets[0] >= 240)
        }
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xffc0) == 0xfec0
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || (segments[0] == 0x0100 && segments[1..4] == [0, 0, 0])
                || segments[0] == 0x2002
                || (segments[0] == 0x2001 && segments[1] == 0x0000)
                || (segments[0] == 0x0064 && segments[1] == 0xff9b))
        }
    }
}

fn embedded_ipv4(v6: std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let segments = v6.segments();
    let low = |segments: &[u16; 8]| {
        let [a, b] = [segments[6].to_be_bytes(), segments[7].to_be_bytes()];
        std::net::Ipv4Addr::new(a[0], a[1], b[0], b[1])
    };

    if segments[..5] == [0, 0, 0, 0, 0] && segments[5] == 0xffff {
        return Some(low(&segments));
    }
    if segments[..4] == [0, 0, 0, 0] && segments[4] == 0xffff && segments[5] == 0 {
        return Some(low(&segments));
    }
    if segments[..6] == [0, 0, 0, 0, 0, 0] && !(segments[6] == 0 && segments[7] <= 1) {
        return Some(low(&segments));
    }
    if segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2..6] == [0, 0, 0, 0] {
        return Some(low(&segments));
    }
    None
}

pub fn host_allowed(host: &str, approved: &[String]) -> bool {
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
        return Ok(serde_json::Value::Null);
    }

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
        let err = check_call(&stranger, None, "calendar", "normalize", &payload).unwrap_err();
        assert_eq!(err.code, abi::ErrorCode::Forbidden);
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

    #[test]
    fn the_private_and_special_ranges_are_refused_by_default() {
        for address in [
            "127.0.0.1",
            "127.1.2.3",
            "::1",
            "0.0.0.0",
            "::",
            "10.0.0.1",
            "172.16.5.4",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.1.1",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "100.64.0.1",
            "100.127.255.255",
            "224.0.0.1",
            "255.255.255.255",
            "ff02::1",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "2001:db8::1",
            "198.18.0.1",
            "0.1.2.3",
            "240.0.0.1",
            "2002:c0a8:101::1",
            "2001:0:1234::1",
        ] {
            assert!(
                !address_allowed(ip(address), &[]),
                "{address} must be refused"
            );
        }
    }

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

    #[test]
    fn every_embedded_ipv4_form_is_rechecked_as_ipv4() {
        for address in [
            "64:ff9b::a9fe:a9fe",
            "64:ff9b::7f00:1",
            "64:ff9b::a00:1",
            "::a9fe:a9fe",
            "::7f00:1",
            "::c0a8:1",
            "::ffff:0:a9fe:a9fe",
            "::ffff:0:7f00:1",
            "fec0::1",
            "feff::1",
            "64:ff9b:1::1",
            "100::1",
        ] {
            assert!(
                !address_allowed(ip(address), &[]),
                "{address} must be refused"
            );
        }

        assert!(address_allowed(ip("64:ff9b::808:808"), &[]));
        assert!(address_allowed(ip("::808:808"), &[]));
    }

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
        assert!(!address_allowed(ip("10.1.3.7"), &allowed));
        assert!(!address_allowed(ip("192.168.1.1"), &allowed));
    }

    #[test]
    fn the_metadata_addresses_survive_an_operator_allowlist() {
        let wide = vec![cidr("0.0.0.0/0"), cidr("169.254.0.0/16")];
        assert!(!address_allowed(ip("169.254.169.254"), &wide));
        assert!(!address_allowed(ip("169.254.170.2"), &wide));
        assert!(!address_allowed(ip("100.100.100.200"), &wide));
        assert!(!address_allowed(ip("::ffff:169.254.169.254"), &wide));
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
        assert!(host_allowed("calendar.google.com.", &approved));

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

    #[test]
    fn the_connection_headers_are_refused_and_authorization_is_not() {
        assert!(REFUSED_REQUEST_HEADERS.contains(&"host"));
        assert!(REFUSED_REQUEST_HEADERS.contains(&"transfer-encoding"));
        assert!(!REFUSED_REQUEST_HEADERS.contains(&"authorization"));
        for header in REFUSED_REQUEST_HEADERS {
            assert_eq!(*header, header.to_ascii_lowercase());
        }
    }
}

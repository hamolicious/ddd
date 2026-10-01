//! Reading and writing documents.
//!
//! The write primitives and what each is for (SPEC §3.3):
//!
//! - [`splice_section`] / [`set_section`] — your `%%%` section, one line per key. The
//!   *only* way to put machine data in a document a human owns, and the reason concurrent
//!   writes merge instead of clobbering.
//! - [`create`] / [`create_with_id`] — a machine-owned document, authored wholesale. The
//!   host records you as its creator, which is what makes [`rewrite`] legal later.
//! - [`rewrite`] — the whole text of a document **you** created. Refused with
//!   [`ErrorCode::Forbidden`](crate::ErrorCode::Forbidden) on anything else.
//!
//! Reading many: [`run`] takes a [`Query`], the chain the server and the browser use too:
//!
//! ```ignore
//! use life_manager_plugin_sdk::documents::{self, Op, Query};
//!
//! let page = documents::run(
//!     Query::new().filter("title", Op::TextContains, "a").sort("fm.key").limit(20),
//! )?;
//! ```

use crate::abi::documents::{
    CreateDocumentInput, DocumentValue, GetDocumentInput, GetDocumentOutput, QueryDocumentsInput,
    QueryDocumentsOutput, QueryInput, QueryOutput, RewriteDocumentInput, SectionEdit,
    SpliceSectionInput, SpliceSectionOutput, WriteDocumentOutput,
};
use crate::host::{self, call_value};
use crate::{ErrorCode, HostError};

pub use life_manager_core::query::{Op, Plan, Query, Sort, Trash};

/// One page of a [`Query`], `content` included. `documents:read`.
///
/// A mistake in the query (a malformed field, a value the operator cannot take) is
/// [`ErrorCode::InvalidArgument`] before anything reaches the host. Follow
/// [`next_cursor`](QueryOutput::next_cursor) with [`Query::cursor`] for the next page.
pub fn run(query: Query) -> crate::Result<QueryOutput> {
    let plan = query
        .build()
        .map_err(|err| HostError::new(ErrorCode::InvalidArgument, err.to_string()))?;
    run_plan(&plan, false)
}

/// A query plan, as it is. `metadata_only` leaves `content` out of the rows.
pub fn run_plan(plan: &Plan, metadata_only: bool) -> crate::Result<QueryOutput> {
    call_value(
        host::query,
        &QueryInput {
            plan: plan.to_json(),
            metadata_only,
        },
    )
}

/// One document, `content` included. `documents:read`.
pub fn get(id: &str) -> crate::Result<DocumentValue> {
    let output: GetDocumentOutput = call_value(
        host::get_document,
        &GetDocumentInput {
            id: id.to_string(),
            metadata_only: false,
        },
    )?;
    Ok(output.document)
}

/// One document without its text — the cheap read when only `fm` or a section matters.
pub fn get_metadata(id: &str) -> crate::Result<DocumentValue> {
    let output: GetDocumentOutput = call_value(
        host::get_document,
        &GetDocumentInput {
            id: id.to_string(),
            metadata_only: true,
        },
    )?;
    Ok(output.document)
}

/// One page of a query. `documents:read`.
///
/// Paging is the caller's job: follow
/// [`next_cursor`](crate::abi::documents::QueryDocumentsOutput::next_cursor) until it is
/// `None`. There is no unbounded read, and a plugin that ignores the cursor sees only the
/// first page.
pub fn query(input: &QueryDocumentsInput) -> crate::Result<QueryDocumentsOutput> {
    call_value(host::query_documents, input)
}

/// Every match, page by page, up to `max_documents`.
///
/// Convenience for the reconciliation pass a sync plugin does on its cron run. It is a
/// loop over [`query`] and nothing more; the cap is explicit because "read the whole
/// workspace" must be a decision with a number attached.
pub fn query_all(
    input: &QueryDocumentsInput,
    max_documents: usize,
) -> crate::Result<Vec<DocumentValue>> {
    let mut collected = Vec::new();
    let mut cursor = input.cursor.clone();
    loop {
        let page = query(&QueryDocumentsInput {
            cursor: cursor.clone(),
            ..input.clone()
        })?;
        let next = page.next_cursor.clone();
        collected.extend(page.documents);
        if collected.len() >= max_documents || next.is_none() {
            collected.truncate(max_documents);
            return Ok(collected);
        }
        cursor = next;
    }
}

/// Create a machine-owned document from its full text. `documents:write`.
pub fn create(text: &str) -> crate::Result<WriteDocumentOutput> {
    call_value(
        host::create_document,
        &CreateDocumentInput {
            text: text.to_string(),
            id: None,
        },
    )
}

/// Create with a chosen ULID, so a retry after a timeout is idempotent: the second
/// attempt gets [`ErrorCode::AlreadyExists`](crate::ErrorCode::AlreadyExists).
pub fn create_with_id(id: &str, text: &str) -> crate::Result<WriteDocumentOutput> {
    call_value(
        host::create_document,
        &CreateDocumentInput {
            text: text.to_string(),
            id: Some(id.to_string()),
        },
    )
}

/// Replace the whole text of a document this plugin created. `documents:write`.
pub fn rewrite(id: &str, text: &str) -> crate::Result<WriteDocumentOutput> {
    call_value(
        host::rewrite_document,
        &RewriteDocumentInput {
            id: id.to_string(),
            text: text.to_string(),
        },
    )
}

/// Line-splice this plugin's `%%%` section. `documents:write`.
pub fn splice_section(id: &str, edits: &[SectionEdit]) -> crate::Result<SpliceSectionOutput> {
    call_value(
        host::splice_section,
        &SpliceSectionInput {
            id: id.to_string(),
            edits: edits.to_vec(),
        },
    )
}

/// Set one key in this plugin's section.
pub fn set_section(
    id: &str,
    key: &str,
    value: serde_json::Value,
) -> crate::Result<SpliceSectionOutput> {
    splice_section(
        id,
        &[SectionEdit {
            key: key.to_string(),
            value: Some(value),
            remove: false,
        }],
    )
}

/// Remove one key from this plugin's section.
pub fn remove_section_key(id: &str, key: &str) -> crate::Result<SpliceSectionOutput> {
    splice_section(
        id,
        &[SectionEdit {
            key: key.to_string(),
            value: None,
            remove: true,
        }],
    )
}

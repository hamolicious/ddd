use crate::abi::documents::{
    CreateDocumentInput, DocumentValue, GetDocumentInput, GetDocumentOutput, QueryDocumentsInput,
    QueryDocumentsOutput, QueryInput, QueryOutput, RewriteDocumentInput, SectionEdit,
    SpliceSectionInput, SpliceSectionOutput, WriteDocumentOutput,
};
use crate::host::{self, call_value};
use crate::{ErrorCode, HostError};

pub use ddd_core::query::{Op, Plan, Query, Sort, Trash};

pub fn run(query: Query) -> crate::Result<QueryOutput> {
    let plan = query
        .build()
        .map_err(|err| HostError::new(ErrorCode::InvalidArgument, err.to_string()))?;
    run_plan(&plan, false)
}

pub fn run_plan(plan: &Plan, metadata_only: bool) -> crate::Result<QueryOutput> {
    call_value(
        host::query,
        &QueryInput {
            plan: plan.to_json(),
            metadata_only,
        },
    )
}

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

pub fn query(input: &QueryDocumentsInput) -> crate::Result<QueryDocumentsOutput> {
    call_value(host::query_documents, input)
}

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

pub fn create(text: &str) -> crate::Result<WriteDocumentOutput> {
    call_value(
        host::create_document,
        &CreateDocumentInput {
            text: text.to_string(),
            id: None,
        },
    )
}

pub fn create_with_id(id: &str, text: &str) -> crate::Result<WriteDocumentOutput> {
    call_value(
        host::create_document,
        &CreateDocumentInput {
            text: text.to_string(),
            id: Some(id.to_string()),
        },
    )
}

pub fn rewrite(id: &str, text: &str) -> crate::Result<WriteDocumentOutput> {
    call_value(
        host::rewrite_document,
        &RewriteDocumentInput {
            id: id.to_string(),
            text: text.to_string(),
        },
    )
}

pub fn splice_section(id: &str, edits: &[SectionEdit]) -> crate::Result<SpliceSectionOutput> {
    call_value(
        host::splice_section,
        &SpliceSectionInput {
            id: id.to_string(),
            edits: edits.to_vec(),
        },
    )
}

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

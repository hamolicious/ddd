mod extract;
mod project;
mod schema;

pub use extract::{
    AttachmentRef, BodyFacts, FmEntry, FmKind, LinkKind, MAX_FM_DEPTH, Reference, Task, TaskState, doc_id_of,
    extract_body, fm_entries, flatten_paths,
};
pub use project::{
    Projection, ProjectionInput, SqlValue, Statement, project, remove_statements, statements_for_json,
    statements_for_rows,
};
pub use schema::{READ_SCHEMA_VERSION, READ_STAMPS, SCHEMA, SEARCH_SCHEMA_VERSION, WRITE_SCHEMA_VERSION};

#[cfg(test)]
mod tests;

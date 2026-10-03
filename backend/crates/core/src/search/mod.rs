mod catalog;
mod compile;
mod cursor;
mod extract;
mod fuzzy;
mod plan;
mod project;
mod schema;
mod snippets;
mod text;

pub use catalog::Decode;
pub use compile::{CountQuery, Compiled, OutputColumn, compile};
pub use cursor::{decode_cursor, encode_cursor};
pub use fuzzy::{FuzzyCandidate, FuzzySpec, Ranked, rank as fuzzy_rank};
pub use extract::{
    AttachmentRef, BodyFacts, FmEntry, FmKind, LinkKind, MAX_FM_DEPTH, Reference, Task, TaskState, doc_id_of,
    extract_body, fm_entries, flatten_paths,
};
pub use plan::{
    Cond, FuzzyStage, MAX_LIMIT, MAX_SORT_KEYS, MAX_STAGES, Plan, PlanError, SelectItem, Source, Stage, TrashScope,
};
pub use project::{
    ProjectedDocument, Projection, ProjectionInput, SqlValue, Statement, project, project_json, project_rows,
    remove_statements, statements_for_json, statements_for_rows,
};
pub use text::{FIELD_WEIGHTS, MAX_QUERY_TERMS, MAX_TEXT_BYTES, TextExpr, TextField, parse_text};
pub use snippets::snippet;
pub use schema::{READ_SCHEMA_VERSION, READ_STAMPS, SCHEMA, SEARCH_SCHEMA_VERSION, WRITE_SCHEMA_VERSION};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod compile_tests;

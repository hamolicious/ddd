mod catalog;
mod compile;
mod cursor;
mod extract;
mod functions;
mod fuzzy;
mod plan;
mod project;
mod schema;
mod snippets;
mod text;

pub use catalog::Decode;
pub use compile::{Compiled, CountQuery, OutputColumn, compile, expand_plan};
pub use cursor::{decode_cursor, encode_cursor};
pub use extract::{
    AttachmentRef, BodyFacts, FmEntry, FmKind, LinkKind, MAX_FM_DEPTH, Reference, Task, TaskState,
    doc_id_of, extract_body, flatten_paths, fm_entries,
};
pub use functions::{
    SQL_FUNCTIONS, SqlCall, SqlFunction, SqlFunctionInfo, call_sql_function, sql_function,
};
pub use fuzzy::{
    FuzzyCandidate, FuzzyMatch, FuzzySpec, Ranked, rank as fuzzy_rank, score_candidate,
};
pub use plan::{
    Cond, FuzzyStage, MAX_LIMIT, MAX_SORT_KEYS, MAX_STAGES, Plan, PlanError, SelectItem, Source,
    Stage, TrashScope,
};
pub use project::{
    ProjectedDocument, Projection, ProjectionInput, SqlValue, Statement, project, project_json,
    project_rows, remove_statements, statements_for_json, statements_for_rows,
};
pub use schema::{
    FOLD_FUNCTION, READ_SCHEMA_VERSION, READ_STAMPS, SCHEMA, SEARCH_SCHEMA_VERSION,
    WRITE_SCHEMA_VERSION, fold,
};
pub use snippets::snippet;
pub use text::{FIELD_WEIGHTS, MAX_QUERY_TERMS, MAX_TEXT_BYTES, TextExpr, TextField, parse_text};

#[cfg(test)]
mod compile_tests;
#[cfg(test)]
mod tests;

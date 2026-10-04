pub const SEARCH_SCHEMA_VERSION: u32 = 4;

pub const SCHEMA: &[&str] = &[
    "CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) WITHOUT ROWID",
    "CREATE TABLE documents (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        fm TEXT NOT NULL,
        plugins TEXT NOT NULL,
        fm_parse_error INTEGER NOT NULL,
        materialized_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT,
        updated_at TEXT NOT NULL,
        updated_by TEXT,
        deleted INTEGER NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT,
        purged INTEGER NOT NULL,
        words INTEGER NOT NULL,
        characters INTEGER NOT NULL,
        stamp TEXT NOT NULL
    )",
    "CREATE INDEX documents_updated_at ON documents (updated_at)",
    "CREATE TABLE fm (doc TEXT NOT NULL, key TEXT NOT NULL, value, kind TEXT NOT NULL, position INTEGER)",
    "CREATE INDEX fm_doc ON fm (doc)",
    "CREATE INDEX fm_key_value ON fm (key, value)",
    "CREATE TABLE link_refs (doc TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, key TEXT, count INTEGER NOT NULL)",
    "CREATE INDEX link_refs_doc ON link_refs (doc)",
    "CREATE INDEX link_refs_target ON link_refs (target)",
    "CREATE VIEW links AS
        SELECT r.doc, r.target, r.kind, r.key, r.count,
            CASE WHEN t.id IS NULL THEN 'missing' WHEN t.deleted THEN 'trashed' ELSE 'live' END AS state
        FROM link_refs r LEFT JOIN documents t ON t.id = r.target",
    "CREATE TABLE tasks (doc TEXT NOT NULL, line INTEGER NOT NULL, state TEXT NOT NULL, marker TEXT NOT NULL, text TEXT NOT NULL)",
    "CREATE INDEX tasks_doc ON tasks (doc)",
    "CREATE TABLE attachments (doc TEXT NOT NULL, attachment TEXT NOT NULL, line INTEGER NOT NULL)",
    "CREATE INDEX attachments_doc ON attachments (doc)",
    "CREATE INDEX attachments_attachment ON attachments (attachment)",
    "CREATE VIRTUAL TABLE documents_fts USING fts5(title, content, fm, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')",
    "CREATE VIRTUAL TABLE documents_vocab USING fts5vocab(documents_fts, row)",
];

pub const READ_SCHEMA_VERSION: &str = "SELECT value FROM meta WHERE key = 'schema_version'";

pub const WRITE_SCHEMA_VERSION: &str =
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)";

pub const READ_STAMPS: &str = "SELECT id, stamp FROM documents";

pub const FOLD_FUNCTION: &str = "ddd_fold";

pub fn fold(text: &str) -> String {
    text.to_lowercase()
}

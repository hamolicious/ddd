use serde::{Deserialize, Serialize};

use crate::document::{normalize_input, parse_document};
use crate::value::{Map, Value};

use super::extract::{BodyFacts, FmEntry, extract_body, fm_entries};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum SqlValue {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
}

impl SqlValue {
    fn text(value: &str) -> SqlValue {
        SqlValue::Text(value.to_string())
    }

    fn optional(value: &Option<String>) -> SqlValue {
        value.as_deref().map_or(SqlValue::Null, SqlValue::text)
    }

    fn flag(value: bool) -> SqlValue {
        SqlValue::Int(i64::from(value))
    }

    fn count(value: u32) -> SqlValue {
        SqlValue::Int(i64::from(value))
    }

    pub fn from_scalar(value: &Value) -> SqlValue {
        match value {
            Value::Null | Value::List(_) | Value::Map(_) => SqlValue::Null,
            Value::Bool(b) => SqlValue::flag(*b),
            Value::Int(i) => SqlValue::Int(*i),
            Value::Float(f) => SqlValue::Real(*f),
            Value::Str(s) => SqlValue::text(s),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Statement {
    pub sql: &'static str,
    pub params: Vec<SqlValue>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProjectionInput {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub fm: serde_json::Value,
    #[serde(default)]
    pub plugins: serde_json::Value,
    #[serde(default)]
    pub fm_parse_error: bool,
    #[serde(default)]
    pub materialized_version: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub created_by: Option<String>,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub updated_by: Option<String>,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub deleted_by: Option<String>,
    #[serde(default)]
    pub purged: bool,
    #[serde(default)]
    pub stamp: String,
}

#[derive(Debug, Clone)]
pub struct Projection {
    pub input: ProjectionInput,
    pub title: String,
    pub fm: Map,
    pub plugins: Map,
    pub fm_parse_error: bool,
    pub entries: Vec<FmEntry>,
    pub facts: BodyFacts,
}

pub fn project(input: ProjectionInput) -> Projection {
    let (title, fm, plugins, fm_parse_error, facts) = match input.content.as_deref() {
        Some(text) => {
            let parsed = parse_document(text);
            let normalized = normalize_input(text);
            let body = parsed.body_span.slice(&normalized);
            let first_line = 1 + normalized[..parsed.body_span.start].matches('\n').count() as u32;
            let facts = extract_body(&input.id, &parsed.fm, body, first_line);
            (parsed.title, parsed.fm, parsed.plugins, parsed.fm_parse_error, facts)
        }
        None => {
            let fm = json_map(&input.fm);
            let facts = extract_body(&input.id, &fm, "", 1);
            (input.title.clone(), fm, json_map(&input.plugins), input.fm_parse_error, facts)
        }
    };
    let entries = fm_entries(&fm);
    Projection {
        input,
        title,
        fm,
        plugins,
        fm_parse_error,
        entries,
        facts,
    }
}

fn json_map(value: &serde_json::Value) -> Map {
    match Value::from_json(value) {
        Value::Map(map) => map,
        _ => Map::new(),
    }
}

fn map_json(map: &Map) -> String {
    Value::Map(map.clone()).to_json().to_string()
}

const DELETE_DOCUMENT: &str = "DELETE FROM documents WHERE id = ?1";
const DELETE_FM: &str = "DELETE FROM fm WHERE doc = ?1";
const DELETE_LINKS: &str = "DELETE FROM link_refs WHERE doc = ?1";
const DELETE_TASKS: &str = "DELETE FROM tasks WHERE doc = ?1";
const DELETE_ATTACHMENTS: &str = "DELETE FROM attachments WHERE doc = ?1";

const INSERT_DOCUMENT: &str = "INSERT OR REPLACE INTO documents (
        id, title, content, fm, plugins, fm_parse_error, materialized_version,
        created_at, created_by, updated_at, updated_by, deleted, deleted_at, deleted_by,
        purged, words, characters, stamp
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)";
const INSERT_FM: &str = "INSERT INTO fm (doc, key, value, kind, position) VALUES (?1, ?2, ?3, ?4, ?5)";
const INSERT_LINK: &str =
    "INSERT INTO link_refs (doc, target, kind, key, count) VALUES (?1, ?2, ?3, ?4, ?5)";
const INSERT_TASK: &str =
    "INSERT INTO tasks (doc, line, state, marker, text) VALUES (?1, ?2, ?3, ?4, ?5)";
const INSERT_ATTACHMENT: &str = "INSERT INTO attachments (doc, attachment, line) VALUES (?1, ?2, ?3)";

fn clear_children(id: &str, out: &mut Vec<Statement>) {
    for sql in [DELETE_FM, DELETE_LINKS, DELETE_TASKS, DELETE_ATTACHMENTS] {
        out.push(Statement {
            sql,
            params: vec![SqlValue::text(id)],
        });
    }
}

pub fn remove_statements(id: &str) -> Vec<Statement> {
    let mut out = vec![Statement {
        sql: DELETE_DOCUMENT,
        params: vec![SqlValue::text(id)],
    }];
    clear_children(id, &mut out);
    out
}

impl Projection {
    pub fn statements(&self) -> Vec<Statement> {
        let input = &self.input;
        let id = input.id.as_str();
        let doc = || SqlValue::text(id);
        let mut out = Vec::with_capacity(
            6 + self.entries.len() + self.facts.references.len() + self.facts.tasks.len() + self.facts.attachments.len(),
        );
        clear_children(id, &mut out);
        out.push(Statement {
            sql: INSERT_DOCUMENT,
            params: vec![
                doc(),
                SqlValue::text(&self.title),
                SqlValue::text(input.content.as_deref().unwrap_or_default()),
                SqlValue::Text(map_json(&self.fm)),
                SqlValue::Text(map_json(&self.plugins)),
                SqlValue::flag(self.fm_parse_error),
                SqlValue::text(&input.materialized_version),
                SqlValue::text(&input.created_at),
                SqlValue::optional(&input.created_by),
                SqlValue::text(&input.updated_at),
                SqlValue::optional(&input.updated_by),
                SqlValue::flag(input.deleted),
                SqlValue::optional(&input.deleted_at),
                SqlValue::optional(&input.deleted_by),
                SqlValue::flag(false),
                SqlValue::count(self.facts.words),
                SqlValue::count(self.facts.characters),
                SqlValue::text(&input.stamp),
            ],
        });
        for entry in &self.entries {
            out.push(Statement {
                sql: INSERT_FM,
                params: vec![
                    doc(),
                    SqlValue::text(&entry.key),
                    SqlValue::from_scalar(&entry.value),
                    SqlValue::text(entry.kind.as_str()),
                    entry.position.map_or(SqlValue::Null, SqlValue::count),
                ],
            });
        }
        for reference in &self.facts.references {
            out.push(Statement {
                sql: INSERT_LINK,
                params: vec![
                    doc(),
                    SqlValue::text(&reference.target),
                    SqlValue::text(reference.kind.as_str()),
                    SqlValue::optional(&reference.key),
                    SqlValue::count(reference.count),
                ],
            });
        }
        for task in &self.facts.tasks {
            out.push(Statement {
                sql: INSERT_TASK,
                params: vec![
                    doc(),
                    SqlValue::count(task.line),
                    SqlValue::text(task.state.as_str()),
                    SqlValue::text(&task.marker),
                    SqlValue::text(&task.text),
                ],
            });
        }
        for attachment in &self.facts.attachments {
            out.push(Statement {
                sql: INSERT_ATTACHMENT,
                params: vec![doc(), SqlValue::text(&attachment.attachment), SqlValue::count(attachment.line)],
            });
        }
        out
    }
}

pub fn statements_for_rows(rows: Vec<ProjectionInput>) -> Vec<Statement> {
    let mut out = Vec::new();
    for row in rows {
        if row.purged {
            out.extend(remove_statements(&row.id));
        } else if !row.id.is_empty() {
            out.extend(project(row).statements());
        }
    }
    out
}

pub fn statements_for_json(rows_json: &str) -> Result<Vec<Statement>, serde_json::Error> {
    Ok(statements_for_rows(serde_json::from_str(rows_json)?))
}

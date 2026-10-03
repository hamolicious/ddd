use crate::limits::is_valid_key;

use super::plan::{PlanError, Source};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    NullText,
    Int,
    NullInt,
    Real,
    Bool,
    Date,
    NullDate,
    JsonMap,
    Json,
    FmValue,
    Value,
}

impl Kind {
    pub fn nullable(self) -> bool {
        !matches!(self, Kind::Text | Kind::Int | Kind::Real | Kind::Bool | Kind::Date)
    }

    pub fn decode(self) -> Decode {
        match self {
            Kind::Bool => Decode::Bool,
            Kind::JsonMap | Kind::Json | Kind::FmValue => Decode::Json,
            _ => Decode::Plain,
        }
    }

    pub fn materialized(self) -> Kind {
        match self {
            Kind::FmValue => Kind::Json,
            other => other,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Decode {
    Plain,
    Bool,
    Json,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    pub name: String,
    pub sql: String,
    pub kind: Kind,
    pub path: Option<String>,
    pub companion: Option<String>,
}

impl Column {
    fn plain(name: &str, sql: String, kind: Kind) -> Column {
        Column {
            name: name.to_string(),
            sql,
            kind,
            path: None,
            companion: None,
        }
    }

    pub fn value_sql(&self) -> String {
        match (self.kind, &self.path) {
            (Kind::Json, Some(path)) => format!("json_extract({}, '{path}')", self.sql),
            (Kind::Json, None) => format!("json_extract({}, '$')", self.sql),
            _ => self.sql.clone(),
        }
    }

    pub fn type_sql(&self) -> Option<String> {
        match self.kind {
            Kind::Json => Some(match &self.path {
                Some(path) => format!("json_type({}, '{path}')", self.sql),
                None => format!("json_type({}, '$')", self.sql),
            }),
            Kind::FmValue => {
                let kind = self.companion.as_deref().unwrap_or("kind");
                let value = &self.sql;
                Some(format!(
                    "(CASE {kind} WHEN 'boolean' THEN (CASE WHEN {value} THEN 'true' ELSE 'false' END) \
                     WHEN 'null' THEN 'null' WHEN 'number' THEN typeof({value}) ELSE 'text' END)"
                ))
            }
            Kind::Value => Some(format!("nullif(typeof({}), 'null')", self.sql)),
            _ => None,
        }
    }

    pub fn output_sql(&self) -> String {
        match (self.kind, &self.path) {
            (Kind::Json, Some(path)) => format!("({} -> '{path}')", self.sql),
            (Kind::FmValue, _) => {
                let kind = self.companion.as_deref().unwrap_or("kind");
                let value = &self.sql;
                format!(
                    "(CASE {kind} WHEN 'boolean' THEN (CASE WHEN {value} THEN 'true' ELSE 'false' END) \
                     WHEN 'null' THEN 'null' ELSE json_quote({value}) END)"
                )
            }
            _ => self.sql.clone(),
        }
    }

    pub fn list_sql(&self) -> Option<(String, String)> {
        match self.kind {
            Kind::Json => Some((
                self.sql.clone(),
                self.path.clone().unwrap_or_else(|| "$".to_string()),
            )),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Scope {
    pub columns: Vec<Column>,
}

pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn json_path(segments: &[&str]) -> String {
    let mut path = String::from("$");
    for segment in segments {
        path.push_str(".\"");
        path.push_str(segment);
        path.push('"');
    }
    path
}

impl Scope {
    pub fn get(&self, name: &str) -> Option<&Column> {
        self.columns.iter().find(|c| c.name == name)
    }

    pub fn resolve(&self, field: &str) -> Result<Column, PlanError> {
        if let Some(column) = self.get(field) {
            return Ok(column.clone());
        }
        let segments: Vec<&str> = field.split('.').collect();
        for split in (1..segments.len()).rev() {
            let prefix = segments[..split].join(".");
            let Some(base) = self.get(&prefix) else {
                continue;
            };
            if base.kind != Kind::JsonMap {
                break;
            }
            let rest = &segments[split..];
            if !rest.iter().all(|segment| is_valid_key(segment)) {
                return Err(PlanError::UnknownField(field.to_string()));
            }
            return Ok(Column {
                name: field.to_string(),
                sql: base.sql.clone(),
                kind: Kind::Json,
                path: Some(json_path(rest)),
                companion: None,
            });
        }
        Err(PlanError::UnknownField(field.to_string()))
    }
}

pub const DOCUMENT_COLUMNS: &[(&str, Kind)] = &[
    ("id", Kind::Text),
    ("title", Kind::Text),
    ("content", Kind::Text),
    ("fm", Kind::JsonMap),
    ("plugins", Kind::JsonMap),
    ("fm_parse_error", Kind::Bool),
    ("materialized_version", Kind::Text),
    ("created_at", Kind::Date),
    ("created_by", Kind::NullText),
    ("updated_at", Kind::Date),
    ("updated_by", Kind::NullText),
    ("deleted", Kind::Bool),
    ("deleted_at", Kind::NullDate),
    ("deleted_by", Kind::NullText),
    ("purged", Kind::Bool),
    ("words", Kind::Int),
    ("characters", Kind::Int),
];

pub const DEFAULT_DOCUMENT_ROW: &[&str] = &[
    "id",
    "title",
    "fm",
    "plugins",
    "fm_parse_error",
    "materialized_version",
    "created_at",
    "created_by",
    "updated_at",
    "updated_by",
    "deleted",
    "deleted_at",
    "deleted_by",
    "purged",
];

pub struct SourceTable {
    pub from: &'static str,
    pub columns: &'static [(&'static str, Kind, &'static str)],
}

pub fn source_table(source: Source) -> Option<SourceTable> {
    match source {
        Source::Documents => None,
        Source::Fm => Some(SourceTable {
            from: "fm s JOIN documents d ON d.id = s.doc",
            columns: &[
                ("key", Kind::Text, "s.key"),
                ("value", Kind::FmValue, "s.value"),
                ("kind", Kind::Text, "s.kind"),
                ("position", Kind::NullInt, "s.position"),
            ],
        }),
        Source::Links => Some(SourceTable {
            from: "link_refs s JOIN documents d ON d.id = s.doc LEFT JOIN documents t ON t.id = s.target",
            columns: &[
                ("target", Kind::Text, "s.target"),
                ("kind", Kind::Text, "s.kind"),
                ("key", Kind::NullText, "s.key"),
                ("count", Kind::Int, "s.count"),
                (
                    "state",
                    Kind::Text,
                    "(CASE WHEN t.id IS NULL THEN 'missing' WHEN t.deleted THEN 'trashed' ELSE 'live' END)",
                ),
            ],
        }),
        Source::Tasks => Some(SourceTable {
            from: "tasks s JOIN documents d ON d.id = s.doc",
            columns: &[
                ("line", Kind::Int, "s.line"),
                ("state", Kind::Text, "s.state"),
                ("marker", Kind::Text, "s.marker"),
                ("text", Kind::Text, "s.text"),
            ],
        }),
        Source::Attachments => Some(SourceTable {
            from: "attachments s JOIN documents d ON d.id = s.doc",
            columns: &[("attachment", Kind::Text, "s.attachment"), ("line", Kind::Int, "s.line")],
        }),
    }
}

pub const ROW_KEY: &str = "_rid";

pub fn base_scope(source: Source) -> (String, Scope) {
    let mut scope = Scope::default();
    match source_table(source) {
        None => {
            for (name, kind) in DOCUMENT_COLUMNS {
                scope.columns.push(Column::plain(name, format!("d.{name}"), *kind));
            }
            ("documents d".to_string(), scope)
        }
        Some(table) => {
            for (name, kind, sql) in table.columns {
                let mut column = Column::plain(name, (*sql).to_string(), *kind);
                if *kind == Kind::FmValue {
                    column.companion = Some("s.kind".into());
                }
                scope.columns.push(column);
            }
            for (name, kind) in DOCUMENT_COLUMNS {
                scope
                    .columns
                    .push(Column::plain(&format!("doc.{name}"), format!("d.{name}"), *kind));
            }
            scope
                .columns
                .push(Column::plain(ROW_KEY, "s.rowid".to_string(), Kind::Int));
            (table.from.to_string(), scope)
        }
    }
}

pub fn trash_column(source: Source) -> &'static str {
    match source {
        Source::Documents => "deleted",
        _ => "doc.deleted",
    }
}

pub fn document_id(scope: &Scope, source: Source) -> Result<Column, PlanError> {
    scope.resolve(match source {
        Source::Documents => "id",
        _ => "doc.id",
    })
}

pub fn document_content(scope: &Scope, source: Source) -> Result<Column, PlanError> {
    scope.resolve(match source {
        Source::Documents => "content",
        _ => "doc.content",
    })
}

pub fn tiebreak(scope: &Scope, source: Source) -> Option<Column> {
    let key = match source {
        Source::Documents => "id",
        _ => ROW_KEY,
    };
    scope.get(key).cloned()
}

use rusqlite::{Connection, params_from_iter, types::Value as Sql};

use super::*;

pub(crate) fn open() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .create_scalar_function(
            FOLD_FUNCTION,
            1,
            rusqlite::functions::FunctionFlags::SQLITE_UTF8
                | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
            |context| Ok(context.get::<Option<String>>(0)?.map(|text| fold(&text))),
        )
        .unwrap();
    for sql in SCHEMA {
        connection.execute(sql, []).unwrap();
    }
    connection
        .execute(WRITE_SCHEMA_VERSION, [SEARCH_SCHEMA_VERSION.to_string()])
        .unwrap();
    connection
}

fn bind(value: &SqlValue) -> Sql {
    match value {
        SqlValue::Null => Sql::Null,
        SqlValue::Int(i) => Sql::Integer(*i),
        SqlValue::Real(f) => Sql::Real(*f),
        SqlValue::Text(s) => Sql::Text(s.clone()),
    }
}

pub(crate) fn apply(connection: &mut Connection, statements: &[Statement]) {
    let tx = connection.transaction().unwrap();
    for statement in statements {
        tx.prepare_cached(statement.sql)
            .unwrap()
            .execute(params_from_iter(statement.params.iter().map(bind)))
            .unwrap();
    }
    tx.commit().unwrap();
}

pub(crate) fn row(id: &str, content: &str) -> ProjectionInput {
    ProjectionInput {
        id: id.to_string(),
        content: Some(content.to_string()),
        materialized_version: "1".into(),
        created_at: "2026-10-01T00:00:00Z".into(),
        updated_at: "2026-10-02T00:00:00Z".into(),
        stamp: format!("{id}-stamp"),
        ..ProjectionInput::default()
    }
}

fn strings(connection: &Connection, sql: &str) -> Vec<String> {
    let mut statement = connection.prepare(sql).unwrap();
    statement
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn schema_version_is_recorded() {
    let connection = open();
    let version: String = connection
        .query_row(READ_SCHEMA_VERSION, [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, SEARCH_SCHEMA_VERSION.to_string());
}

#[test]
fn a_document_fills_every_source_from_its_text() {
    let mut connection = open();
    let text = "---\ntitle: Plan\nstatus: open\ntags: [a, b]\nparent: doc://P\n---\n\n# Plan\n\n- [ ] write it\n- [x] think\n\nSee [x](doc://B) and ![f](attachment://01J0000000000000000000000A)\n";
    apply(
        &mut connection,
        &statements_for_rows(vec![row("A", text), row("B", "# B\n")]),
    );

    let (title, words, fm): (String, i64, String) = connection
        .query_row(
            "SELECT title, words, fm FROM documents WHERE id = 'A'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(title, "Plan");
    assert_eq!(words, 9);
    assert!(fm.contains("\"status\":\"open\""));

    assert_eq!(
        strings(
            &connection,
            "SELECT key || '=' || value || ':' || kind || ':' || coalesce(position, '-') FROM fm WHERE doc = 'A' ORDER BY key, position"
        ),
        vec![
            "parent=doc://P:string:-",
            "status=open:string:-",
            "tags=a:string:0",
            "tags=b:string:1",
            "title=Plan:string:-"
        ]
    );
    assert_eq!(
        strings(
            &connection,
            "SELECT state || ':' || line || ':' || text FROM tasks WHERE doc = 'A' ORDER BY line"
        ),
        vec!["open:10:write it", "done:11:think"]
    );
    assert_eq!(
        strings(
            &connection,
            "SELECT target || ':' || kind || ':' || state FROM links WHERE doc = 'A' ORDER BY target"
        ),
        vec!["B:link:live", "P:frontmatter:missing"]
    );
    assert_eq!(
        strings(
            &connection,
            "SELECT attachment || ':' || line FROM attachments WHERE doc = 'A'"
        ),
        vec!["01J0000000000000000000000A:13"]
    );
}

#[test]
fn reprojecting_replaces_every_row_of_the_document() {
    let mut connection = open();
    apply(
        &mut connection,
        &statements_for_rows(vec![row("A", "- [ ] one\n- [ ] two\n")]),
    );
    apply(
        &mut connection,
        &statements_for_rows(vec![row("A", "- [x] one\n")]),
    );
    assert_eq!(
        strings(&connection, "SELECT state FROM tasks"),
        vec!["done"]
    );
    let count: i64 = connection
        .query_row("SELECT count(*) FROM documents", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn purging_removes_the_document_everywhere() {
    let mut connection = open();
    apply(
        &mut connection,
        &statements_for_rows(vec![row("A", "---\nk: v\n---\n- [ ] t\n[l](doc://B)\n")]),
    );
    let purged = ProjectionInput {
        purged: true,
        ..row("A", "")
    };
    apply(&mut connection, &statements_for_rows(vec![purged]));
    for table in ["documents", "fm", "link_refs", "tasks", "attachments"] {
        let count: i64 = connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "{table}");
    }
}

#[test]
fn trashed_targets_show_in_link_state() {
    let mut connection = open();
    let trashed = ProjectionInput {
        deleted: true,
        deleted_at: Some("2026-10-02T00:00:00Z".into()),
        ..row("B", "# B\n")
    };
    apply(
        &mut connection,
        &statements_for_rows(vec![row("A", "[b](doc://B)\n"), trashed]),
    );
    assert_eq!(
        strings(&connection, "SELECT state FROM links"),
        vec!["trashed"]
    );
}

#[test]
fn a_row_without_text_keeps_its_stored_fields() {
    let mut connection = open();
    let input = ProjectionInput {
        content: None,
        title: "Stored".into(),
        fm: serde_json::json!({ "status": "done", "when": "2026-10-03" }),
        ..row("A", "")
    };
    apply(&mut connection, &statements_for_rows(vec![input]));
    assert_eq!(
        strings(&connection, "SELECT title FROM documents"),
        vec!["Stored"]
    );
    assert_eq!(
        strings(
            &connection,
            "SELECT key || ':' || kind FROM fm ORDER BY key"
        ),
        vec!["status:string", "when:date"]
    );
}

#[test]
fn frontmatter_values_keep_their_sql_types() {
    let mut connection = open();
    apply(
        &mut connection,
        &statements_for_rows(vec![row("A", "---\nn: 3\nf: 1.5\nb: true\nz: null\n---\n")]),
    );
    assert_eq!(
        strings(
            &connection,
            "SELECT key || ':' || typeof(value) FROM fm ORDER BY key"
        ),
        vec!["b:integer", "f:real", "n:integer", "z:null"]
    );
}

#[test]
fn rows_parse_from_the_kernel_projection_json() {
    let json = r##"[{"id":"A","title":"t","content":"# A\n","fm":{},"plugins":{},"fm_parse_error":false,
        "materialized_version":"local","created_at":"2026-10-01T00:00:00Z","created_by":"u",
        "updated_at":"2026-10-01T00:00:00Z","updated_by":null,"deleted":false,"deleted_at":null,
        "deleted_by":null,"purged":false,"seq":0,"local":true,"stamp":"s"}]"##;
    let mut connection = open();
    apply(&mut connection, &statements_for_json(json).unwrap());
    assert_eq!(
        strings(&connection, "SELECT materialized_version FROM documents"),
        vec!["local"]
    );
}

#[derive(serde::Deserialize)]
struct Fixture {
    name: String,
    id: String,
    text: String,
    expected: Expected,
}

#[derive(serde::Deserialize)]
struct Expected {
    words: u32,
    characters: u32,
    tasks: TaskCounts,
    references: Vec<ExpectedReference>,
    attachments: Vec<String>,
}

#[derive(serde::Deserialize, Debug, PartialEq, Default)]
struct TaskCounts {
    open: u32,
    done: u32,
    other: u32,
}

#[derive(serde::Deserialize, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct ExpectedReference {
    id: String,
    kind: String,
    key: Option<String>,
    count: u32,
}

#[test]
fn extraction_agrees_with_the_indexer_fixtures() {
    let fixtures: Vec<Fixture> = serde_json::from_str(include_str!(
        "../../../../../schema/fixtures/search-extract.json"
    ))
    .unwrap();
    assert!(fixtures.len() > 5);
    for fixture in fixtures {
        let projection = project(row(&fixture.id, &fixture.text));
        let facts = &projection.facts;
        let mut tasks = TaskCounts::default();
        for task in &facts.tasks {
            match task.state {
                TaskState::Open => tasks.open += 1,
                TaskState::Done => tasks.done += 1,
                TaskState::Other => tasks.other += 1,
            }
        }
        let mut references: Vec<_> = facts
            .references
            .iter()
            .map(|r| ExpectedReference {
                id: r.target.clone(),
                kind: r.kind.as_str().to_string(),
                key: r.key.clone(),
                count: r.count,
            })
            .collect();
        references.sort();
        let mut expected_references = fixture.expected.references;
        expected_references.sort();
        let mut attachments: Vec<_> = facts
            .attachments
            .iter()
            .map(|a| a.attachment.clone())
            .collect();
        attachments.sort();
        attachments.dedup();
        let name = &fixture.name;
        assert_eq!(facts.words, fixture.expected.words, "{name}: words");
        assert_eq!(
            facts.characters, fixture.expected.characters,
            "{name}: characters"
        );
        assert_eq!(tasks, fixture.expected.tasks, "{name}: tasks");
        assert_eq!(references, expected_references, "{name}: references");
        assert_eq!(
            attachments, fixture.expected.attachments,
            "{name}: attachments"
        );
    }
}

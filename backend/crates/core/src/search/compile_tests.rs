use rusqlite::{Connection, params_from_iter, types::Value as Sql};
use serde_json::{Value as Json, json};

use super::tests::{apply, open, row};
use super::*;

fn bind(value: &SqlValue) -> Sql {
    match value {
        SqlValue::Null => Sql::Null,
        SqlValue::Int(i) => Sql::Integer(*i),
        SqlValue::Real(f) => Sql::Real(*f),
        SqlValue::Text(s) => Sql::Text(s.clone()),
    }
}

fn sql_json(value: Sql) -> Json {
    match value {
        Sql::Null => Json::Null,
        Sql::Integer(i) => json!(i),
        Sql::Real(f) => json!(f),
        Sql::Text(s) => json!(s),
        Sql::Blob(_) => Json::Null,
    }
}

fn sql_value(value: &Sql) -> SqlValue {
    match value {
        Sql::Integer(i) => SqlValue::Int(*i),
        Sql::Real(f) => SqlValue::Real(*f),
        Sql::Text(s) => SqlValue::Text(s.clone()),
        _ => SqlValue::Null,
    }
}

struct Page {
    rows: Vec<Json>,
    total: Option<i64>,
    next: Option<String>,
    hits: serde_json::Map<String, Json>,
}

fn decode(column: &OutputColumn, value: Sql) -> Json {
    match (column.decode, value) {
        (Decode::Bool, Sql::Integer(i)) => json!(i != 0),
        (Decode::Json, Sql::Text(text)) => serde_json::from_str(&text).unwrap(),
        (_, other) => sql_json(other),
    }
}

fn run(connection: &Connection, plan: Json) -> Page {
    let plan: Plan = serde_json::from_value(plan).unwrap();
    let mut compiled = compile(&plan).unwrap_or_else(|e| panic!("{e}"));
    if let Some(vocabulary) = &compiled.vocabulary {
        let mut statement = connection
            .prepare(&vocabulary.sql)
            .unwrap_or_else(|e| panic!("{e}\n{}", vocabulary.sql));
        let words: Vec<String> = statement
            .query_map(params_from_iter(vocabulary.params.iter().map(bind)), |r| {
                r.get(0)
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        compiled = compile(&expand_plan(&plan, &words)).unwrap_or_else(|e| panic!("{e}"));
    }
    let mut statement = connection
        .prepare(&compiled.sql)
        .unwrap_or_else(|e| panic!("{e}\n{}", compiled.sql));
    let keys = compiled.columns.len();
    let snippet_at = keys + compiled.cursor_columns;
    let hits_at = snippet_at + usize::from(compiled.snippets);
    let width = hits_at + if compiled.hits { 3 } else { 0 };
    let raw: Vec<Vec<Sql>> = statement
        .query_map(params_from_iter(compiled.params.iter().map(bind)), |r| {
            (0..width).map(|i| r.get::<_, Sql>(i)).collect()
        })
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let mut raw = raw;
    let mut hits = serde_json::Map::new();
    if compiled.hits {
        for values in &raw {
            if let (Sql::Text(id), Sql::Real(score)) = (&values[hits_at], &values[hits_at + 1]) {
                let terms: Json = match &values[hits_at + 2] {
                    Sql::Text(text) => serde_json::from_str(text).unwrap(),
                    _ => json!([]),
                };
                hits.insert(id.clone(), json!({ "score": score, "terms": terms }));
            }
        }
    }
    let mut next = None;
    if let Some(size) = compiled.page_size
        && raw.len() as u64 > size
    {
        raw.truncate(size as usize);
        if compiled.cursor_columns > 0 {
            let last = raw.last().unwrap();
            let keys: Vec<SqlValue> = last[keys..snippet_at].iter().map(sql_value).collect();
            next = Some(encode_cursor(&keys));
        }
    }
    let rows = raw
        .into_iter()
        .map(|values| {
            let mut object = serde_json::Map::new();
            if compiled.snippets {
                let source = match values.get(snippet_at) {
                    Some(Sql::Text(text)) => Some(text.clone()),
                    _ => None,
                };
                let found = source.and_then(|text| snippet(&text, &compiled.terms));
                object.insert("snippet".into(), serde_json::to_value(found).unwrap());
            }
            for (column, value) in compiled.columns.iter().zip(values) {
                let decoded = decode(column, value);
                match column.path.as_slice() {
                    [key] => {
                        object.insert(key.clone(), decoded);
                    }
                    [outer, inner] => {
                        object
                            .entry(outer.clone())
                            .or_insert_with(|| json!({}))
                            .as_object_mut()
                            .unwrap()
                            .insert(inner.clone(), decoded);
                    }
                    _ => unreachable!(),
                }
            }
            Json::Object(object)
        })
        .collect();
    let total = compiled.total.map(|total| {
        connection
            .query_row(
                &total.sql,
                params_from_iter(total.params.iter().map(bind)),
                |r| r.get(0),
            )
            .unwrap_or_else(|e| panic!("{e}\n{}", total.sql))
    });
    Page {
        rows,
        total,
        next,
        hits,
    }
}

fn error(plan: Json) -> PlanError {
    let plan: Plan = serde_json::from_value(plan).unwrap();
    compile(&plan).unwrap_err()
}

fn ids(page: &Page) -> Vec<String> {
    page.rows
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_string())
        .collect()
}

fn corpus() -> Connection {
    let mut connection = open();
    let mut rows = vec![
        row(
            "A",
            "---\nstatus: open\nclient: acme\npriority: 2\ntags: [x, y]\ndue: 2026-10-05\n---\n# Alpha\n\n- [ ] one\n- [x] two\n[b](doc://B)\n",
        ),
        row(
            "B",
            "---\nstatus: draft\nclient: acme\npriority: 5\ntags: [y]\nflag: true\n---\n# Beta\n\n- [ ] three\n",
        ),
        row(
            "C",
            "---\nstatus: open\nclient: zeta\npriority: 1.5\ntags: []\nnote: null\n---\n# Gamma\n\n[gone](doc://Z)\n",
        ),
        row("D", "---\nstatus: done\npriority: \"7\"\n---\n# Delta\n"),
        row(
            "F",
            "---\ntitle: Folder\n---\n# Folder\n\n%%% folders\nchildren: [A, S]\n%%%\n",
        ),
        row("S", "# Sub\n\n%%% folders\nchildren: [C]\n%%%\n"),
    ];
    rows[1].updated_at = "2026-10-04T00:00:00Z".into();
    rows[2].updated_at = "2026-10-03T00:00:00.000Z".into();
    rows[3].deleted = true;
    rows[3].deleted_at = Some("2026-10-04T00:00:00Z".into());
    apply(&mut connection, &statements_for_rows(rows));
    connection
}

fn cmp(field: &str, op: &str, value: Json) -> Json {
    json!({ "cmp": { "field": field, "op": op, "value": value } })
}

#[test]
fn the_default_row_is_a_document_row_without_content() {
    let page = run(
        &corpus(),
        json!({ "stages": [{ "where": cmp("id", "eq", json!({"str": "A"})) }] }),
    );
    let row = &page.rows[0];
    assert_eq!(row["title"], "Alpha");
    assert_eq!(row["fm"]["tags"], json!(["x", "y"]));
    assert_eq!(row["deleted"], json!(false));
    assert!(row.get("content").is_none());
    let page = run(
        &corpus(),
        json!({ "stages": [{ "where": cmp("id", "eq", json!({"str": "A"})) }, "with_content"] }),
    );
    assert!(
        page.rows[0]["content"]
            .as_str()
            .unwrap()
            .contains("# Alpha")
    );
}

#[test]
fn live_trashed_and_all_scopes() {
    let connection = corpus();
    assert_eq!(ids(&run(&connection, json!({}))), ["A", "B", "C", "F", "S"]);
    assert_eq!(
        ids(&run(
            &connection,
            json!({ "stages": [{ "trash": "trashed" }] })
        )),
        ["D"]
    );
    assert_eq!(
        ids(&run(&connection, json!({ "stages": [{ "trash": "all" }] }))).len(),
        6
    );
}

#[test]
fn frontmatter_comparisons_keep_their_types() {
    let connection = corpus();
    let q = |cond: Json| ids(&run(&connection, json!({ "stages": [{ "where": cond }] })));
    assert_eq!(
        q(cmp("fm.status", "eq", json!({"str": "open"}))),
        ["A", "C"]
    );
    assert_eq!(q(cmp("fm.status", "ne", json!({"str": "open"}))), ["B"]);
    assert_eq!(q(cmp("fm.priority", "gte", json!({"int": 2}))), ["A", "B"]);
    assert_eq!(q(cmp("fm.priority", "lt", json!({"int": 2}))), ["C"]);
    assert_eq!(
        ids(&run(
            &connection,
            json!({ "stages": [{ "trash": "all" }, { "where": cmp("fm.priority", "eq", json!({"str": "7"})) }] })
        )),
        ["D"]
    );
    assert_eq!(q(cmp("fm.flag", "eq", json!({"bool": true}))), ["B"]);
    assert_eq!(q(cmp("fm.note", "eq", json!("null"))), ["C"]);
    assert_eq!(q(cmp("fm.due", "gt", json!({"date": "2026-10-01"}))), ["A"]);
    assert_eq!(
        q(json!({ "missing": { "field": "fm.client" } })),
        ["F", "S"]
    );
    assert_eq!(q(json!({ "is_null": { "field": "fm.note" } })), ["C"]);
    assert_eq!(
        q(json!({ "not": cmp("fm.status", "eq", json!({"str": "open"})) })),
        ["B", "F", "S"]
    );
}

#[test]
fn list_operators() {
    let connection = corpus();
    let q = |cond: Json| ids(&run(&connection, json!({ "stages": [{ "where": cond }] })));
    assert_eq!(
        q(json!({ "contains": { "field": "fm.tags", "value": {"str": "y"} } })),
        ["A", "B"]
    );
    assert_eq!(
        q(
            json!({ "contains_any": { "field": "fm.tags", "values": [{"str": "x"}, {"str": "q"}] } })
        ),
        ["A"]
    );
    assert_eq!(
        q(json!({ "every": { "field": "fm.tags", "op": "eq", "value": {"str": "y"} } })),
        ["B", "C"]
    );
    assert_eq!(
        q(json!({ "any": { "field": "fm.tags", "op": "ne", "value": {"str": "y"} } })),
        ["A"]
    );
}

#[test]
fn text_operators_ignore_case() {
    let connection = corpus();
    let q = |cond: Json| ids(&run(&connection, json!({ "stages": [{ "where": cond }] })));
    let text = |field: &str, mode: &str, value: &str| json!({ "text": { "field": field, "mode": mode, "value": value } });
    assert_eq!(q(text("title", "contains", "ELT")), Vec::<String>::new());
    assert_eq!(q(text("title", "starts_with", "AL")), ["A"]);
    assert_eq!(q(text("title", "ends_with", "MMA")), ["C"]);
    assert_eq!(q(text("fm.client", "contains", "CM")), ["A", "B"]);
}

#[test]
fn and_or_combine() {
    let connection = corpus();
    let cond = json!({ "or": [
        cmp("fm.status", "eq", json!({"str": "draft"})),
        { "and": [cmp("fm.status", "eq", json!({"str": "open"})), cmp("fm.client", "eq", json!({"str": "zeta"}))] }
    ]});
    assert_eq!(
        ids(&run(&connection, json!({ "stages": [{ "where": cond }] }))),
        ["B", "C"]
    );
}

#[test]
fn folder_relations() {
    let connection = corpus();
    let q = |cond: Json| ids(&run(&connection, json!({ "stages": [{ "where": cond }] })));
    assert_eq!(q(json!({ "child_of": { "of": "F" } })), ["A", "S"]);
    assert_eq!(
        q(json!({ "child_of": { "of": "F", "deep": true } })),
        ["A", "C", "S"]
    );
    assert_eq!(q(json!({ "parent_of": { "of": "C" } })), ["S"]);
}

#[test]
fn sorting_puts_missing_values_last_either_way() {
    let connection = corpus();
    let q = |key: &str| ids(&run(&connection, json!({ "stages": [{ "sort": [key] }] })));
    assert_eq!(q("fm.priority"), ["C", "A", "B", "F", "S"]);
    assert_eq!(q("-fm.priority"), ["B", "A", "C", "F", "S"]);
    assert_eq!(q("-updated_at"), ["B", "C", "A", "F", "S"]);
}

#[test]
fn select_narrows_and_renames() {
    let page = run(
        &corpus(),
        json!({ "stages": [
            { "where": cmp("fm.client", "eq", json!({"str": "acme"})) },
            { "sort": ["-fm.priority"] },
            { "select": [{ "field": "id" }, { "field": "fm.client", "as": "client" }, { "field": "fm.tags" }] }
        ]}),
    );
    assert_eq!(
        page.rows,
        vec![
            json!({ "id": "B", "client": "acme", "fm.tags": ["y"] }),
            json!({ "id": "A", "client": "acme", "fm.tags": ["x", "y"] }),
        ]
    );
}

#[test]
fn stages_run_in_order() {
    let connection = corpus();
    let first_two_then_open = run(
        &connection,
        json!({ "stages": [{ "limit": 2 }, { "where": cmp("fm.status", "eq", json!({"str": "open"})) }] }),
    );
    assert_eq!(ids(&first_two_then_open), ["A"]);
    let open_then_first_two = run(
        &connection,
        json!({ "stages": [{ "where": cmp("fm.status", "eq", json!({"str": "open"})) }, { "limit": 2 }] }),
    );
    assert_eq!(ids(&open_then_first_two), ["A", "C"]);
    let renamed = run(
        &connection,
        json!({ "stages": [
            { "select": [{ "field": "id" }, { "field": "fm.priority", "as": "p" }] },
            { "where": cmp("p", "gt", json!({"int": 1})) },
            { "sort": ["-p"] }
        ]}),
    );
    assert_eq!(ids(&renamed), ["B", "A", "C"]);
}

#[test]
fn later_sorts_keep_earlier_ones_as_tiebreakers() {
    let page = run(
        &corpus(),
        json!({ "stages": [{ "sort": ["-fm.priority"] }, { "sort": ["fm.client"] }] }),
    );
    assert_eq!(ids(&page), ["B", "A", "C", "F", "S"]);
}

#[test]
fn offset_limit_and_total() {
    let page = run(
        &corpus(),
        json!({ "stages": [{ "sort": ["id"] }, { "offset": 1 }, { "limit": 2 }, "with_total"] }),
    );
    assert_eq!(ids(&page), ["B", "C"]);
    assert_eq!(page.total, Some(5));
    assert!(run(&corpus(), json!({})).total.is_none());
}

#[test]
fn cursors_walk_every_row_once() {
    let connection = corpus();
    for sort in ["fm.priority", "-fm.priority", "title", "-updated_at"] {
        let mut seen = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut stages = vec![json!({ "sort": [sort] })];
            if let Some(cursor) = &cursor {
                stages.push(json!({ "cursor": cursor }));
            }
            stages.push(json!({ "limit": 2 }));
            let page = run(&connection, json!({ "stages": stages }));
            seen.extend(ids(&page));
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        let all = ids(&run(&connection, json!({ "stages": [{ "sort": [sort] }] })));
        assert_eq!(seen, all, "{sort}");
    }
}

#[test]
fn other_sources_reach_their_document() {
    let connection = corpus();
    let tasks = run(
        &connection,
        json!({ "source": "tasks", "stages": [{ "where": cmp("state", "eq", json!({"str": "open"})) }, { "sort": ["text"] }] }),
    );
    assert_eq!(tasks.rows.len(), 2);
    assert_eq!(tasks.rows[0]["text"], "one");
    assert_eq!(tasks.rows[0]["doc"]["title"], "Alpha");
    assert_eq!(tasks.rows[1]["doc"]["fm"]["status"], "draft");

    let broken = run(
        &connection,
        json!({ "source": "links", "stages": [
            { "where": cmp("state", "eq", json!({"str": "missing"})) },
            { "select": [{ "field": "doc.id" }, { "field": "doc.title" }, { "field": "target" }] }
        ]}),
    );
    assert_eq!(
        broken.rows,
        vec![json!({ "doc.id": "C", "doc.title": "Gamma", "target": "Z" })]
    );

    let values = run(
        &connection,
        json!({ "source": "fm", "stages": [
            { "where": cmp("key", "eq", json!({"str": "priority"})) },
            { "where": cmp("value", "gt", json!({"int": 1})) },
            { "select": [{ "field": "doc.id" }, { "field": "value" }, { "field": "kind" }] },
            { "sort": ["doc.id"] }
        ]}),
    );
    assert_eq!(
        values.rows,
        vec![
            json!({ "doc.id": "A", "value": 2, "kind": "number" }),
            json!({ "doc.id": "B", "value": 5, "kind": "number" }),
            json!({ "doc.id": "C", "value": 1.5, "kind": "number" }),
        ]
    );
}

#[test]
fn bad_plans_are_typed_errors() {
    assert!(matches!(
        error(json!({ "stages": [{ "where": cmp("nope", "eq", json!({"str": "x"})) }] })),
        PlanError::UnknownField(_)
    ));
    assert!(matches!(
        error(json!({ "stages": [{ "where": cmp("title", "eq", json!({"int": 1})) }] })),
        PlanError::BadValue(_)
    ));
    assert!(matches!(
        error(json!({ "stages": [{ "where": cmp("deleted", "gt", json!({"bool": true})) }] })),
        PlanError::BadOperator(_)
    ));
    assert!(matches!(
        error(json!({ "stages": [{ "offset": 1 }, { "cursor": "W10" }] })),
        PlanError::BadStage(_)
    ));
    assert!(matches!(
        error(json!({ "stages": [{ "limit": 2_000_000 }] })),
        PlanError::Limit(_)
    ));
    assert!(matches!(
        error(
            json!({ "stages": [{ "select": [{ "field": "id" }] }, { "where": cmp("title", "eq", json!({"str": "x"})) }] })
        ),
        PlanError::UnknownField(_)
    ));
    assert!(matches!(
        error(json!({ "source": "tasks", "stages": ["with_content"] })),
        PlanError::BadStage(_)
    ));
}

#[derive(serde::Deserialize)]
struct Corpus {
    documents: Vec<CorpusDocument>,
    cases: Vec<CorpusCase>,
    errors: Vec<CorpusError>,
}

#[derive(serde::Deserialize)]
struct CorpusDocument {
    id: String,
    content: String,
    updated_at: String,
    #[serde(default)]
    deleted: bool,
}

#[derive(serde::Deserialize)]
struct CorpusCase {
    name: String,
    plan: Json,
    #[serde(default)]
    ids: Option<Vec<String>>,
    #[serde(default)]
    rows: Option<Vec<Json>>,
    #[serde(default)]
    total: Option<i64>,
}

#[derive(serde::Deserialize)]
struct CorpusError {
    name: String,
    plan: Json,
    kind: String,
}

#[test]
fn the_search_corpus_holds_natively() {
    let corpus: Corpus = serde_json::from_str(include_str!("../../corpus/search.json")).unwrap();
    let mut connection = open();
    let rows = corpus
        .documents
        .iter()
        .map(|document| ProjectionInput {
            updated_at: document.updated_at.clone(),
            deleted: document.deleted,
            deleted_at: document.deleted.then(|| document.updated_at.clone()),
            ..row(&document.id, &document.content)
        })
        .collect();
    apply(&mut connection, &statements_for_rows(rows));
    for case in corpus.cases {
        let page = run(&connection, case.plan);
        if let Some(expected) = case.ids {
            assert_eq!(ids(&page), expected, "{}", case.name);
        }
        if let Some(expected) = case.rows {
            assert_eq!(page.rows, expected, "{}", case.name);
        }
        assert_eq!(page.total, case.total, "{}", case.name);
    }
    for case in corpus.errors {
        let error = Plan::from_json_str(&case.plan.to_string())
            .and_then(|plan| compile(&plan))
            .unwrap_err();
        let kind = serde_json::to_value(&error).unwrap()["kind"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(kind, case.kind, "{}", case.name);
    }
}

#[test]
fn fuzzy_hits_carry_scores_and_the_words_as_written() {
    let page = run(
        &corpus(),
        json!({ "stages": [{ "fuzzy": { "query": "alpah", "fields": ["title"] } }] }),
    );
    assert_eq!(ids(&page), ["A"]);
    assert_eq!(page.hits["A"]["terms"], json!(["Alpha"]));
    assert!(page.hits["A"]["score"].as_f64().unwrap() > 0.0);
}

#[test]
fn fuzzy_asks_the_vocabulary_first_then_finds_typos() {
    let mut connection = open();
    apply(
        &mut connection,
        &statements_for_rows(vec![
            row("Q", "# Quarterly reports\n"),
            row("M", "# Milk\n"),
        ]),
    );
    let plan: Plan =
        serde_json::from_value(json!({ "stages": [{ "fuzzy": { "query": "reprots" } }] })).unwrap();
    assert!(compile(&plan).unwrap().vocabulary.is_some());
    let page = run(
        &connection,
        json!({ "stages": [{ "fuzzy": { "query": "reprots" } }] }),
    );
    assert_eq!(ids(&page), ["Q"]);
    assert_eq!(page.hits["Q"]["terms"], json!(["reports"]));
}

#[test]
fn a_short_typo_finds_its_note_among_thousands() {
    let mut connection = open();
    let mut rows: Vec<ProjectionInput> = (0..1500)
        .map(|n| row(&format!("A{n:05}"), &format!("# Note {n}\n")))
        .collect();
    rows.push(row("Z99999", "# Milk\n"));
    apply(&mut connection, &statements_for_rows(rows));
    let page = run(
        &connection,
        json!({ "stages": [{ "fuzzy": { "query": "mlik", "limit": 5 } }] }),
    );
    assert_eq!(ids(&page), ["Z99999"]);
}

#[test]
fn paging_after_fuzzy_pages_the_ranked_hits() {
    let mut connection = open();
    apply(
        &mut connection,
        &statements_for_rows(vec![
            row("A", "# Milk\n"),
            row("B", "# Silk\n"),
            row("C", "# Notes\n\nmilk\n"),
        ]),
    );
    let page = run(
        &connection,
        json!({ "stages": [{ "fuzzy": { "query": "milk" } }, { "offset": 1 }, { "limit": 1 }, "with_total"] }),
    );
    assert_eq!(page.rows.len(), 1);
    assert_eq!(page.total, Some(3));
}

#[test]
fn text_filters_fold_accented_capitals() {
    let mut connection = open();
    apply(
        &mut connection,
        &statements_for_rows(vec![row("A", "# ÉCOLE\n")]),
    );
    let page = run(
        &connection,
        json!({ "stages": [{ "where": { "text": { "field": "title", "mode": "contains", "value": "école" } } }] }),
    );
    assert_eq!(ids(&page), ["A"]);
}

#[test]
fn an_overall_aggregate_has_a_total_of_one() {
    let page = run(
        &corpus(),
        json!({ "stages": [{ "count": {} }, "with_total"] }),
    );
    assert_eq!(page.total, Some(1));
}

#[test]
fn an_alias_named_id_is_not_the_cursor_tiebreak() {
    let mut connection = open();
    let rows: Vec<ProjectionInput> = (0..5)
        .map(|n| ProjectionInput {
            content: Some("# Same\n".into()),
            ..row(&format!("D{n}"), "")
        })
        .collect();
    apply(&mut connection, &statements_for_rows(rows));
    let page = run(
        &connection,
        json!({ "stages": [{ "select": [{ "field": "title", "as": "id" }] }, { "sort": ["id"] }, { "limit": 2 }] }),
    );
    assert_eq!(page.rows.len(), 2);
    assert!(page.next.is_none());
    let error = compile(
        &serde_json::from_value(json!({ "stages": [
            { "select": [{ "field": "title", "as": "id" }] }, { "sort": ["id"] }, { "cursor": encode_cursor(&[SqlValue::Text("Same".into()), SqlValue::Text("Same".into())]) }, { "limit": 2 }
        ] }))
        .unwrap(),
    )
    .unwrap_err();
    assert!(matches!(error, PlanError::BadStage(_)));
}

#[test]
fn fuzzy_finds_an_accented_word_from_a_plain_typo() {
    let mut connection = open();
    apply(
        &mut connection,
        &statements_for_rows(vec![row("B", "# Crème brûlée\n"), row("M", "# Milk\n")]),
    );
    let page = run(
        &connection,
        json!({ "stages": [{ "fuzzy": { "query": "brulee" } }] }),
    );
    assert_eq!(ids(&page), ["B"]);
    let page = run(
        &connection,
        json!({ "stages": [{ "fuzzy": { "query": "brulle" } }] }),
    );
    assert_eq!(ids(&page), ["B"]);
}

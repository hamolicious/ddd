//! The query engine end to end: plans in, pages out.

use ddd_core::query::{Doc, Engine, Op, Plan, Query, QueryError, Trash};
use ddd_core::{Date, Map, Value};

fn doc(id: &str, title: &str, content: &str, updated: &str) -> Doc {
    Doc {
        id: id.into(),
        title: title.into(),
        content: content.into(),
        fm: Map::new(),
        plugins: Map::new(),
        created_at: None,
        updated_at: Some(Date::parse(updated).unwrap()),
        deleted_at: None,
        deleted: false,
    }
}

fn with_fm(mut doc: Doc, key: &str, value: Value) -> Doc {
    doc.fm.insert(key.into(), value);
    doc
}

fn with_children(mut doc: Doc, children: &[&str]) -> Doc {
    let list = Value::List(children.iter().map(|id| Value::Str((*id).into())).collect());
    let mut folders = Map::new();
    folders.insert("children".into(), list);
    doc.plugins.insert("folders".into(), Value::Map(folders));
    doc
}

fn ids(engine: &Engine, plan: &Plan) -> Vec<String> {
    engine.run(plan).unwrap().page().ids
}

fn workspace() -> Engine {
    let mut engine = Engine::new();
    engine.upsert_all([
        with_fm(
            doc("a", "Groceries", "milk and bread", "2026-09-01"),
            "key",
            Value::Int(3),
        ),
        with_fm(
            doc(
                "b",
                "Work notes",
                "quarterly report\nbuy milk later",
                "2026-09-03",
            ),
            "key",
            Value::Int(1),
        ),
        with_fm(
            doc("c", "Garden", "water the plants", "2026-09-02"),
            "key",
            Value::Int(2),
        ),
        doc("d", "Archive", "old milk receipts", "2026-08-01"),
    ]);
    engine
}

#[test]
fn the_default_plan_is_every_live_document_last_updated_first() {
    let engine = workspace();
    assert_eq!(ids(&engine, &Plan::default()), ["b", "c", "a", "d"]);
}

#[test]
fn filter_then_sort_by_a_frontmatter_key() {
    let engine = workspace();
    let plan = Query::new()
        .filter("title", Op::TextContains, "R")
        .sort("fm.key")
        .build()
        .unwrap();
    // `d` has no `key`: missing sorts last.
    assert_eq!(ids(&engine, &plan), ["b", "c", "a", "d"]);
}

#[test]
fn text_ranks_and_intersects_with_the_filter() {
    let engine = workspace();
    let plan = Query::new().text("milk").build().unwrap();
    let page = engine.run(&plan).unwrap().page();
    assert_eq!(page.total, 3);
    assert!(
        page.ids
            .iter()
            .all(|id| ["a", "b", "d"].contains(&id.as_str()))
    );

    let narrowed = Query::new()
        .text("milk")
        .filter("fm.key", Op::Gte, 2i64)
        .build()
        .unwrap();
    assert_eq!(ids(&engine, &narrowed), ["a"]);
}

#[test]
fn an_explicit_sort_overrides_relevance() {
    let engine = workspace();
    let plan = Query::new().text("milk").sort("title").build().unwrap();
    assert_eq!(ids(&engine, &plan), ["d", "a", "b"]);
}

#[test]
fn snippets_point_at_the_matching_line() {
    let engine = workspace();
    let plan = Query::new()
        .text("milk")
        .filter("id", Op::Eq, "b")
        .snippets()
        .build()
        .unwrap();
    let page = engine.run(&plan).unwrap().page();
    let snippet = page.hits["b"].snippet.as_ref().unwrap();
    assert_eq!((snippet.text.as_str(), snippet.line), ("buy milk later", 2));
    assert_eq!(page.hits["b"].terms, ["milk"]);

    let plain = Query::new().text("milk").build().unwrap();
    assert!(
        engine
            .run(&plain)
            .unwrap()
            .page()
            .hits
            .values()
            .all(|hit| hit.snippet.is_none())
    );
}

#[test]
fn pages_follow_their_cursor_and_report_the_total() {
    let engine = workspace();
    let first = Query::new().limit(3).build().unwrap();
    let page = engine.run(&first).unwrap().page();
    assert_eq!((page.ids.len(), page.total), (3, 4));
    let next = Plan {
        cursor: page.next_cursor.clone(),
        ..first.clone()
    };
    let rest = engine.run(&next).unwrap().page();
    assert_eq!(rest.ids, ["d"]);
    assert_eq!(rest.next_cursor, None);

    let other = Query::new()
        .text("milk")
        .cursor(page.next_cursor.unwrap())
        .build()
        .unwrap();
    assert!(matches!(engine.run(&other), Err(QueryError::Plan(_))));
}

#[test]
fn trash_scopes_what_is_seen() {
    let mut engine = workspace();
    let mut gone = doc("e", "Deleted milk", "", "2026-09-05");
    gone.deleted = true;
    gone.deleted_at = Some(Date::parse("2026-09-06").unwrap());
    engine.upsert(gone);

    assert!(!ids(&engine, &Plan::default()).contains(&"e".to_string()));
    let trashed = Query::new().trash(Trash::Trashed).build().unwrap();
    assert_eq!(ids(&engine, &trashed), ["e"]);
    let all = Query::new().text("milk").trash(Trash::All).build().unwrap();
    assert_eq!(engine.run(&all).unwrap().total, 4);
}

#[test]
fn child_of_and_parent_of_walk_the_folder_tree() {
    let mut engine = workspace();
    engine.upsert(with_children(
        doc("root", "Root", "", "2026-01-01"),
        &["a", "doc://folder"],
    ));
    engine.upsert(with_children(
        doc("folder", "Folder", "", "2026-01-01"),
        &["b"],
    ));

    let direct = Query::new()
        .child_of("root", false)
        .sort("id")
        .build()
        .unwrap();
    assert_eq!(ids(&engine, &direct), ["a", "folder"]);
    let deep = Query::new()
        .child_of("root", true)
        .sort("id")
        .build()
        .unwrap();
    assert_eq!(ids(&engine, &deep), ["a", "b", "folder"]);
    let parents = Query::new().parent_of("b").build().unwrap();
    assert_eq!(ids(&engine, &parents), ["folder"]);
    let outside = Query::new()
        .none_of(|q| q.child_of("root", true))
        .filter("title", Op::TextContains, "r")
        .sort("id")
        .build()
        .unwrap();
    assert_eq!(ids(&engine, &outside), ["c", "d", "root"]);

    // Moving `b` out of the folder updates the tree.
    engine.upsert(with_children(
        doc("folder", "Folder", "", "2026-01-01"),
        &[],
    ));
    assert_eq!(ids(&engine, &deep), ["a", "folder"]);
}

#[test]
fn a_cycle_in_the_tree_terminates() {
    let mut engine = Engine::new();
    engine.upsert(with_children(doc("x", "", "", "2026-01-01"), &["y"]));
    engine.upsert(with_children(doc("y", "", "", "2026-01-01"), &["x"]));
    let deep = Query::new().child_of("x", true).sort("id").build().unwrap();
    assert_eq!(ids(&engine, &deep), ["x", "y"]);
}

#[test]
fn removing_a_document_takes_it_out_of_everything() {
    let mut engine = workspace();
    engine.remove("a");
    assert_eq!(engine.len(), 3);
    let plan = Query::new().text("groceries").build().unwrap();
    assert!(ids(&engine, &plan).is_empty());
}

#[test]
fn a_query_bug_is_an_error_not_an_empty_page() {
    let engine = workspace();
    let plan = Query::new()
        .filter("deleted", Op::Eq, "yes")
        .build()
        .unwrap();
    assert!(matches!(engine.run(&plan), Err(QueryError::Eval(_))));
}

#[test]
fn admits_answers_for_one_row() {
    let engine = workspace();
    let plan = Query::new().filter("fm.key", Op::Gt, 1i64).build().unwrap();
    assert!(engine.admits(&plan, "a").unwrap());
    assert!(!engine.admits(&plan, "b").unwrap());
    assert!(!engine.admits(&plan, "nope").unwrap());
}

#[test]
fn a_saved_engine_loads_and_answers_the_same() {
    let mut engine = workspace();
    engine.upsert(with_children(doc("root", "Root", "", "2026-01-01"), &["a"]));
    let loaded = Engine::from_json_str(&engine.to_json_string()).unwrap();
    for plan in [
        Plan::default(),
        Query::new().text("milk").snippets().build().unwrap(),
        Query::new().child_of("root", false).build().unwrap(),
    ] {
        assert_eq!(
            loaded.run(&plan).unwrap().page(),
            engine.run(&plan).unwrap().page()
        );
    }
    assert!(Engine::from_json_str("{}").is_none());
}

#[test]
fn rows_decode_from_projection_json() {
    let row = serde_json::json!({
        "id": "x", "title": "T", "fm": {"n": 1}, "plugins": {},
        "created_at": "2026-09-01T10:00:00Z", "updated_at": "not a date",
        "deleted": false, "deleted_at": null, "purged": false
    });
    let doc = Doc::from_json(&row).unwrap();
    assert_eq!(doc.fm.get("n"), Some(&Value::Int(1)));
    assert!(doc.created_at.is_some() && doc.updated_at.is_none());
    assert_eq!(doc.content, "");
    assert!(Doc::from_json(&serde_json::json!({"title": "no id"})).is_none());
}

#[test]
fn an_offset_pages_by_position() {
    let engine = workspace();
    let plan = Plan {
        offset: Some(2),
        limit: Some(1),
        ..Plan::default()
    };
    assert_eq!(ids(&engine, &plan), ["a"]);
    let both = Plan {
        cursor: Some("0.0".into()),
        ..plan
    };
    assert!(matches!(engine.run(&both), Err(QueryError::Plan(_))));
}

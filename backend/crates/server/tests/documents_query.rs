//! `GET /api/documents` — the filter DSL, sorting and pagination **over the
//! router** (CONTRACTS.md, area http-routes, M2 item 1).
//!
//! The M1 suite covered the pure helpers (`sort_field_allowed`, `parse_sort_spec`,
//! `clamp_limit`) and the docstore's own Mongo round trips, but nothing ran a
//! filter through the whole path — query string → `Filter::from_json_str` →
//! `filter::mongo::compile` → Mongo → projection → `DocumentView`. A filter that
//! parsed and then compiled to a query selecting the wrong rows was invisible.
//!
//! So these tests assert the contract `crates/core/README.md` §4 states outright:
//! **the compiler and the evaluator return the same rows.** One corpus is created
//! through the API, read back once, and every case is then answered twice — by the
//! server (compiled to Mongo) and by the shared core's evaluator over those same
//! rows — and the two answers must be equal. A wrong compilation cannot pass by
//! agreeing with a hand-written expectation, because the expectation is the other
//! implementation.

mod common;

use axum::http::StatusCode;
use common::{
    LocalRow, TestApp, assert_no_extended_json, evaluate_ids, parse_filter, parse_sort, sorted_ids,
    urlencode,
};

/// The corpus. Deliberately heterogeneous — missing keys, a null, an empty list,
/// ints next to a float, two documents with the same `fm.priority` — because that
/// is what a shared workspace looks like and where the two engines disagree if
/// they are going to (SPEC §4.2 "dynamic fields never error").
const CORPUS: &[&str] = &[
    "---\n\
     title: Alpha\n\
     status: open\n\
     priority: 1\n\
     flag: true\n\
     tags: [work, urgent]\n\
     due: 2026-01-15\n\
     ---\n\
     \n\
     # Alpha\n\
     \n\
     alpha body text\n",
    "---\n\
     title: Beta\n\
     status: open\n\
     priority: 2\n\
     flag: false\n\
     tags: [work]\n\
     due: 2026-02-01\n\
     ---\n\
     \n\
     beta body text\n",
    "---\n\
     title: Gamma\n\
     status: done\n\
     priority: 3\n\
     note: null\n\
     tags: [home]\n\
     due: 2026-03-10\n\
     ---\n\
     \n\
     gamma body text\n",
    "---\n\
     title: Delta\n\
     status: blocked\n\
     priority: 2.5\n\
     tags: []\n\
     ---\n\
     \n\
     delta body text\n",
    "---\n\
     title: Epsilon\n\
     tags: [urgent, home]\n\
     scores: [1, 2, 3]\n\
     ---\n\
     \n\
     epsilon body text\n",
    "---\n\
     title: Zeta\n\
     status: open\n\
     priority: 10\n\
     tags: [work, home]\n\
     due: 2026-01-01\n\
     ---\n\
     \n\
     zeta body text\n\
     \n\
     %%% calendar\n\
     start: 2026-05-01\n\
     uid: zeta-1\n\
     %%%\n",
    "---\n\
     title: Eta\n\
     ---\n\
     \n\
     eta body text\n",
];

/// Filter cases: `(name, wire JSON, titles it must select)`.
///
/// The expected titles are a second, independent check: without them a compiler
/// and an evaluator that were *both* wrong in the same direction (say, both
/// returning nothing) would agree and pass.
const FILTER_CASES: &[(&str, &str, &[&str])] = &[
    (
        "all",
        r#""all""#,
        &["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta"],
    ),
    ("none", r#""none""#, &[]),
    (
        "cmp eq str",
        r#"{"cmp":{"field":"fm.status","op":"eq","value":{"str":"open"}}}"#,
        &["Alpha", "Beta", "Zeta"],
    ),
    (
        // `ne` is "present and not eq" — Epsilon and Eta have no status at all
        // and must not match (SPEC §4.2).
        "cmp ne str",
        r#"{"cmp":{"field":"fm.status","op":"ne","value":{"str":"open"}}}"#,
        &["Gamma", "Delta"],
    ),
    (
        // Numbers are one type family: 2.5 participates in an int comparison.
        "cmp lt number",
        r#"{"cmp":{"field":"fm.priority","op":"lt","value":{"int":3}}}"#,
        &["Alpha", "Beta", "Delta"],
    ),
    (
        "cmp lte float",
        r#"{"cmp":{"field":"fm.priority","op":"lte","value":{"float":2.5}}}"#,
        &["Alpha", "Beta", "Delta"],
    ),
    (
        "cmp gt number",
        r#"{"cmp":{"field":"fm.priority","op":"gt","value":{"int":2}}}"#,
        &["Gamma", "Delta", "Zeta"],
    ),
    (
        "cmp gte number",
        r#"{"cmp":{"field":"fm.priority","op":"gte","value":{"int":10}}}"#,
        &["Zeta"],
    ),
    (
        "cmp eq bool",
        r#"{"cmp":{"field":"fm.flag","op":"eq","value":{"bool":true}}}"#,
        &["Alpha"],
    ),
    (
        "cmp eq on a fixed column",
        r#"{"cmp":{"field":"title","op":"eq","value":{"str":"Gamma"}}}"#,
        &["Gamma"],
    ),
    (
        // `deleted` is derived from `deleted_at`, not stored — the compiler has to
        // translate it.
        "cmp eq derived deleted",
        r#"{"cmp":{"field":"deleted","op":"eq","value":{"bool":false}}}"#,
        &["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta"],
    ),
    (
        "in",
        r#"{"in":{"field":"fm.status","values":[{"str":"done"},{"str":"blocked"}]}}"#,
        &["Gamma", "Delta"],
    ),
    (
        "contains",
        r#"{"contains":{"field":"fm.tags","value":{"str":"work"}}}"#,
        &["Alpha", "Beta", "Zeta"],
    ),
    (
        // No implicit array matching, in either direction (SPEC §4.2).
        "cmp against a list never matches",
        r#"{"cmp":{"field":"fm.tags","op":"eq","value":{"str":"work"}}}"#,
        &[],
    ),
    (
        "contains against a scalar never matches",
        r#"{"contains":{"field":"fm.status","value":{"str":"open"}}}"#,
        &[],
    ),
    (
        "any",
        r#"{"any":{"field":"fm.scores","op":"gt","value":{"int":2}}}"#,
        &["Epsilon"],
    ),
    (
        // Vacuously true on Delta's empty list; false wherever the key is missing.
        "every",
        r#"{"every":{"field":"fm.tags","op":"ne","value":{"str":"work"}}}"#,
        &["Gamma", "Delta", "Epsilon"],
    ),
    (
        "missing",
        r#"{"missing":{"field":"fm.status"}}"#,
        &["Epsilon", "Eta"],
    ),
    (
        // `missing` and `is_null` are different questions: Gamma has the key.
        "is_null",
        r#"{"is_null":{"field":"fm.note"}}"#,
        &["Gamma"],
    ),
    (
        "exists includes null",
        r#"{"exists":{"field":"fm.note"}}"#,
        &["Gamma"],
    ),
    (
        "missing does not match a present null",
        r#"{"missing":{"field":"fm.note"}}"#,
        &["Alpha", "Beta", "Delta", "Epsilon", "Zeta", "Eta"],
    ),
    (
        "date lt on fm",
        r#"{"cmp":{"field":"fm.due","op":"lt","value":{"date":"2026-02-01"}}}"#,
        &["Alpha", "Zeta"],
    ),
    (
        "date gte on fm",
        r#"{"cmp":{"field":"fm.due","op":"gte","value":{"date":"2026-02-01"}}}"#,
        &["Beta", "Gamma"],
    ),
    (
        "date on a plugins path",
        r#"{"cmp":{"field":"plugins.calendar.start","op":"gte","value":{"date":"2026-05-01"}}}"#,
        &["Zeta"],
    ),
    (
        "str on a plugins path",
        r#"{"cmp":{"field":"plugins.calendar.uid","op":"eq","value":{"str":"zeta-1"}}}"#,
        &["Zeta"],
    ),
    (
        "missing on a plugins path",
        r#"{"missing":{"field":"plugins.calendar.uid"}}"#,
        &["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Eta"],
    ),
    (
        "text starts_with is case-insensitive",
        r#"{"text":{"field":"title","mode":"starts_with","value":"al"}}"#,
        &["Alpha"],
    ),
    (
        "text contains on content",
        r#"{"text":{"field":"content","mode":"contains","value":"GAMMA BODY"}}"#,
        &["Gamma"],
    ),
    (
        "text ends_with",
        r#"{"text":{"field":"title","mode":"ends_with","value":"ta"}}"#,
        &["Beta", "Delta", "Zeta", "Eta"],
    ),
    (
        "and",
        r#"{"and":[{"cmp":{"field":"fm.status","op":"eq","value":{"str":"open"}}},
                  {"contains":{"field":"fm.tags","value":{"str":"home"}}}]}"#,
        &["Zeta"],
    ),
    (
        "or",
        r#"{"or":[{"cmp":{"field":"fm.priority","op":"gte","value":{"int":10}}},
                 {"is_null":{"field":"fm.note"}}]}"#,
        &["Gamma", "Zeta"],
    ),
    (
        "not",
        r#"{"not":{"contains":{"field":"fm.tags","value":{"str":"work"}}}}"#,
        &["Gamma", "Delta", "Epsilon", "Eta"],
    ),
    (
        "nested and/or/not",
        r#"{"and":[{"not":{"missing":{"field":"fm.priority"}}},
                  {"or":[{"cmp":{"field":"fm.priority","op":"lt","value":{"int":2}}},
                         {"cmp":{"field":"fm.priority","op":"gt","value":{"int":3}}}]}]}"#,
        &["Alpha", "Zeta"],
    ),
];

/// Create the corpus and read it back once, as both wire views and shared-core
/// rows.
async fn corpus(app: &TestApp) -> (Vec<LocalRow>, Vec<(String, String)>) {
    for text in CORPUS {
        app.create_document(text).await;
    }
    let page = app.list("limit=100").await;
    assert_eq!(
        page.documents.len(),
        CORPUS.len(),
        "the corpus did not come back whole"
    );
    assert_no_extended_json(&page.raw, "GET /api/documents");

    let titles = page
        .documents
        .iter()
        .map(|doc| (doc.id.clone(), doc.title.clone()))
        .collect();
    let rows = page.documents.iter().map(LocalRow::from_view).collect();
    (rows, titles)
}

fn titles_of(ids: &[String], titles: &[(String, String)]) -> Vec<String> {
    let mut out: Vec<String> = ids
        .iter()
        .map(|id| {
            titles
                .iter()
                .find(|(row_id, _)| row_id == id)
                .map(|(_, title)| title.clone())
                .unwrap_or_else(|| format!("<unknown {id}>"))
        })
        .collect();
    out.sort();
    out
}

fn sorted(mut ids: Vec<String>) -> Vec<String> {
    ids.sort();
    ids
}

/// Every accepted filter shape, answered by the server and by the shared core.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn filter_results_match_the_shared_core_evaluator() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let (rows, titles) = corpus(&app).await;

    for (name, filter_json, expected_titles) in FILTER_CASES {
        let query = format!("filter={}&limit=100", urlencode(filter_json));
        let page = app.list(&query).await;
        assert_no_extended_json(&page.raw, name);

        let from_server = sorted(page.ids());
        let from_core = sorted(evaluate_ids(&parse_filter(filter_json), &rows));

        assert_eq!(
            titles_of(&from_server, &titles),
            titles_of(&from_core, &titles),
            "case `{name}`: the compiled Mongo query and the evaluator disagree"
        );

        let mut expected: Vec<String> = expected_titles.iter().map(|t| t.to_string()).collect();
        expected.sort();
        assert_eq!(
            titles_of(&from_server, &titles),
            expected,
            "case `{name}`: neither engine selected the documents the case describes"
        );
    }

    app.cleanup().await;
}

/// Sorting, including the `-field` / `field:desc` spellings and multi-key specs.
///
/// Every case sorts on a key **present on every row it orders** — either a fixed
/// column or an `fm` path the filter requires. That is not incidental: see
/// `missing_sort_keys_are_ordered_differently_by_the_two_engines` below.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn sort_order_matches_the_shared_core_comparator() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let (rows, titles) = corpus(&app).await;

    for spec in [
        "title",
        "-title",
        "title:desc",
        "id",
        "-id",
        "updated_at",
        "-created_at",
    ] {
        let page = app.list(&format!("sort={spec}&limit=100")).await;
        let from_server = page.ids();
        let from_core = sorted_ids(&parse_sort(spec), &rows);
        assert_eq!(
            titles_of_ordered(&from_server, &titles),
            titles_of_ordered(&from_core, &titles),
            "sort `{spec}`: Mongo's order and the comparator's order differ"
        );
        assert_eq!(from_server.len(), CORPUS.len());
    }

    // Multi-key, mixed directions, over an `fm` path — restricted to the rows that
    // have the key so the divergence documented below stays out of it.
    let filter = r#"{"exists":{"field":"fm.priority"}}"#;
    for spec in [
        "-fm.priority,title",
        "fm.priority:desc,-title",
        "fm.priority,id",
    ] {
        let page = app
            .list(&format!(
                "filter={}&sort={spec}&limit=100",
                urlencode(filter)
            ))
            .await;
        let subset: Vec<LocalRow> = rows
            .iter()
            .filter(|row| row.fm.contains_key("priority"))
            .cloned()
            .collect();
        assert_eq!(subset.len(), 5, "five corpus documents carry fm.priority");

        let from_server = page.ids();
        let from_core = sorted_ids(&parse_sort(spec), &subset);
        assert_eq!(
            titles_of_ordered(&from_server, &titles),
            titles_of_ordered(&from_core, &titles),
            "sort `{spec}`: Mongo's order and the comparator's order differ"
        );
    }

    app.cleanup().await;
}

fn titles_of_ordered(ids: &[String], titles: &[(String, String)]) -> Vec<String> {
    ids.iter()
        .map(|id| {
            titles
                .iter()
                .find(|(row_id, _)| row_id == id)
                .map(|(_, title)| title.clone())
                .unwrap_or_else(|| format!("<unknown {id}>"))
        })
        .collect()
}

/// A known, deliberate difference, pinned so it is a decision rather than a
/// surprise: `compare_rows` puts a **missing** sort key last in both directions
/// (`crates/core/src/filter/evaluator.rs`), while Mongo sorts an absent field
/// lowest, i.e. **first** ascending. Rows that lack the sort key therefore appear
/// at opposite ends of the same query depending on who ordered them.
///
/// The client browses locally and the server's list endpoint serves scripts and
/// integrations (SPEC §4.2), so this is not a correctness bug today — but it is a
/// real divergence, and if it is ever closed it will be closed here.
///
/// INTEGRATION (core + docstore): closing it means either making the comparator
/// match Mongo's "missing first ascending", or having the query layer emit the
/// `$ifNull`-style projection that moves missing values last. Both are outside
/// this suite's ownership; reported, not fixed.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn missing_sort_keys_are_ordered_differently_by_the_two_engines() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let (rows, _titles) = corpus(&app).await;

    let page = app.list("sort=fm.priority&limit=100").await;
    let from_server = page.ids();
    let from_core = sorted_ids(&parse_sort("fm.priority"), &rows);

    assert_eq!(
        sorted(from_server.clone()),
        sorted(from_core.clone()),
        "the same rows must come back either way — only the order differs"
    );

    let rows_without_key: Vec<&str> = rows
        .iter()
        .filter(|row| !row.fm.contains_key("priority"))
        .map(|row| row.id.as_str())
        .collect();
    assert_eq!(
        rows_without_key.len(),
        2,
        "Epsilon and Eta have no priority"
    );

    let server_head = &from_server[..rows_without_key.len()];
    assert!(
        server_head
            .iter()
            .all(|id| rows_without_key.contains(&id.as_str())),
        "Mongo is expected to sort the rows without fm.priority first: {from_server:?}"
    );
    let core_tail = &from_core[from_core.len() - rows_without_key.len()..];
    assert!(
        core_tail
            .iter()
            .all(|id| rows_without_key.contains(&id.as_str())),
        "the comparator is expected to put them last: {from_core:?}"
    );

    app.cleanup().await;
}

/// The same divergence on the one root where it reaches a shipped sort.
///
/// `deleted_at` is not an `fm.*` path a caller chose: it is a fixed root, it is in
/// `SORTABLE_FIELDS`, and it is what `doc-list`'s Trash view sorts by. It is also the only
/// fixed root that can be **absent** — `Option` in `domain.rs` with
/// `skip_serializing_if`, and `untombstone` `$unset`s it — so `?trash=all&sort=deleted_at`
/// runs the disagreement above over live documents versus tombstoned ones and splits them
/// to opposite ends of the first page.
///
/// Pinned rather than fixed, for the reason the test above gives: the fix is a `core` or
/// `docstore` change that has to land with `web/kernel/src/query/filter.ts` in one commit.
/// What this adds is that it can no longer be *discovered* — `-deleted_at`, the direction
/// the Trash view actually sends, agrees between the two engines, so the corpus case that
/// exists proved nothing about the ascending one.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn deleted_at_ascending_diverges_where_a_document_is_still_live() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let (_rows, _titles) = corpus(&app).await;

    // Two of the seven go to Trash, so the query has both kinds in it.
    let live = app.list("limit=100").await;
    let trashed: Vec<String> = live.ids().into_iter().take(2).collect();
    for id in &trashed {
        app.delete(&format!("/api/documents/{id}"))
            .await
            .expect_status(StatusCode::NO_CONTENT);
    }

    // Read the rows back the way the client sees them, tombstones included.
    let all = app.list("trash=all&limit=100").await;
    let rows: Vec<LocalRow> = all.documents.iter().map(LocalRow::from_view).collect();
    assert_eq!(rows.len(), CORPUS.len());
    assert_eq!(
        rows.iter().filter(|row| row.deleted_at.is_some()).count(),
        trashed.len(),
        "only the tombstoned documents carry `deleted_at`"
    );

    for (spec, agree) in [("-deleted_at", true), ("deleted_at", false)] {
        let from_server = app
            .list(&format!("trash=all&sort={spec}&limit=100"))
            .await
            .ids();
        let from_core = sorted_ids(&parse_sort(spec), &rows);
        assert_eq!(
            sorted(from_server.clone()),
            sorted(from_core.clone()),
            "sort `{spec}`: the same rows must come back either way"
        );
        assert_eq!(
            from_server == from_core,
            agree,
            "sort `{spec}`: server {from_server:?} vs comparator {from_core:?}"
        );
    }

    // And the shape of the disagreement, so a change to either engine fails here loudly
    // rather than flipping a boolean above.
    let ascending = app.list("trash=all&sort=deleted_at&limit=100").await.ids();
    assert!(
        !trashed.contains(&ascending[0]),
        "Mongo sorts an absent `deleted_at` as Null, so the live documents lead: {ascending:?}"
    );
    let from_core = sorted_ids(&parse_sort("deleted_at"), &rows);
    assert!(
        trashed.contains(&from_core[0]),
        "the comparator puts missing last, so the tombstones lead: {from_core:?}"
    );

    app.cleanup().await;
}

/// Paging must be a partition of the single-page result: same rows, same order,
/// no gaps, no repeats, and a final page without a cursor.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn pagination_partitions_the_result_set() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let (_rows, _titles) = corpus(&app).await;

    let whole = app.list("sort=title&limit=100").await;
    assert!(whole.next_cursor.is_none(), "one page holds the corpus");

    for page_size in [1, 2, 3, 6, 7] {
        let paged = app.list_all_pages("sort=title", page_size).await;
        assert_eq!(
            paged,
            whole.ids(),
            "page size {page_size} did not reproduce the unpaged order"
        );
    }

    // A filter travels with the cursor: paging a filtered query must not silently
    // page the unfiltered one.
    let filter = r#"{"contains":{"field":"fm.tags","value":{"str":"work"}}}"#;
    let filtered = app
        .list(&format!(
            "filter={}&sort=title&limit=100",
            urlencode(filter)
        ))
        .await;
    assert_eq!(filtered.documents.len(), 3);
    let paged = app
        .list_all_pages(&format!("filter={}&sort=title", urlencode(filter)), 2)
        .await;
    assert_eq!(paged, filtered.ids());

    app.cleanup().await;
}

/// `metadata_only` must drop `content` *at the projection*, and the row must
/// otherwise be complete.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn metadata_only_omits_content_but_nothing_else() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let (_rows, _titles) = corpus(&app).await;

    let full = app.list("sort=title&limit=100").await;
    assert!(
        full.documents
            .iter()
            .any(|doc| doc.content.contains("body")),
        "the full listing carries content"
    );

    let lean = app.list("sort=title&limit=100&metadata_only=true").await;
    assert_eq!(lean.ids(), full.ids(), "the same rows, in the same order");
    for doc in &lean.documents {
        assert!(
            doc.content.is_empty(),
            "metadata_only still returned content for {}",
            doc.id
        );
        assert!(!doc.title.is_empty(), "the title must survive");
        assert!(
            !doc.materialized_version.is_empty(),
            "materialized_version must survive"
        );
    }
    // `fm` must survive too — it is what a list view renders.
    let zeta = lean
        .documents
        .iter()
        .find(|doc| doc.title == "Zeta")
        .expect("Zeta is listed");
    assert_eq!(zeta.fm["status"], serde_json::json!("open"));
    assert_eq!(zeta.plugins["calendar"]["uid"], serde_json::json!("zeta-1"));

    app.cleanup().await;
}

/// Everything the query string must refuse. A rejected query is a 400 with the
/// standard envelope — never a 500, and never a silently unfiltered result.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn refused_queries_are_400() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    app.create_document("---\ntitle: Only\n---\n\nbody\n").await;

    let cases: &[(&str, String)] = &[
        ("malformed filter JSON", "filter=%7Bnope".to_string()),
        (
            "unknown filter field",
            format!(
                "filter={}",
                urlencode(r#"{"cmp":{"field":"password_hash","op":"eq","value":{"str":"x"}}}"#)
            ),
        ),
        (
            "invalid field path",
            format!(
                "filter={}",
                urlencode(r#"{"cmp":{"field":"fm","op":"eq","value":{"str":"x"}}}"#)
            ),
        ),
        (
            // A fixed column has a schema type: a mismatch is a query bug, and
            // both the evaluator and the compiler refuse it (SPEC §4.2).
            "type mismatch on a fixed column",
            format!(
                "filter={}",
                urlencode(r#"{"cmp":{"field":"title","op":"eq","value":{"int":1}}}"#)
            ),
        ),
        (
            "unparseable date literal",
            format!(
                "filter={}",
                urlencode(r#"{"cmp":{"field":"fm.due","op":"lt","value":{"date":"not-a-date"}}}"#)
            ),
        ),
        (
            "ordering operator against null",
            format!(
                "filter={}",
                urlencode(r#"{"cmp":{"field":"fm.due","op":"lt","value":"null"}}"#)
            ),
        ),
        ("sort=content is refused", "sort=content".to_string()),
        ("sort=crdt is refused", "sort=crdt".to_string()),
        ("sort on an unknown field", "sort=password_hash".to_string()),
        ("too many sort keys", "sort=title,id,fm.a,fm.b".to_string()),
        ("limit=0", "limit=0".to_string()),
        ("unknown trash filter", "trash=deleted".to_string()),
    ];

    for (name, query) in cases {
        let response = app.get(&format!("/api/documents?{query}")).await;
        assert_eq!(
            response.status,
            StatusCode::BAD_REQUEST,
            "`{name}` should be a 400; body was {}",
            response.text()
        );
        assert_eq!(response.error_code(), "bad_request", "`{name}`");
    }

    // A clamped limit is not an error: 500 rows is the ceiling, not a refusal.
    app.get("/api/documents?limit=10000")
        .await
        .expect_status(StatusCode::OK);

    app.cleanup().await;
}

/// The server-side search provider (`$text`) is reachable and bounded. The PWA
/// searches locally (SPEC §4.2); this endpoint exists for scripts.
#[tokio::test]
#[ignore = "requires MONGO_URI"]
async fn search_uses_the_text_index() {
    let Some(app) = TestApp::start().await else {
        return;
    };
    let (_rows, titles) = corpus(&app).await;

    let page = app.list("search=gamma&limit=100").await;
    let found = titles_of(&page.ids(), &titles);
    assert!(
        found.contains(&"Gamma".to_string()),
        "text search missed the document containing the term: {found:?}"
    );

    let long = "x".repeat(300);
    app.get(&format!("/api/documents?search={long}"))
        .await
        .expect_status(StatusCode::BAD_REQUEST);

    app.cleanup().await;
}

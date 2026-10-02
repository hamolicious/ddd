mod common;

use std::collections::BTreeMap;

use ddd_core::date::{Date, DatePrecision};
use ddd_core::document::{Span, normalize_input, parse_document};
use ddd_core::filter::ast::{Filter, SortKey};
use ddd_core::filter::evaluator::{Row, compare_rows, evaluate};
use ddd_core::filter::mongo;
use ddd_core::splice::{self, ListAction, SectionLineEdit, TextEdit};
use ddd_core::value::{Map, Value, map_to_bson};

#[test]
fn document_corpus() {
    let corpus = common::corpus("documents.json");
    let cases = corpus["cases"].as_array().expect("cases array");
    assert!(cases.len() >= 30, "the corpus should stay broad");

    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let input = case["input"].as_str().expect("case input");
        let expect = &case["expect"];

        let normalized = normalize_input(input);
        let text = normalized.as_ref();
        let parsed = parse_document(input);

        assert_eq!(
            parsed.title,
            expect["title"].as_str().expect("expected title"),
            "{name}: title"
        );
        assert_eq!(
            map_to_json(&parsed.fm),
            expect["fm"],
            "{name}: materialized fm"
        );
        assert_eq!(
            parsed.fm_parse_error,
            expect["fm_parse_error"].as_bool().expect("fm_parse_error"),
            "{name}: fm_parse_error"
        );
        assert_eq!(
            map_to_json(&parsed.plugins),
            expect["plugins"],
            "{name}: materialized plugins"
        );

        if let Some(expected) = expect.get("frontmatter") {
            let actual = parsed
                .frontmatter_span
                .map(|span| serde_json::Value::String(span.slice(text).to_string()))
                .unwrap_or(serde_json::Value::Null);
            assert_eq!(&actual, expected, "{name}: frontmatter span");
        }
        if let Some(expected) = expect.get("body") {
            assert_eq!(
                parsed.body_span.slice(text),
                expected.as_str().expect("body slice"),
                "{name}: body span"
            );
        }
        if let Some(expected) = expect.get("sections_text") {
            let actual = parsed
                .sections_span()
                .map(|span| serde_json::Value::String(span.slice(text).to_string()))
                .unwrap_or(serde_json::Value::Null);
            assert_eq!(&actual, expected, "{name}: machine-section run span");
        }
        if let Some(expected) = expect.get("diagnostics").and_then(|d| d.as_array()) {
            let actual: Vec<serde_json::Value> = parsed
                .diagnostics
                .iter()
                .map(|diagnostic| {
                    serde_json::json!({
                        "kind": serde_json::to_value(diagnostic.kind).expect("kind"),
                        "line": diagnostic.line,
                    })
                })
                .collect();
            assert_eq!(&actual, expected, "{name}: diagnostics");
        }

        assert_eq!(parsed, parse_document(input), "{name}: not deterministic");
        assert_eq!(
            parsed,
            parse_document(text),
            "{name}: normalization unstable"
        );
    }
}

#[test]
fn hardening_caps_are_enforced() {
    let filler: String = (0..3000)
        .map(|i| format!("k{i}: aaaaaaaaaaaaaaaaaaaaaaaa\n"))
        .collect();
    assert!(filler.len() > 64 * 1024);
    let parsed = parse_document(&format!("---\n{filler}---\nbody\n"));
    assert!(parsed.fm.is_empty(), "oversized block materializes nothing");
    assert!(parsed.fm_parse_error);

    let many: String = (0..250).map(|i| format!("k{i:03}: {i}\n")).collect();
    let parsed = parse_document(&format!("---\n{many}---\n"));
    assert_eq!(parsed.fm.len(), 200);
    assert!(parsed.fm_parse_error);

    let long = "x".repeat(8 * 1024 + 1);
    let parsed = parse_document(&format!("---\nbig: {long}\nok: 1\n---\n"));
    assert_eq!(parsed.fm.len(), 1);
    assert!(parsed.fm.contains_key("ok"));
    assert!(parsed.fm_parse_error);

    let items: Vec<String> = (0..1001).map(|i| i.to_string()).collect();
    let parsed = parse_document(&format!("---\nbig: [{}]\nok: 1\n---\n", items.join(", ")));
    assert_eq!(parsed.fm.len(), 1);
    assert!(parsed.fm_parse_error);
    let items: Vec<String> = (0..1000).map(|i| i.to_string()).collect();
    let parsed = parse_document(&format!("---\nbig: [{}]\n---\n", items.join(", ")));
    assert_eq!(parsed.fm["big"].as_list().expect("list").len(), 1000);
    assert!(!parsed.fm_parse_error);

    let sections: String = (0..70)
        .map(|i| format!("%%% p{i}\nk: {i}\n%%%\n"))
        .collect();
    let parsed = parse_document(&sections);
    assert_eq!(parsed.sections.len(), 64);
    assert_eq!(parsed.plugins.len(), 64);

    let body: String = (0..3000)
        .map(|i| format!("k{i}: aaaaaaaaaaaaaaaaaaaaaaaa\n"))
        .collect();
    let parsed = parse_document(&format!("%%% p\n{body}%%%\n"));
    assert_eq!(parsed.sections.len(), 1);
    assert!(parsed.sections[0].map.is_empty());
}

#[test]
fn metadata_intersection_short_circuit() {
    let text = "---\ntitle: A\n---\n\nsome body text\n\n%%% p\nk: 1\n%%%\n";
    let parsed = parse_document(text);
    let fm = parsed.frontmatter_span.expect("frontmatter");
    let run = parsed.sections_span().expect("run");

    for edited in [
        Span::new(0, 0),
        Span::new(2, 5),
        Span::new(fm.end, fm.end),
        Span::new(run.start, run.start + 1),
        Span::new(text.len(), text.len()),
    ] {
        assert!(
            ddd_core::document::edit_affects_metadata(&parsed, edited),
            "{edited:?} should force a re-parse"
        );
    }
    let body_middle = Span::new(fm.end + 2, fm.end + 5);
    assert!(!ddd_core::document::edit_affects_metadata(
        &parsed,
        body_middle
    ));

    let parsed = parse_document("body\n%%% p\nk: 1\n");
    assert!(ddd_core::document::edit_affects_metadata(
        &parsed,
        Span::new(1, 2)
    ));
}

#[test]
fn date_corpus() {
    let corpus = common::corpus("dates.json");

    for case in corpus["valid"].as_array().expect("valid array") {
        let input = case["input"].as_str().expect("input");
        let date = Date::parse(input).unwrap_or_else(|e| panic!("{input:?} should parse: {e}"));
        assert_eq!(date.canonical(), case["canonical"], "{input:?}: canonical");
        let precision = match case["precision"].as_str().expect("precision") {
            "date" => DatePrecision::Date,
            "date_time" => DatePrecision::DateTime,
            other => panic!("unknown precision {other}"),
        };
        assert_eq!(date.precision(), precision, "{input:?}: precision");
        assert_eq!(
            date.epoch_millis(),
            case["epoch_millis"].as_i64().expect("epoch_millis"),
            "{input:?}: epoch"
        );
        assert_eq!(Date::parse(date.canonical()).expect("re-parse"), date);
    }

    for input in corpus["invalid"].as_array().expect("invalid array") {
        let input = input.as_str().expect("invalid entry");
        assert!(Date::parse(input).is_err(), "{input:?} should not parse");
        assert!(!Date::looks_like_date(input));
        assert_eq!(
            Date::normalize_str(input),
            input,
            "{input:?} stays as it is"
        );
    }

    for case in corpus["normalize"].as_array().expect("normalize array") {
        let input = case["input"].as_str().expect("input");
        assert_eq!(
            Date::normalize_str(input),
            case["output"].as_str().expect("output"),
            "{input:?}: normalization"
        );
    }

    let ordered: Vec<Date> = corpus["order"]
        .as_array()
        .expect("order array")
        .iter()
        .map(|entry| Date::parse(entry.as_str().expect("order entry")).expect("parses"))
        .collect();
    for window in ordered.windows(2) {
        assert!(window[0] < window[1], "{:?} < {:?}", window[0], window[1]);
        assert!(
            window[0].canonical() < window[1].canonical(),
            "canonical text order must match: {:?} < {:?}",
            window[0],
            window[1]
        );
    }
}

#[test]
fn canonical_shape_agrees_between_evaluator_and_compiler() {
    let corpus = common::corpus("dates.json");
    let shape = &corpus["canonical_shape"];
    let filter = Filter::from_json_str(
        r#"{"cmp":{"field":"fm.due","op":"gte","value":{"date":"0001-01-01"}}}"#,
    )
    .expect("filter parses");
    let query = mongo::compile(&filter).expect("compiles");
    let pattern = query
        .get_array("$and")
        .expect("$and")
        .iter()
        .find_map(|clause| {
            clause
                .as_document()?
                .get_document("fm.due")
                .ok()?
                .get_str("$regex")
                .ok()
                .map(str::to_string)
        })
        .expect("a canonical-shape regex guard");

    for (list, expected) in [(&shape["yes"], true), (&shape["no"], false)] {
        for entry in list.as_array().expect("shape list") {
            let text = entry.as_str().expect("shape entry");
            assert_eq!(
                common::regex_match(&pattern, text, false),
                expected,
                "{text:?}: compiled regex guard"
            );
            let fm: Map = BTreeMap::from([("due".to_string(), Value::Str(text.to_string()))]);
            let empty = Map::new();
            let row = Row {
                id: "x",
                title: "",
                content: "",
                fm: &fm,
                plugins: &empty,
                created_at: None,
                updated_at: None,
                deleted_at: None,
                deleted: false,
            };
            assert_eq!(
                evaluate(&filter, &row).expect("evaluates"),
                expected,
                "{text:?}: evaluator participation"
            );
        }
    }
}

#[test]
fn splice_corpus() {
    let corpus = common::corpus("splices.json");

    for case in corpus["cases"].as_array().expect("cases array") {
        let name = case["name"].as_str().expect("name");
        let text = case["text"].as_str().expect("text");
        let (edits, popped) = apply_op(text, &case["op"]).unwrap_or_else(|e| panic!("{name}: {e}"));
        if let Some(expected) = case.get("popped") {
            assert_eq!(
                popped.map(|value| value.to_json()),
                Some(expected.clone()).filter(|value| !value.is_null()),
                "{name}: popped"
            );
        }

        if let Some(expected) = case["edits"].as_u64() {
            assert_eq!(edits.len() as u64, expected, "{name}: edit count");
        }
        if let Some(expected) = case.get("replaced").and_then(|r| r.as_array()) {
            let mut actual: Vec<&str> = edits.iter().map(|e| e.range.slice(text)).collect();
            actual.sort_unstable();
            let mut expected: Vec<&str> = expected
                .iter()
                .map(|e| e.as_str().expect("slice"))
                .collect();
            expected.sort_unstable();
            assert_eq!(actual, expected, "{name}: replaced slices");
        }
        for window in edits.windows(2) {
            assert!(
                window[0].range.start >= window[1].range.end,
                "{name}: edits overlap or are misordered"
            );
        }

        let out = splice::apply(text, &edits);
        assert_eq!(
            out,
            case["expect"].as_str().expect("expect"),
            "{name}: result"
        );

        let parsed = parse_document(&out);
        if let Some(expected) = case.get("list") {
            let key = case["op"]["key"].as_str().expect("key");
            let actual = match case["op"].get("plugin").and_then(|p| p.as_str()) {
                Some(plugin) => match parsed.plugins.get(plugin) {
                    Some(Value::Map(section)) => section.get(key).cloned(),
                    _ => None,
                },
                None => parsed.fm.get(key).cloned(),
            };
            assert_eq!(
                actual.map(|value| value.to_json()),
                Some(expected.clone()),
                "{name}: parsed list"
            );
        }
        assert_eq!(
            parsed,
            parse_document(&parsed_text(&out)),
            "{name}: reparse"
        );
    }

    for case in corpus["rejected"].as_array().expect("rejected array") {
        let name = case["name"].as_str().expect("name");
        assert!(
            apply_op("body\n", &case["op"]).is_err(),
            "{name}: should be rejected"
        );
    }
}

fn parsed_text(text: &str) -> String {
    normalize_input(text).into_owned()
}

fn apply_op(text: &str, op: &serde_json::Value) -> Result<(Vec<TextEdit>, Option<Value>), String> {
    let kind = op["kind"].as_str().expect("op kind");
    let list = |op: &serde_json::Value| -> ListAction {
        serde_json::from_value(op["action"].clone()).expect("list action")
    };
    match kind {
        "fm_list" => {
            return splice::frontmatter_list(text, op["key"].as_str().expect("key"), &list(op))
                .map(|edit| (edit.edits, edit.popped))
                .map_err(|e| e.to_string());
        }
        "section_list" => {
            return splice::section_list(
                text,
                op["plugin"].as_str().expect("plugin"),
                op["key"].as_str().expect("key"),
                &list(op),
            )
            .map(|edit| (edit.edits, edit.popped))
            .map_err(|e| e.to_string());
        }
        _ => {}
    }
    let result = match kind {
        "set_fm" => splice::set_frontmatter_value(
            text,
            op["key"].as_str().expect("key"),
            &Value::from_json(&op["value"]),
        ),
        "remove_fm" => splice::remove_frontmatter_key(text, op["key"].as_str().expect("key")),
        "splice_section" => {
            let edits: Vec<SectionLineEdit> = op["edits"]
                .as_array()
                .expect("edits array")
                .iter()
                .map(|edit| SectionLineEdit {
                    key: edit["key"].as_str().expect("key").to_string(),
                    value: match edit.get("remove").and_then(|r| r.as_bool()) {
                        Some(true) => None,
                        _ => Some(Value::from_json(&edit["value"])),
                    },
                })
                .collect();
            splice::splice_section(text, op["plugin"].as_str().expect("plugin"), &edits)
        }
        "remove_section" => splice::remove_section(text, op["plugin"].as_str().expect("plugin")),
        other => panic!("unknown splice op {other}"),
    };
    result.map(|edits| (edits, None)).map_err(|e| e.to_string())
}

struct CorpusRow {
    id: String,
    title: String,
    content: String,
    fm: Map,
    plugins: Map,
    created_at: Date,
    updated_at: Date,
    deleted_at: Option<Date>,
    deleted: bool,
}

impl CorpusRow {
    fn row(&self) -> Row<'_> {
        Row {
            id: &self.id,
            title: &self.title,
            content: &self.content,
            fm: &self.fm,
            plugins: &self.plugins,
            created_at: Some(&self.created_at),
            updated_at: Some(&self.updated_at),
            deleted_at: self.deleted_at.as_ref(),
            deleted: self.deleted,
        }
    }

    fn bson(&self) -> bson::Document {
        let mut doc = bson::Document::new();
        doc.insert("_id", self.id.clone());
        doc.insert("title", self.title.clone());
        doc.insert("content", self.content.clone());
        doc.insert("fm", map_to_bson(&self.fm));
        doc.insert("plugins", map_to_bson(&self.plugins));
        doc.insert(
            "created_at",
            bson::DateTime::from_millis(self.created_at.epoch_millis()),
        );
        doc.insert(
            "updated_at",
            bson::DateTime::from_millis(self.updated_at.epoch_millis()),
        );
        if let Some(deleted_at) = self.deleted_at.as_ref() {
            doc.insert(
                "deleted_at",
                bson::DateTime::from_millis(deleted_at.epoch_millis()),
            );
        }
        doc
    }
}

fn corpus_rows(corpus: &serde_json::Value) -> Vec<CorpusRow> {
    corpus["rows"]
        .as_array()
        .expect("rows array")
        .iter()
        .map(|row| CorpusRow {
            id: row["id"].as_str().expect("id").to_string(),
            title: row["title"].as_str().expect("title").to_string(),
            content: row["content"].as_str().expect("content").to_string(),
            fm: json_map(&row["fm"]),
            plugins: json_map(&row["plugins"]),
            created_at: Date::parse(row["created_at"].as_str().expect("created_at"))
                .expect("created_at parses"),
            updated_at: Date::parse(row["updated_at"].as_str().expect("updated_at"))
                .expect("updated_at parses"),
            deleted: row["deleted"].as_bool().expect("deleted"),
            deleted_at: row["deleted"].as_bool().expect("deleted").then(|| {
                Date::parse(row["updated_at"].as_str().expect("updated_at"))
                    .expect("updated_at parses")
            }),
        })
        .collect()
}

#[test]
fn filter_corpus_evaluator_and_mongo_agree() {
    let corpus = common::corpus("filters.json");
    let rows = corpus_rows(&corpus);
    let cases = corpus["cases"].as_array().expect("cases array");
    assert!(cases.len() >= 30, "the corpus should stay broad");

    for case in cases {
        let name = case["name"].as_str().expect("name");
        let filter = Filter::from_json(&case["filter"])
            .unwrap_or_else(|e| panic!("{name}: filter does not parse: {e}"));
        let expected: Vec<&str> = case["matches"]
            .as_array()
            .expect("matches array")
            .iter()
            .map(|id| id.as_str().expect("id"))
            .collect();

        let evaluated: Vec<&str> = rows
            .iter()
            .filter(|row| evaluate(&filter, &row.row()).unwrap_or_else(|e| panic!("{name}: {e}")))
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(evaluated, expected, "{name}: evaluator");

        let query =
            mongo::compile(&filter).unwrap_or_else(|e| panic!("{name}: does not compile: {e}"));
        let compiled: Vec<&str> = rows
            .iter()
            .filter(|row| common::mongo_matches(&row.bson(), &query))
            .map(|row| row.id.as_str())
            .collect();
        assert_eq!(
            compiled, expected,
            "{name}: compiled query {query:?} disagrees with the evaluator"
        );

        assert_eq!(
            Filter::from_json(&filter.to_json()).expect("round-trip"),
            filter,
            "{name}: wire form"
        );
    }
}

#[test]
fn filter_corpus_errors_are_refused_by_both_sides() {
    let corpus = common::corpus("filters.json");
    let rows = corpus_rows(&corpus);
    for case in corpus["errors"].as_array().expect("errors array") {
        let name = case["name"].as_str().expect("name");
        let filter = Filter::from_json(&case["filter"])
            .unwrap_or_else(|e| panic!("{name}: should parse but not evaluate: {e}"));
        for row in &rows {
            assert!(
                evaluate(&filter, &row.row()).is_err(),
                "{name}: the evaluator should refuse this filter"
            );
        }
        assert!(
            mongo::compile(&filter).is_err(),
            "{name}: the compiler should refuse this filter"
        );
    }
}

#[test]
fn filter_corpus_rejects_bad_wire_forms() {
    let corpus = common::corpus("filters.json");
    for case in corpus["rejected_wire_forms"]
        .as_array()
        .expect("rejected array")
    {
        let name = case["name"].as_str().expect("name");
        let json = case["json"].as_str().expect("json");
        assert!(
            Filter::from_json_str(json).is_err(),
            "{name}: {json} should be rejected"
        );
    }
}

#[test]
fn filter_corpus_sorting() {
    let corpus = common::corpus("filters.json");
    let rows = corpus_rows(&corpus);

    for case in corpus["sorts"].as_array().expect("sorts array") {
        let name = case["name"].as_str().expect("name");
        let keys: Vec<SortKey> = case["keys"]
            .as_array()
            .expect("keys")
            .iter()
            .map(|key| SortKey::parse(key.as_str().expect("key")).expect("sort key parses"))
            .collect();
        let mut sorted: Vec<&CorpusRow> = rows.iter().collect();
        sorted.sort_by(|a, b| compare_rows(&a.row(), &b.row(), &keys));
        let actual: Vec<&str> = sorted.iter().map(|row| row.id.as_str()).collect();
        let expected: Vec<&str> = case["order"]
            .as_array()
            .expect("order")
            .iter()
            .map(|id| id.as_str().expect("id"))
            .collect();
        assert_eq!(actual, expected, "{name}: ordering");

        let mut reversed: Vec<&CorpusRow> = rows.iter().rev().collect();
        reversed.sort_by(|a, b| compare_rows(&a.row(), &b.row(), &keys));
        let reordered: Vec<&str> = reversed.iter().map(|row| row.id.as_str()).collect();
        assert_eq!(reordered, actual, "{name}: ordering is not total");
    }

    for case in corpus["compiled_sorts"].as_array().expect("compiled_sorts") {
        let keys: Vec<SortKey> = case["keys"]
            .as_array()
            .expect("keys")
            .iter()
            .map(|key| SortKey::parse(key.as_str().expect("key")).expect("sort key parses"))
            .collect();
        let compiled = mongo::compile_sort(&keys).expect("compiles");
        let expected = case["expect"].as_object().expect("expect object");
        assert_eq!(compiled.len(), expected.len());
        for (path, direction) in expected {
            assert_eq!(
                compiled.get_i32(path).expect("direction"),
                direction.as_i64().expect("direction") as i32,
                "sort direction for {path}"
            );
        }
    }

    for field in corpus["unsortable"].as_array().expect("unsortable") {
        let key = SortKey::parse(field.as_str().expect("field")).expect("parses");
        assert!(
            mongo::compile_sort(&[key]).is_err(),
            "{field} should not be sortable"
        );
    }
}

fn map_to_json(map: &Map) -> serde_json::Value {
    serde_json::Value::Object(
        map.iter()
            .map(|(key, value)| (key.clone(), value.to_json()))
            .collect(),
    )
}

fn json_map(value: &serde_json::Value) -> Map {
    match Value::from_json(value) {
        Value::Map(map) => map,
        other => panic!("expected a JSON object, got {other:?}"),
    }
}

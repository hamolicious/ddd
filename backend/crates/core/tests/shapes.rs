mod common;

use ddd_core::shape::{Shape, validate};

#[test]
fn shape_corpus() {
    let corpus = common::corpus("shapes.json");
    let cases = corpus.as_array().expect("an array of cases");
    assert!(cases.len() >= 30, "the corpus should stay broad");
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let shape: Shape = serde_json::from_value(case["shape"].clone())
            .unwrap_or_else(|err| panic!("{name}: shape parses: {err}"));
        let ok = case["ok"].as_bool().expect("ok");
        let issues = validate(&case["value"], &shape);
        assert_eq!(issues.is_empty(), ok, "{name}: {issues:?}");
    }
}

//! `corpus/shapes.json` pins value validation against a shape (HOST-ABI §3.10): the server
//! checks backend call payloads with `shape::validate`, the web kernel checks `checked()`
//! calls with `shapeFromJSON` (`web/kernel-api/src/shape.ts`), and both suites run this
//! same file, so the two cannot disagree on what fits.
//!
//! Each case is `{ name, shape, value, ok }`; only `ok` is compared, because the issue
//! wording is each side's own.

mod common;

use life_manager_core::shape::{Shape, validate};

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

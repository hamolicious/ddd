//! `corpus/wiring.json` pins the resolver (PLUGIN-PROTOCOLS §9 step 4), the way
//! `corpus/splices.json` pins splicing. The same corpus runs through the Wasm build
//! (`web/scripts/wasm-smoke.mjs`), so the server and the wiring editor cannot disagree.
//!
//! A case lists only what it asserts: `order`, `skipped` (plugin → reason), `bindings`,
//! `seats`, `bench`, `listeners`, `status` (port → `code` or `code:count`), and
//! `diagnostics` (`"<severity> <code> <plugin>"`, sorted). A case with `plan` resolves a
//! second time with `plan.wiring` and checks the apply plan between the two.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use life_manager_core::wiring::{
    PluginDescriptor, ProtocolPackage, Resolution, ResolveInput, Wiring, plan, resolve,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Corpus {
    protocols: Vec<ProtocolPackage>,
    base_order: Vec<String>,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    plugins: Vec<PluginDescriptor>,
    #[serde(default)]
    wiring: Wiring,
    #[serde(default)]
    base_only: bool,
    #[serde(default)]
    expect: BTreeMap<String, Value>,
    #[serde(default)]
    plan: Option<PlanCase>,
}

#[derive(Deserialize)]
struct PlanCase {
    wiring: Wiring,
    #[serde(default)]
    hot: Vec<String>,
    expect: BTreeMap<String, Value>,
}

fn corpus() -> Corpus {
    let raw =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("corpus/wiring.json"))
            .expect("corpus/wiring.json");
    serde_json::from_str(&raw).expect("the corpus parses")
}

/// The parts of a resolution a case can assert, in the corpus's spelling.
fn observed(resolution: &Resolution) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    out.insert("order".into(), serde_json::json!(resolution.order));
    out.insert(
        "skipped".into(),
        serde_json::json!(
            resolution
                .skipped
                .iter()
                .map(|s| (s.plugin.clone(), serde_json::to_value(s.reason).unwrap()))
                .collect::<BTreeMap<_, _>>()
        ),
    );
    out.insert("bindings".into(), serde_json::json!(resolution.bindings));
    out.insert("seats".into(), serde_json::json!(resolution.seats));
    out.insert("bench".into(), serde_json::json!(resolution.bench));
    out.insert("listeners".into(), serde_json::json!(resolution.listeners));
    out.insert(
        "status".into(),
        serde_json::json!(
            resolution
                .status
                .iter()
                .map(|(port, status)| (
                    port.clone(),
                    match status.count {
                        Some(count) => format!("{}:{count}", status.code),
                        None => status.code.clone(),
                    }
                ))
                .collect::<BTreeMap<_, _>>()
        ),
    );
    let mut diagnostics: Vec<String> = resolution
        .diagnostics
        .iter()
        .map(|d| {
            format!(
                "{} {} {}",
                serde_json::to_value(d.severity).unwrap().as_str().unwrap(),
                d.code,
                d.plugin
            )
        })
        .collect();
    diagnostics.sort();
    out.insert("diagnostics".into(), serde_json::json!(diagnostics));
    out
}

fn check(name: &str, got: &BTreeMap<String, Value>, want: &BTreeMap<String, Value>) {
    for (field, expected) in want {
        let actual = got
            .get(field)
            .unwrap_or_else(|| panic!("{name}: unknown field `{field}`"));
        assert_eq!(actual, expected, "{name}: `{field}`");
    }
}

#[test]
fn the_corpus() {
    let corpus = corpus();
    assert!(corpus.cases.len() >= 15, "the corpus covers the rules");
    for case in &corpus.cases {
        let input = ResolveInput {
            plugins: case.plugins.clone(),
            protocols: corpus.protocols.clone(),
            wiring: case.wiring.clone(),
            base_only: case.base_only,
        };
        let before = resolve(&input);
        check(&case.name, &observed(&before), &case.expect);

        if let Some(plan_case) = &case.plan {
            let after = resolve(&ResolveInput {
                wiring: plan_case.wiring.clone(),
                ..input.clone()
            });
            let hot: BTreeSet<String> = plan_case.hot.iter().cloned().collect();
            let steps = plan(&before, &after, &case.wiring, &plan_case.wiring, &hot);
            let got: BTreeMap<String, Value> =
                serde_json::from_value(serde_json::to_value(&steps).unwrap()).unwrap();
            check(&format!("{} (plan)", case.name), &got, &plan_case.expect);
        }
    }
}

/// The base distribution activates in the order it always has: the resolver over the real
/// manifests and protocol packages gives the order the loader computed before it existed,
/// pinned in the corpus (`web/app/src/loader/order.test.ts` pins the loader to the same list).
#[test]
fn the_base_distribution_keeps_its_order() {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../plugins/base");
    let mut plugins = Vec::new();
    let mut protocols = Vec::new();
    for entry in std::fs::read_dir(&base).expect("plugins/base").flatten() {
        let Ok(raw) = std::fs::read_to_string(entry.path().join("manifest.json")) else {
            continue;
        };
        let mut manifest: Value = serde_json::from_str(&raw).expect("manifest");
        let frontend = manifest
            .as_object_mut()
            .and_then(|m| m.remove("frontend"))
            .is_some();
        let mut descriptor: PluginDescriptor =
            serde_json::from_value(manifest).expect("descriptor");
        descriptor.base = true;
        descriptor.frontend = frontend;
        plugins.push(descriptor);
        if let Ok(dirs) = std::fs::read_dir(entry.path().join("protocols")) {
            for dir in dirs.flatten() {
                let raw = std::fs::read_to_string(dir.path().join("protocol.json"))
                    .expect("protocol.json");
                protocols.push(serde_json::from_str(&raw).expect("a package"));
            }
        }
    }
    let resolution = resolve(&ResolveInput {
        plugins,
        protocols,
        wiring: Wiring::default(),
        base_only: false,
    });
    assert_eq!(resolution.skipped, vec![], "every base plugin activates");
    assert_eq!(resolution.order, corpus().base_order);
    assert_eq!(resolution.errors(), 0, "{:#?}", resolution.diagnostics);
}

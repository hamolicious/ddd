//! Load resolution (`@kernel` 3.0): which served plugins the client loads, in which order,
//! and why the rest do not.
//!
//! A plugin names the plugins it uses in `dependencies` (id → semver range) and
//! `optionalDependencies`. From that and the enabled set this module computes, once, on the
//! server:
//!
//! - `normal`: the ids a normal boot loads, dependencies first;
//! - `safe`: the same for `?safe=1`, over the base distribution only;
//! - `skipped`: every wanted plugin of the normal boot that cannot load, with the reason.
//!
//! The rules:
//!
//! 1. **Candidates** are the plugins an admin wants loaded ([`InstalledPlugin::wants_load`]).
//!    A disabled plugin is simply absent; it is not a problem.
//! 2. **Effective ids.** A plugin answers to its own id and, with `provides: "x@1.2.0"`, to
//!    `x` at version 1.2.0. Only one candidate may hold an effective id: the plugin whose
//!    own id it is wins, else the lowest id; the others are skipped as `conflict`.
//! 3. **Required dependencies.** Each must be held by a candidate (`missing` otherwise)
//!    whose version — the provided one, for a stand-in — satisfies the range (`version`).
//! 4. **Cascade.** A plugin whose required dependency is skipped is skipped too
//!    (`dependency-skipped`).
//! 5. **Order.** Kahn's algorithm, a layer at a time, each layer sorted by id, so the order
//!    is deterministic. Optional dependencies that are present order before their
//!    dependents, but never skip one: a cycle through an optional edge is broken by
//!    dropping that edge. A cycle of required edges skips its members (`cycle`), and
//!    whatever depends on them (`dependency-skipped`).
//!
//! Pure: the registry's plugins in, a [`LoadPlan`] out. Versions are checked with
//! [`crate::plugins::satisfies`], the server's one semver implementation.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::plugins::{InstalledPlugin, satisfies};

/// Why a wanted plugin does not load.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkipReason {
    /// A required dependency is not installed, or not enabled.
    Missing,
    /// A required dependency is there, at a version outside the range.
    Version,
    /// In a cycle of required dependencies.
    Cycle,
    /// A required dependency is itself skipped.
    DependencySkipped,
    /// Another enabled plugin holds the same id (`provides`).
    Conflict,
}

/// One plugin that does not load, for `/api/plugins`'s `load.skipped`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    pub id: String,
    pub reason: SkipReason,
    /// One sentence for the notice strip and the admin screen.
    pub detail: String,
}

/// `load` in `GET /api/plugins`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LoadPlan {
    /// Normal boot: ids in load order.
    pub normal: Vec<String>,
    /// `?safe=1`: base plugins only, in load order.
    pub safe: Vec<String>,
    /// Wanted by the normal boot, not loaded. Sorted by id.
    pub skipped: Vec<Skipped>,
}

/// The effective ids a plugin answers to, with the version each is checked at: its own,
/// and the one it `provides`.
fn effective(plugin: &InstalledPlugin) -> Vec<(String, String)> {
    effective_ids(&plugin.manifest)
}

/// The ids a manifest answers to, with the version each is checked at: its own id and
/// version, and — for a stand-in — the id and version it `provides`.
pub fn effective_ids(manifest: &crate::plugins::PluginManifest) -> Vec<(String, String)> {
    let mut out = vec![(manifest.id.clone(), manifest.version.clone())];
    if let Some((id, version)) = manifest
        .provides
        .as_deref()
        .and_then(crate::manifest_schema::parse_plugin_ref)
        && id != manifest.id
    {
        out.push((id.to_string(), version.to_string()));
    }
    out
}

/// The load order and skip list for every plugin in `plugins`.
pub fn resolve_load(plugins: &[InstalledPlugin]) -> LoadPlan {
    let normal = resolve_set(plugins, false);
    let safe = resolve_set(plugins, true);
    LoadPlan {
        normal: normal.order,
        safe: safe.order,
        skipped: normal.skipped,
    }
}

struct SetResolution {
    order: Vec<String>,
    skipped: Vec<Skipped>,
}

fn resolve_set(plugins: &[InstalledPlugin], base_only: bool) -> SetResolution {
    let by_id: BTreeMap<&str, &InstalledPlugin> = plugins
        .iter()
        .map(|plugin| (plugin.manifest.id.as_str(), plugin))
        .collect();
    let candidates: BTreeMap<&str, &InstalledPlugin> = by_id
        .iter()
        .filter(|(_, plugin)| plugin.wants_load() && (!base_only || plugin.base))
        .map(|(id, plugin)| (*id, *plugin))
        .collect();
    let mut skipped: BTreeMap<String, (SkipReason, String)> = BTreeMap::new();

    // --- effective ids and conflicts ------------------------------------------------
    let mut claims: BTreeMap<String, Vec<(&str, String)>> = BTreeMap::new();
    for (id, plugin) in &candidates {
        for (effective_id, version) in effective(plugin) {
            claims.entry(effective_id).or_default().push((id, version));
        }
    }
    // effective id → (holder, version it answers at)
    let mut holders: BTreeMap<String, (&str, String)> = BTreeMap::new();
    for (effective_id, mut claimants) in claims {
        // The owner of the id first, then by id: `claimants` is already in id order.
        claimants.sort_by_key(|(holder, _)| (*holder != effective_id, *holder));
        let mut claimants = claimants.into_iter();
        let (winner, version) = claimants.next().expect("a claim has a claimant");
        for (loser, _) in claimants {
            skipped.entry(loser.to_string()).or_insert((
                SkipReason::Conflict,
                format!(
                    "`{winner}` is also enabled as `{effective_id}`; only one of the two may be"
                ),
            ));
        }
        holders.insert(effective_id, (winner, version));
    }
    // A plugin that lost its own id or its `provides` is out entirely, so a holder that
    // was skipped for a conflict under its *other* id holds nothing.
    holders.retain(|_, (holder, _)| !skipped.contains_key(*holder));

    // --- required dependencies -------------------------------------------------------
    // (dependent, provider) edges, required and optional, over the plugins still in.
    let mut required: Vec<(&str, &str)> = Vec::new();
    let mut optional: Vec<(&str, &str)> = Vec::new();
    for (id, plugin) in &candidates {
        if skipped.contains_key(*id) {
            continue;
        }
        let manifest = &plugin.manifest;
        for (dependency, range) in &manifest.dependencies {
            match holders.get(dependency) {
                None => {
                    let why = match by_id.get(dependency.as_str()) {
                        None => "is not installed".to_string(),
                        Some(present) if !present.wants_load() => "is disabled".to_string(),
                        Some(_) if base_only => {
                            "is not part of the base distribution (safe mode)".to_string()
                        }
                        Some(_) => "does not load".to_string(),
                    };
                    skipped.entry(id.to_string()).or_insert((
                        SkipReason::Missing,
                        format!("it depends on `{dependency}` {range}, which {why}"),
                    ));
                }
                Some((holder, version)) => match satisfies(version, range) {
                    Ok(true) => required.push((id, holder)),
                    Ok(false) => {
                        let via = if holder == dependency {
                            String::new()
                        } else {
                            format!(" (provided by `{holder}`)")
                        };
                        skipped.entry(id.to_string()).or_insert((
                            SkipReason::Version,
                            format!(
                                "it depends on `{dependency}` {range}, but {version} is installed{via}"
                            ),
                        ));
                    }
                    Err(err) => {
                        skipped.entry(id.to_string()).or_insert((
                            SkipReason::Version,
                            format!("its range for `{dependency}` cannot be checked: {err}"),
                        ));
                    }
                },
            }
        }
        for (dependency, range) in &manifest.optional_dependencies {
            // Present and in range: order before. Anything else: loads without it.
            if let Some((holder, version)) = holders.get(dependency)
                && matches!(satisfies(version, range), Ok(true))
            {
                optional.push((id, holder));
            }
        }
    }

    // --- cascade -------------------------------------------------------------------
    loop {
        let mut grew = false;
        for (dependent, provider) in &required {
            if !skipped.contains_key(*dependent) && skipped.contains_key(*provider) {
                skipped.insert(
                    dependent.to_string(),
                    (
                        SkipReason::DependencySkipped,
                        format!("it depends on `{provider}`, which does not load"),
                    ),
                );
                grew = true;
            }
        }
        if !grew {
            break;
        }
    }

    // --- order ---------------------------------------------------------------------
    let alive: BTreeSet<&str> = candidates
        .keys()
        .copied()
        .filter(|id| !skipped.contains_key(*id))
        .collect();
    let live = |edges: &[(&str, &str)]| -> Vec<(String, String)> {
        edges
            .iter()
            .filter(|(dependent, provider)| {
                dependent != provider && alive.contains(dependent) && alive.contains(provider)
            })
            .map(|(dependent, provider)| (dependent.to_string(), provider.to_string()))
            .collect()
    };
    let required_live = live(&required);
    let optional_live = live(&optional);
    let alive: BTreeSet<String> = alive.into_iter().map(str::to_string).collect();

    // Cycles of required edges first: their members, and everything downstream of them,
    // never load, whatever the optional edges say.
    let (_, stuck) = kahn(&alive, &required_live, &[]);
    if !stuck.is_empty() {
        let cyclic = on_cycles(&stuck, &required_live);
        let members = cyclic.iter().cloned().collect::<Vec<_>>().join(", ");
        for id in &stuck {
            let entry = if cyclic.contains(id) {
                (
                    SkipReason::Cycle,
                    format!("it is in a dependency cycle: {members}"),
                )
            } else {
                (
                    SkipReason::DependencySkipped,
                    "it depends on a plugin in a dependency cycle".to_string(),
                )
            };
            skipped.insert(id.clone(), entry);
        }
    }
    let alive: BTreeSet<String> = alive.difference(&stuck).cloned().collect();
    let (order, left) = kahn(&alive, &required_live, &optional_live);
    debug_assert!(left.is_empty(), "optional edges never strand a plugin");

    SetResolution {
        order,
        skipped: skipped
            .into_iter()
            .map(|(id, (reason, detail))| Skipped { id, reason, detail })
            .collect(),
    }
}

/// Kahn's algorithm a sorted layer at a time. `soft` edges order when they can and are
/// ignored when honouring them would stall (a cycle through an optional dependency).
/// Returns the order and whatever could not be placed.
fn kahn(
    nodes: &BTreeSet<String>,
    hard: &[(String, String)],
    soft: &[(String, String)],
) -> (Vec<String>, BTreeSet<String>) {
    let mut remaining = nodes.clone();
    let mut order = Vec::new();
    let waits_on = |id: &String, edges: &[(String, String)], remaining: &BTreeSet<String>| {
        edges
            .iter()
            .any(|(dependent, provider)| dependent == id && remaining.contains(provider))
    };
    while !remaining.is_empty() {
        let mut ready: Vec<String> = remaining
            .iter()
            .filter(|id| !waits_on(id, hard, &remaining) && !waits_on(id, soft, &remaining))
            .cloned()
            .collect();
        if ready.is_empty() {
            // Only soft edges can be holding this up once hard cycles are gone: let the
            // lowest id that no hard edge holds go first, and carry on.
            if let Some(first) = remaining
                .iter()
                .find(|id| !waits_on(id, hard, &remaining))
                .cloned()
            {
                ready.push(first);
            } else {
                break;
            }
        }
        for id in ready {
            remaining.remove(&id);
            order.push(id);
        }
    }
    (order, remaining)
}

/// The members of `stuck` that are on a cycle of `edges` (not merely downstream of one).
fn on_cycles(stuck: &BTreeSet<String>, edges: &[(String, String)]) -> BTreeSet<String> {
    let next = |from: &str| -> Vec<&str> {
        edges
            .iter()
            .filter(|(dependent, provider)| {
                dependent == from && stuck.contains(dependent) && stuck.contains(provider)
            })
            .map(|(_, provider)| provider.as_str())
            .collect()
    };
    stuck
        .iter()
        .filter(|start| {
            let mut seen: BTreeSet<&str> = BTreeSet::new();
            let mut frontier: Vec<&str> = next(start);
            while let Some(node) = frontier.pop() {
                if node == start.as_str() {
                    return true;
                }
                if seen.insert(node) {
                    frontier.extend(next(node));
                }
            }
            false
        })
        .cloned()
        .collect()
}

/// `plugin:<id>` import-map entries for everything either boot may load: each plugin's
/// frontend module, versioned with its assets fingerprint, and for a stand-in also
/// `plugin:<provided id>` → the same URL. The one way a plugin module is loaded, so every
/// importer shares one instance of it.
pub fn plugin_imports(plugins: &[InstalledPlugin], plan: &LoadPlan) -> BTreeMap<String, String> {
    let wanted: BTreeSet<&str> = plan
        .normal
        .iter()
        .chain(plan.safe.iter())
        .map(String::as_str)
        .collect();
    let normal: BTreeSet<&str> = plan.normal.iter().map(String::as_str).collect();
    let mut imports = BTreeMap::new();
    for plugin in plugins {
        let id = plugin.manifest.id.as_str();
        if !wanted.contains(id) {
            continue;
        }
        let Some(url) = module_url(plugin) else {
            continue;
        };
        for (effective_id, _) in effective(plugin) {
            // The alias only for a stand-in that actually won its id in a normal boot.
            if effective_id != id && !normal.contains(id) {
                continue;
            }
            imports.insert(format!("plugin:{effective_id}"), url.clone());
        }
    }
    imports
}

/// `/plugins/<id>/<version>/frontend/index.mjs?v=<assets>`.
pub fn module_url(plugin: &InstalledPlugin) -> Option<String> {
    let frontend = plugin.manifest.frontend.as_ref()?;
    let mut url = format!("{}{}", plugin.base_url, frontend.module);
    if let Some(assets) = plugin.assets_version.as_deref() {
        url.push_str("?v=");
        url.push_str(assets);
    }
    Some(url)
}

/// The version clients compare to know they run the current plugin set: a short hash of
/// every served plugin's `id@version#assets` and whether an admin wants it loaded, plus
/// both load orders. A circuit-breaker trip changes none of these
/// ([`InstalledPlugin::wants_load`]), so it never makes a client reload.
pub fn fingerprint(plugins: &[InstalledPlugin], plan: &LoadPlan) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    let mut sorted: Vec<&InstalledPlugin> = plugins.iter().collect();
    sorted.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    for plugin in sorted {
        hash.update(format!(
            "{}@{}#{}:{}\n",
            plugin.manifest.id,
            plugin.manifest.version,
            plugin.assets_version.as_deref().unwrap_or(""),
            plugin.wants_load()
        ));
    }
    hash.update(format!(
        "normal:{}\nsafe:{}\n",
        plan.normal.join(","),
        plan.safe.join(",")
    ));
    hex::encode(hash.finalize())[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::{PluginManifest, PluginState};

    struct P {
        id: &'static str,
        version: &'static str,
        deps: Vec<(&'static str, &'static str)>,
        optional: Vec<(&'static str, &'static str)>,
        provides: Option<&'static str>,
        state: PluginState,
        base: bool,
    }

    fn p(id: &'static str) -> P {
        P {
            id,
            version: "1.0.0",
            deps: vec![],
            optional: vec![],
            provides: None,
            state: PluginState::Enabled,
            base: true,
        }
    }

    impl P {
        fn v(mut self, version: &'static str) -> Self {
            self.version = version;
            self
        }
        fn dep(mut self, id: &'static str, range: &'static str) -> Self {
            self.deps.push((id, range));
            self
        }
        fn opt(mut self, id: &'static str, range: &'static str) -> Self {
            self.optional.push((id, range));
            self
        }
        fn provides(mut self, reference: &'static str) -> Self {
            self.provides = Some(reference);
            self
        }
        fn state(mut self, state: PluginState) -> Self {
            self.state = state;
            self
        }
        fn extra(mut self) -> Self {
            self.base = false;
            self
        }
        fn build(self) -> InstalledPlugin {
            let map = |pairs: &[(&str, &str)]| -> serde_json::Map<String, serde_json::Value> {
                pairs
                    .iter()
                    .map(|(id, range)| ((*id).to_string(), serde_json::json!(range)))
                    .collect()
            };
            let mut manifest = serde_json::json!({
                "id": self.id,
                "version": self.version,
                "kernel": "^3.0",
                "dependencies": map(&self.deps),
                "optionalDependencies": map(&self.optional),
                "frontend": { "module": "frontend/index.mjs" },
            });
            if let Some(provides) = self.provides {
                manifest["provides"] = serde_json::json!(provides);
            }
            let manifest: PluginManifest = serde_json::from_value(manifest).expect("manifest");
            InstalledPlugin {
                base_url: format!("/plugins/{}/{}/", self.id, self.version),
                base: self.base,
                state: self.state,
                manifest,
                assets_version: Some(format!("{}hash", self.id)),
                disabled_reason: match self.state {
                    PluginState::Disabled => Some("admin".to_string()),
                    _ => None,
                },
            }
        }
    }

    fn resolve(plugins: Vec<P>) -> LoadPlan {
        resolve_load(&plugins.into_iter().map(P::build).collect::<Vec<_>>())
    }

    fn reasons(plan: &LoadPlan) -> Vec<(&str, SkipReason)> {
        plan.skipped
            .iter()
            .map(|skip| (skip.id.as_str(), skip.reason))
            .collect()
    }

    #[test]
    fn dependencies_load_first_in_deterministic_layers() {
        let plan = resolve(vec![
            p("settings").dep("router", "^1.0"),
            p("router").dep("icons", "*"),
            p("icons"),
            p("indexer"),
            p("header").dep("settings", "^1.0").dep("icons", "^1.0"),
        ]);
        assert_eq!(
            plan.normal,
            vec!["icons", "indexer", "router", "settings", "header"]
        );
        assert!(plan.skipped.is_empty());
    }

    #[test]
    fn a_missing_or_disabled_dependency_skips_the_dependent() {
        let plan = resolve(vec![
            p("graph").dep("indexer", "^1.0"),
            p("kanban").dep("table", "^1.0"),
            p("table").state(PluginState::Disabled),
        ]);
        assert_eq!(plan.normal, Vec::<String>::new());
        assert_eq!(
            reasons(&plan),
            vec![
                ("graph", SkipReason::Missing),
                ("kanban", SkipReason::Missing)
            ]
        );
        assert!(plan.skipped[0].detail.contains("not installed"));
        assert!(plan.skipped[1].detail.contains("disabled"));
    }

    #[test]
    fn a_version_outside_the_range_skips_the_dependent() {
        let plan = resolve(vec![
            p("editor").v("2.1.0"),
            p("slash").dep("editor", "^1.0"),
            p("emoji").dep("editor", "~2.1.0"),
        ]);
        assert_eq!(plan.normal, vec!["editor", "emoji"]);
        assert_eq!(reasons(&plan), vec![("slash", SkipReason::Version)]);
        assert!(plan.skipped[0].detail.contains("2.1.0"));
    }

    #[test]
    fn skips_cascade_to_every_dependent() {
        let plan = resolve(vec![
            p("a").dep("gone", "*"),
            p("b").dep("a", "*"),
            p("c").dep("b", "*"),
            p("d"),
        ]);
        assert_eq!(plan.normal, vec!["d"]);
        assert_eq!(
            reasons(&plan),
            vec![
                ("a", SkipReason::Missing),
                ("b", SkipReason::DependencySkipped),
                ("c", SkipReason::DependencySkipped),
            ]
        );
    }

    #[test]
    fn a_required_cycle_skips_its_members_and_what_depends_on_them() {
        let plan = resolve(vec![
            p("a").dep("b", "*"),
            p("b").dep("c", "*"),
            p("c").dep("a", "*"),
            p("d").dep("a", "*"),
            p("e"),
        ]);
        assert_eq!(plan.normal, vec!["e"]);
        assert_eq!(
            reasons(&plan),
            vec![
                ("a", SkipReason::Cycle),
                ("b", SkipReason::Cycle),
                ("c", SkipReason::Cycle),
                ("d", SkipReason::DependencySkipped),
            ]
        );
    }

    #[test]
    fn optional_dependencies_order_but_never_skip() {
        let plan = resolve(vec![
            // Present: orders before.
            p("a").opt("z", "*"),
            p("z"),
            // Absent, or out of range: loads anyway.
            p("b").opt("nope", "*"),
            p("c").opt("z", "^9.0"),
            // A cycle through an optional edge is broken, not skipped.
            p("x").dep("y", "*"),
            p("y").opt("x", "*"),
        ]);
        assert!(plan.skipped.is_empty(), "{:?}", plan.skipped);
        let at = |id: &str| plan.normal.iter().position(|x| x == id).unwrap();
        assert!(at("z") < at("a"));
        assert!(at("y") < at("x"));
        assert_eq!(plan.normal.len(), 6);
    }

    #[test]
    fn a_stand_in_satisfies_dependents_at_its_provided_version() {
        let plan = resolve(vec![
            p("editor").v("2.0.0").state(PluginState::Disabled),
            p("alt-editor").v("0.3.0").provides("editor@2.1.0").extra(),
            p("emoji").dep("editor", "^2.0"),
            p("old").dep("editor", "^1.0"),
        ]);
        assert_eq!(plan.normal, vec!["alt-editor", "emoji"]);
        assert_eq!(reasons(&plan), vec![("old", SkipReason::Version)]);
        assert!(plan.skipped[0].detail.contains("alt-editor"));

        let plugins: Vec<InstalledPlugin> = vec![
            p("editor").v("2.0.0").state(PluginState::Disabled).build(),
            p("alt-editor")
                .v("0.3.0")
                .provides("editor@2.1.0")
                .extra()
                .build(),
        ];
        let plan = resolve_load(&plugins);
        let imports = plugin_imports(&plugins, &plan);
        let url = "/plugins/alt-editor/0.3.0/frontend/index.mjs?v=alt-editorhash";
        assert_eq!(
            imports.get("plugin:alt-editor").map(String::as_str),
            Some(url)
        );
        assert_eq!(imports.get("plugin:editor").map(String::as_str), Some(url));
        assert_eq!(imports.len(), 2);
    }

    #[test]
    fn two_enabled_plugins_holding_one_id_conflict() {
        let plan = resolve(vec![
            p("editor").v("2.0.0"),
            p("alt-editor").provides("editor@2.0.0").extra(),
            p("emoji").dep("editor", "^2.0"),
        ]);
        // The owner of the id wins; the stand-in is the one skipped.
        assert_eq!(plan.normal, vec!["editor", "emoji"]);
        assert_eq!(reasons(&plan), vec![("alt-editor", SkipReason::Conflict)]);
    }

    #[test]
    fn safe_mode_is_the_base_distribution_only() {
        let plan = resolve(vec![
            p("router"),
            p("graph").dep("router", "*"),
            p("acme").extra(),
            p("needs-acme").dep("acme", "*"),
            p("off").state(PluginState::Disabled),
        ]);
        assert_eq!(plan.normal, vec!["acme", "router", "graph", "needs-acme"]);
        assert_eq!(plan.safe, vec!["router", "graph"]);
        // `skipped` describes the normal boot, where everything loads.
        assert!(plan.skipped.is_empty());
    }

    #[test]
    fn the_import_map_names_every_loaded_plugin() {
        let plugins: Vec<InstalledPlugin> = vec![
            p("router").build(),
            p("graph").dep("router", "*").build(),
            p("broken").dep("gone", "*").build(),
            p("off").state(PluginState::Disabled).build(),
        ];
        let plan = resolve_load(&plugins);
        let imports = plugin_imports(&plugins, &plan);
        assert_eq!(
            imports,
            BTreeMap::from([
                (
                    "plugin:graph".to_string(),
                    "/plugins/graph/1.0.0/frontend/index.mjs?v=graphhash".to_string()
                ),
                (
                    "plugin:router".to_string(),
                    "/plugins/router/1.0.0/frontend/index.mjs?v=routerhash".to_string()
                ),
            ])
        );
    }

    #[test]
    fn a_breaker_trip_does_not_change_the_fingerprint() {
        let mut plugins: Vec<InstalledPlugin> =
            vec![p("router").build(), p("graph").dep("router", "*").build()];
        let before = fingerprint(&plugins, &resolve_load(&plugins));

        plugins[0].state = PluginState::Disabled;
        plugins[0].disabled_reason = Some("5 consecutive failures; last: trap".to_string());
        let plan = resolve_load(&plugins);
        assert_eq!(
            plan.normal,
            vec!["router", "graph"],
            "the frontend still loads"
        );
        assert_eq!(fingerprint(&plugins, &plan), before);

        plugins[0].disabled_reason = Some("admin".to_string());
        let plan = resolve_load(&plugins);
        assert!(plan.normal.is_empty());
        assert_ne!(fingerprint(&plugins, &plan), before);
    }
}

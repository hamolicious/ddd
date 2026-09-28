//! Plugin wiring (PLUGIN-PROTOCOLS §6): which provided port feeds which consumed port.
//!
//! This module is the one place wiring is understood. The server stores and resolves it
//! natively; the wiring editor runs the same code in the browser through Wasm. Everything
//! here is pure data in, data out.
//!
//! A [`Wiring`] records only the choices a person made. Everything else is automatic.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// `wiring.json`: the overrides on top of automatic wiring, per workspace.
///
/// Keys are port keys, `<plugin>:<port>`; wires are `"<from> -> <to>"`, provider first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Wiring {
    /// Plugins switched off. Mirrors `PluginState::Disabled` both ways, so the server, the
    /// circuit breaker and backend halves keep one gate.
    #[serde(default)]
    pub unplugged: Vec<String>,
    /// Service ports pinned to a provider port, or to `null`: deliberately unbound.
    #[serde(default)]
    pub bind: BTreeMap<String, Option<String>>,
    /// Automatic slot and event wires someone cut.
    #[serde(default)]
    pub cut: Vec<String>,
    /// Wires someone added by hand (for slots, possibly across protocols: "by shape").
    #[serde(default)]
    pub add: Vec<String>,
    /// Host port → its seats, in order, from the first edit onwards.
    #[serde(default)]
    pub order: BTreeMap<String, Vec<String>>,
}

/// The arrow between the two port keys of a wire.
pub const WIRE_ARROW: &str = " -> ";

impl Wiring {
    /// The same wiring in its canonical form: sorted, de-duplicated lists, so two wirings
    /// that mean the same thing compare equal and serialize to the same bytes.
    pub fn normalized(mut self) -> Wiring {
        for list in [&mut self.unplugged, &mut self.cut, &mut self.add] {
            list.sort();
            list.dedup();
        }
        self.order.retain(|_, seats| !seats.is_empty());
        for seats in self.order.values_mut() {
            let mut seen = std::collections::BTreeSet::new();
            seats.retain(|seat| seen.insert(seat.clone()));
        }
        self
    }

    /// Forget a plugin that has been uninstalled: its unplug flag, its pins, its cut and added
    /// wires, and its seats — on both sides of every entry.
    pub fn drop_plugin(&mut self, plugin: &str) {
        let mine = |key: &str| port_plugin(key) == Some(plugin);
        let wire_mine =
            |wire: &str| split_wire(wire).is_some_and(|(from, to)| mine(from) || mine(to));
        self.unplugged.retain(|id| id != plugin);
        self.bind
            .retain(|port, bound| !mine(port) && !bound.as_deref().is_some_and(mine));
        self.cut.retain(|wire| !wire_mine(wire));
        self.add.retain(|wire| !wire_mine(wire));
        self.order.retain(|host, _| !mine(host));
        for seats in self.order.values_mut() {
            seats.retain(|seat| !mine(seat));
        }
        self.order.retain(|_, seats| !seats.is_empty());
    }

    /// Is `plugin` unplugged here?
    pub fn is_unplugged(&self, plugin: &str) -> bool {
        self.unplugged.iter().any(|id| id == plugin)
    }
}

/// `graph:index` → `graph`. The port name never contains `:`, so the last one splits.
pub fn port_plugin(key: &str) -> Option<&str> {
    key.rsplit_once(':').map(|(plugin, _)| plugin)
}

/// `graph:index` → `("graph", "index")`.
pub fn split_port(key: &str) -> Option<(&str, &str)> {
    key.rsplit_once(':')
}

/// `"a:x -> b:y"` → `("a:x", "b:y")`.
pub fn split_wire(wire: &str) -> Option<(&str, &str)> {
    wire.split_once(WIRE_ARROW)
}

/// `("a:x", "b:y")` → `"a:x -> b:y"`.
pub fn wire(from: &str, to: &str) -> String {
    format!("{from}{WIRE_ARROW}{to}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropping_a_plugin_forgets_it_everywhere() {
        let mut wiring = Wiring {
            unplugged: vec!["notices".into(), "acme".into()],
            bind: BTreeMap::from([
                ("graph:index".into(), Some("acme:index".into())),
                ("acme:router".into(), Some("router:router".into())),
                ("folders:router".into(), None),
            ]),
            cut: vec![
                wire("acme:pill", "header:items"),
                wire("sync-status:pill", "header:items"),
            ],
            add: vec![wire("acme:panel", "shell-ui:sidebar")],
            order: BTreeMap::from([
                (
                    "shell-ui:sidebar".into(),
                    vec!["folders:tree".into(), "acme:panel".into()],
                ),
                ("acme:items".into(), vec!["x:y".into()]),
                ("header:items".into(), vec!["acme:pill".into()]),
            ]),
        };
        wiring.drop_plugin("acme");
        assert_eq!(wiring.unplugged, vec!["notices".to_string()]);
        assert_eq!(
            wiring.bind,
            BTreeMap::from([("folders:router".to_string(), None)])
        );
        assert_eq!(wiring.cut, vec![wire("sync-status:pill", "header:items")]);
        assert!(wiring.add.is_empty());
        assert_eq!(
            wiring.order,
            BTreeMap::from([(
                "shell-ui:sidebar".to_string(),
                vec!["folders:tree".to_string()]
            )])
        );
    }

    #[test]
    fn the_wire_format_round_trips() {
        let wiring: Wiring = serde_json::from_str(
            r#"{ "unplugged": ["b", "a", "a"], "bind": { "graph:index": null }, "order": { "h:p": [] } }"#,
        )
        .unwrap();
        let wiring = wiring.normalized();
        assert_eq!(wiring.unplugged, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(wiring.bind.get("graph:index"), Some(&None));
        assert!(wiring.order.is_empty());
        let json = serde_json::to_value(&wiring).unwrap();
        assert_eq!(json["bind"]["graph:index"], serde_json::Value::Null);
        assert_eq!(split_port("doc-list:list"), Some(("doc-list", "list")));
    }
}

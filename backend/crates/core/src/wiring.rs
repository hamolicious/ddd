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

// ---------------------------------------------------------------------------
// Protocols and shapes (PLUGIN-PROTOCOLS §3, §6b)
// ---------------------------------------------------------------------------

/// `service`: one provider per consumer port. `slot`: many contributors feed a host port in
/// seat order. `event`: a typed message stream, many to many.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProtocolKind {
    Service,
    Slot,
    Event,
}

/// A shape in the `s.*` vocabulary, as plain JSON: `"string"`, `{ "object": { … } }`, …
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Shape {
    /// `string`, `number`, `boolean`, `func`, `promise`, `component`, `any`.
    Primitive(String),
    Literal {
        literal: Vec<serde_json::Value>,
    },
    Union {
        union: Vec<Shape>,
    },
    Array {
        array: Box<Shape>,
    },
    Record {
        record: Box<Shape>,
    },
    Object {
        object: BTreeMap<String, Shape>,
    },
    Optional {
        optional: Box<Shape>,
    },
}

/// A slot's duplicate rule: one field, or several joined with `|`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProtocolKey {
    One(String),
    Many(Vec<String>),
}

impl ProtocolKey {
    pub fn fields(&self) -> Vec<&str> {
        match self {
            ProtocolKey::One(field) => vec![field.as_str()],
            ProtocolKey::Many(fields) => fields.iter().map(String::as_str).collect(),
        }
    }
}

/// `protocol.json`: generated from the package's `shape.mjs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProtocolPackage {
    pub id: String,
    pub version: String,
    pub kind: ProtocolKind,
    /// The plugin that ships it.
    pub owner: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types: Option<String>,
    pub shape: Shape,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<ProtocolKey>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sticky: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl ProtocolPackage {
    /// `lm/router@1.0.0`.
    pub fn key(&self) -> String {
        format!("{}@{}", self.id, self.version)
    }
}

impl Shape {
    fn describe(&self) -> String {
        match self {
            Shape::Primitive(name) => name.clone(),
            Shape::Literal { literal } => literal
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join(" | "),
            Shape::Union { union } => union
                .iter()
                .map(Shape::describe)
                .collect::<Vec<_>>()
                .join(" | "),
            Shape::Array { array } => format!("{}[]", array.describe()),
            Shape::Record { record } => format!("Record<{}>", record.describe()),
            Shape::Object { .. } => "{ … }".to_string(),
            Shape::Optional { optional } => format!("{}?", optional.describe()),
        }
    }

    /// The fields of an object shape; empty for anything else.
    pub fn fields(&self) -> Option<&BTreeMap<String, Shape>> {
        match self {
            Shape::Object { object } => Some(object),
            _ => None,
        }
    }

    /// The same shape cut down to `needs`: what a consumer port actually asks for. Keys the
    /// shape does not have are dropped here; install refuses them (§4).
    pub fn narrowed(&self, needs: Option<&[String]>) -> Shape {
        match (self, needs) {
            (Shape::Object { object }, Some(needs)) => Shape::Object {
                object: object
                    .iter()
                    .filter(|(key, _)| needs.iter().any(|need| need == *key))
                    .map(|(key, shape)| (key.clone(), shape.clone()))
                    .collect(),
            },
            _ => self.clone(),
        }
    }
}

/// Every reason offering `provided` where `needed` is required fails (§6b). Empty means it
/// fits: extra keys are fine, a missing required key is not, and an optional key may be
/// absent but must match when present.
pub fn fits(provided: &Shape, needed: &Shape) -> Vec<String> {
    let mut problems = Vec::new();
    fits_at(provided, needed, "", &mut problems);
    problems
}

fn fits_at(provided: &Shape, needed: &Shape, path: &str, out: &mut Vec<String>) {
    let at = if path.is_empty() {
        "value".to_string()
    } else {
        format!("`{path}`")
    };
    match needed {
        Shape::Primitive(name) if name == "any" => {}
        Shape::Object { object: needs } => {
            let Shape::Object { object: offers } = provided else {
                out.push(format!("{at} is {}, needs an object", provided.describe()));
                return;
            };
            for (key, need) in needs {
                let key_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                let (need, required) = match need {
                    Shape::Optional { optional } => (optional.as_ref(), false),
                    other => (other, true),
                };
                match offers.get(key) {
                    None if required => out.push(format!("missing required `{key_path}`")),
                    None => {}
                    Some(Shape::Optional { .. }) if required => {
                        out.push(format!("`{key_path}` may be absent, but is required"));
                    }
                    Some(Shape::Optional { optional }) => fits_at(optional, need, &key_path, out),
                    Some(offer) => fits_at(offer, need, &key_path, out),
                }
            }
        }
        Shape::Literal { literal: allowed } => {
            let ok = matches!(provided, Shape::Literal { literal } if literal.iter().all(|value| allowed.contains(value)));
            if !ok {
                out.push(format!(
                    "{at} is {}, needs {}",
                    provided.describe(),
                    needed.describe()
                ));
            }
        }
        Shape::Array { array: item } => match provided {
            Shape::Array { array } => fits_at(array, item, &format!("{path}[]"), out),
            _ => out.push(format!(
                "{at} is {}, needs {}",
                provided.describe(),
                needed.describe()
            )),
        },
        Shape::Record { record: item } => match provided {
            Shape::Record { record } => fits_at(record, item, &format!("{path}{{}}"), out),
            _ => out.push(format!(
                "{at} is {}, needs {}",
                provided.describe(),
                needed.describe()
            )),
        },
        Shape::Union { union: members } => {
            // A provided union fits when each of its members fits some needed member; a
            // plain provided shape fits when it fits any member.
            let options: Vec<&Shape> = match provided {
                Shape::Union { union } => union.iter().collect(),
                other => vec![other],
            };
            let ok = options
                .iter()
                .all(|option| members.iter().any(|member| fits(option, member).is_empty()));
            if !ok {
                out.push(format!(
                    "{at} is {}, needs {}",
                    provided.describe(),
                    needed.describe()
                ));
            }
        }
        Shape::Optional { optional } => fits_at(provided, optional, path, out),
        Shape::Primitive(name) => {
            let ok = match provided {
                Shape::Primitive(offer) => offer == name,
                // A literal of strings is a string, and so on.
                Shape::Literal { literal } => literal.iter().all(|value| match name.as_str() {
                    "string" => value.is_string(),
                    "number" => value.is_number(),
                    "boolean" => value.is_boolean(),
                    _ => false,
                }),
                _ => false,
            };
            if !ok {
                out.push(format!("{at} is {}, needs {name}", provided.describe()));
            }
        }
    }
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

    fn shape(json: &str) -> Shape {
        serde_json::from_str(json).expect("a shape")
    }

    /// The type-check table of PLUGIN-PROTOCOLS §6b, row by row.
    #[test]
    fn the_type_check_table() {
        let fits_ = |offer: &str, need: &str| fits(&shape(offer), &shape(need));
        // Extra keys are ignored.
        assert!(
            fits_(
                r#"{"object":{"id":"string","title":"string","icon":"any"}}"#,
                r#"{"object":{"id":"string","title":"string"}}"#
            )
            .is_empty()
        );
        // A missing required key is refused.
        assert_eq!(
            fits_(
                r#"{"object":{"id":"string","query":"func"}}"#,
                r#"{"object":{"id":"string","search":"func"}}"#
            ),
            vec!["missing required `search`".to_string()]
        );
        // A mistyped key is refused.
        assert_eq!(
            fits_(
                r#"{"object":{"id":"number"}}"#,
                r#"{"object":{"id":"string"}}"#
            ),
            vec!["`id` is number, needs string".to_string()]
        );
        // An optional key may be absent...
        assert!(
            fits_(
                r#"{"object":{}}"#,
                r#"{"object":{"title":{"optional":"string"}}}"#
            )
            .is_empty()
        );
        // ...but if it is there, its type must match.
        assert_eq!(
            fits_(
                r#"{"object":{"title":"number"}}"#,
                r#"{"object":{"title":{"optional":"string"}}}"#
            )
            .len(),
            1
        );
        // The provider may not leave out a key the consumer requires.
        assert_eq!(
            fits_(
                r#"{"object":{"label":{"optional":"string"}}}"#,
                r#"{"object":{"label":"string"}}"#
            ),
            vec!["`label` may be absent, but is required".to_string()]
        );
        // Literals must be a subset; a literal of strings is a string.
        assert!(
            fits_(
                r#"{"literal":["light"]}"#,
                r#"{"literal":["light","dark"]}"#
            )
            .is_empty()
        );
        assert!(!fits_(r#""string""#, r#"{"literal":["light","dark"]}"#).is_empty());
        assert!(fits_(r#"{"literal":["light"]}"#, r#""string""#).is_empty());
        // Arrays, records and nested objects, recursively.
        assert!(fits_(r#"{"array":"string"}"#, r#"{"array":"string"}"#).is_empty());
        assert_eq!(
            fits_(r#"{"record":"number"}"#, r#"{"record":"string"}"#),
            vec!["`{}` is number, needs string".to_string()]
        );
        assert_eq!(
            fits_(
                r#"{"object":{"a":{"object":{"b":"number"}}}}"#,
                r#"{"object":{"a":{"object":{"b":"string"}}}}"#
            ),
            vec!["`a.b` is number, needs string".to_string()]
        );
        // Functions: presence and kind only.
        assert!(fits_(r#""func""#, r#""func""#).is_empty());
        // `any` accepts everything.
        assert!(fits_(r#"{"object":{}}"#, r#""any""#).is_empty());
    }

    #[test]
    fn needs_narrow_a_shape() {
        let full = shape(r#"{"object":{"navigate":"func","query":"func","url":"func"}}"#);
        let narrowed = full.narrowed(Some(&["navigate".to_string(), "nope".to_string()]));
        assert_eq!(narrowed, shape(r#"{"object":{"navigate":"func"}}"#));
        assert_eq!(full.narrowed(None), full);
    }

    #[test]
    fn a_protocol_package_parses() {
        let pkg: ProtocolPackage = serde_json::from_str(
            r#"{ "id": "lm/keybindings.default", "version": "1.0.0", "kind": "slot", "owner": "commands",
                 "key": ["keys", "command"], "shape": { "object": { "keys": "string", "command": "string" } } }"#,
        )
        .unwrap();
        assert_eq!(pkg.key(), "lm/keybindings.default@1.0.0");
        assert_eq!(pkg.key.unwrap().fields(), vec!["keys", "command"]);
        assert_eq!(pkg.kind, ProtocolKind::Slot);
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

//! Shapes: the `s.*` vocabulary of `@kernel` (`web/kernel-api/src/shape.ts`) as plain
//! JSON, and the two questions asked of one.
//!
//! - [`validate`]: does this *value* fit the shape? The server asks it at the backend call
//!   boundary (`backend.exports` input and output, HOST-ABI §3.10). Same rules as
//!   `validate(shapeFromJSON(json), value)` on the web side; `corpus/shapes.json` is run
//!   by both test suites so the two stay one definition.
//! - [`fits`]: does one *shape* fit another (an offered shape where a needed one is
//!   required)? Structural subtyping, kept for tooling.
//!
//! Pure data in, data out, like the rest of this crate.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A shape in the `s.*` vocabulary, as plain JSON: `"string"`, `{ "object": { … } }`, …
///
/// Variant order mirrors `shapeFromJSON`'s checks, so a malformed node with two keys is
/// read the same way on both sides. Anything unrecognised is [`Shape::Unknown`], which
/// accepts every value (`shapeFromJSON` falls back to `any` the same way).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Shape {
    /// `string`, `number`, `boolean`, `func`, `promise`, `component`, `any`. Any other
    /// string reads as `any`.
    Primitive(String),
    Literal {
        literal: Vec<Value>,
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
    Optional {
        optional: Box<Shape>,
    },
    Object {
        object: BTreeMap<String, Shape>,
    },
    /// Not a shape this build understands: accepts anything.
    Unknown(Value),
}

/// One reason a value does not fit, in the web validator's `ShapeIssue` form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Issue {
    /// Dotted path into the value (`items[2].title`); `""` is the value itself.
    pub path: String,
    pub expected: String,
    pub got: String,
}

impl std::fmt::Display for Issue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let at = if self.path.is_empty() {
            "value"
        } else {
            &self.path
        };
        write!(f, "{at}: expected {}, got {}", self.expected, self.got)
    }
}

impl Shape {
    /// The shape's display name, as `@kernel` spells it (`string[]`, `{ a, b }`, `x?`).
    pub fn name(&self) -> String {
        match self {
            Shape::Primitive(name) => match name.as_str() {
                "func" => "function".to_string(),
                "string" | "number" | "boolean" | "promise" | "component" => name.clone(),
                _ => "any".to_string(),
            },
            Shape::Literal { literal } => literal
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join(" | "),
            Shape::Union { union } => union
                .iter()
                .map(Shape::name)
                .collect::<Vec<_>>()
                .join(" | "),
            Shape::Array { array } => format!("{}[]", array.name()),
            Shape::Record { record } => format!("record<{}>", record.name()),
            Shape::Optional { optional } => format!("{}?", optional.name()),
            Shape::Object { object } => format!(
                "{{ {} }}",
                object.keys().cloned().collect::<Vec<_>>().join(", ")
            ),
            Shape::Unknown(_) => "any".to_string(),
        }
    }

    /// The fields of an object shape; `None` for anything else.
    pub fn fields(&self) -> Option<&BTreeMap<String, Shape>> {
        match self {
            Shape::Object { object } => Some(object),
            _ => None,
        }
    }
}

/// JavaScript's `typeof`, as the web validator reports it (`null` and `array` split out;
/// `undefined` for an absent field).
fn type_name(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
        Some(Value::String(_)) => "string",
        Some(Value::Number(_)) => "number",
        Some(Value::Bool(_)) => "boolean",
    }
}

/// Every reason `value` does not fit `shape`. Empty means it fits.
///
/// JSON has no functions or promises, so `func` and `promise` never match a value;
/// `component` matches any object (or array — JavaScript's `typeof` again). Unknown
/// object keys are allowed, as on the web side.
pub fn validate(value: &Value, shape: &Shape) -> Vec<Issue> {
    let mut issues = Vec::new();
    check(Some(value), shape, "", &mut issues);
    issues
}

fn issue(out: &mut Vec<Issue>, path: &str, expected: impl Into<String>, value: Option<&Value>) {
    out.push(Issue {
        path: path.to_string(),
        expected: expected.into(),
        got: type_name(value).to_string(),
    });
}

fn child(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

/// JavaScript `===` over JSON values: numbers compare by value (`1` is `1.0`).
fn strictly_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        _ => false,
    }
}

fn check(value: Option<&Value>, shape: &Shape, path: &str, out: &mut Vec<Issue>) {
    match shape {
        Shape::Primitive(name) => {
            let ok = match name.as_str() {
                "string" => matches!(value, Some(Value::String(_))),
                "number" => matches!(value, Some(Value::Number(_))),
                "boolean" => matches!(value, Some(Value::Bool(_))),
                "func" | "promise" => false,
                "component" => matches!(value, Some(Value::Object(_) | Value::Array(_))),
                _ => true,
            };
            if !ok {
                issue(out, path, shape.name(), value);
            }
        }
        Shape::Unknown(_) => {}
        Shape::Literal { literal } => {
            let ok = value.is_some_and(|value| literal.iter().any(|v| strictly_equal(v, value)));
            if !ok {
                out.push(Issue {
                    path: path.to_string(),
                    expected: shape.name(),
                    got: value.map_or_else(|| "undefined".to_string(), Value::to_string),
                });
            }
        }
        Shape::Union { union } => {
            let ok = union.iter().any(|member| {
                let mut scratch = Vec::new();
                check(value, member, path, &mut scratch);
                scratch.is_empty()
            });
            if !ok {
                issue(out, path, shape.name(), value);
            }
        }
        Shape::Array { array } => match value {
            Some(Value::Array(items)) => {
                for (index, item) in items.iter().enumerate() {
                    check(Some(item), array, &format!("{path}[{index}]"), out);
                }
            }
            _ => issue(out, path, "array", value),
        },
        Shape::Optional { optional } => {
            if value.is_some() {
                check(value, optional, path, out);
            }
        }
        Shape::Record { record } => match value {
            Some(Value::Object(entries)) => {
                for (key, entry) in entries {
                    check(Some(entry), record, &child(path, key), out);
                }
            }
            _ => issue(out, path, "object", value),
        },
        Shape::Object { object } => match value {
            Some(Value::Object(entries)) => {
                for (key, field) in object {
                    check(entries.get(key), field, &child(path, key), out);
                }
            }
            _ => issue(out, path, "object", value),
        },
    }
}

/// Every reason offering `provided` where `needed` is required fails. Empty means it
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
    let mismatch = |out: &mut Vec<String>| {
        out.push(format!(
            "{at} is {}, needs {}",
            provided.name(),
            needed.name()
        ));
    };
    match needed {
        Shape::Unknown(_) => {}
        Shape::Primitive(_) if needed.name() == "any" => {}
        Shape::Object { object: needs } => {
            let Shape::Object { object: offers } = provided else {
                out.push(format!("{at} is {}, needs an object", provided.name()));
                return;
            };
            for (key, need) in needs {
                let key_path = child(path, key);
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
                mismatch(out);
            }
        }
        Shape::Array { array: item } => match provided {
            Shape::Array { array } => fits_at(array, item, &format!("{path}[]"), out),
            _ => mismatch(out),
        },
        Shape::Record { record: item } => match provided {
            Shape::Record { record } => fits_at(record, item, &format!("{path}{{}}"), out),
            _ => mismatch(out),
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
                mismatch(out);
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
                out.push(format!(
                    "{at} is {}, needs {}",
                    provided.name(),
                    needed.name()
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(json: &str) -> Shape {
        serde_json::from_str(json).expect("a shape")
    }

    #[test]
    fn issues_carry_a_path_and_what_was_expected() {
        let issues = validate(
            &serde_json::json!({ "title": 5, "tags": ["a", 1] }),
            &shape(r#"{"object":{"title":"string","tags":{"array":"string"},"due":"string"}}"#),
        );
        assert_eq!(
            issues,
            vec![
                Issue {
                    path: "due".into(),
                    expected: "string".into(),
                    got: "undefined".into()
                },
                Issue {
                    path: "tags[1]".into(),
                    expected: "string".into(),
                    got: "number".into()
                },
                Issue {
                    path: "title".into(),
                    expected: "string".into(),
                    got: "number".into()
                },
            ]
        );
        assert_eq!(issues[0].to_string(), "due: expected string, got undefined");
    }

    #[test]
    fn unknown_shapes_accept_anything() {
        assert!(validate(&serde_json::json!(1), &shape(r#""whatever""#)).is_empty());
        assert!(validate(&serde_json::json!(1), &shape(r#"{"tuple":["string"]}"#)).is_empty());
    }

    /// Structural fitting, row by row.
    #[test]
    fn the_type_check_table() {
        let fits_ = |offer: &str, need: &str| fits(&shape(offer), &shape(need));
        assert!(
            fits_(
                r#"{"object":{"id":"string","title":"string","icon":"any"}}"#,
                r#"{"object":{"id":"string","title":"string"}}"#
            )
            .is_empty()
        );
        assert_eq!(
            fits_(
                r#"{"object":{"id":"string","query":"func"}}"#,
                r#"{"object":{"id":"string","search":"func"}}"#
            ),
            vec!["missing required `search`".to_string()]
        );
        assert_eq!(
            fits_(
                r#"{"object":{"id":"number"}}"#,
                r#"{"object":{"id":"string"}}"#
            ),
            vec!["`id` is number, needs string".to_string()]
        );
        assert!(
            fits_(
                r#"{"object":{}}"#,
                r#"{"object":{"title":{"optional":"string"}}}"#
            )
            .is_empty()
        );
        assert_eq!(
            fits_(
                r#"{"object":{"label":{"optional":"string"}}}"#,
                r#"{"object":{"label":"string"}}"#
            ),
            vec!["`label` may be absent, but is required".to_string()]
        );
        assert!(
            fits_(
                r#"{"literal":["light"]}"#,
                r#"{"literal":["light","dark"]}"#
            )
            .is_empty()
        );
        assert!(!fits_(r#""string""#, r#"{"literal":["light","dark"]}"#).is_empty());
        assert!(fits_(r#"{"literal":["light"]}"#, r#""string""#).is_empty());
        assert_eq!(
            fits_(r#"{"record":"number"}"#, r#"{"record":"string"}"#),
            vec!["`{}` is number, needs string".to_string()]
        );
        assert!(fits_(r#""func""#, r#""func""#).is_empty());
        assert!(fits_(r#"{"object":{}}"#, r#""any""#).is_empty());
    }
}

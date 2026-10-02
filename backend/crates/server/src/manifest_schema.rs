use std::sync::OnceLock;

use serde::Serialize;
use serde_json::Value;

pub const MANIFEST_SCHEMA_JSON: &str = include_str!("../../../../schema/manifest.schema.json");

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ManifestProblem {
    pub field: String,
    pub message: String,
}

fn schema() -> &'static Value {
    static SCHEMA: OnceLock<Value> = OnceLock::new();
    SCHEMA.get_or_init(|| {
        serde_json::from_str(MANIFEST_SCHEMA_JSON)
            .expect("schema/manifest.schema.json is valid JSON")
    })
}

pub fn validate_manifest(value: &Value) -> Vec<ManifestProblem> {
    let mut problems = Vec::new();
    check(schema(), value, "", &mut problems);
    problems
}

pub fn describe(problems: &[ManifestProblem]) -> String {
    problems
        .iter()
        .map(|problem| {
            if problem.field.is_empty() {
                problem.message.clone()
            } else {
                format!("{} {}", problem.field, problem.message)
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

fn push(problems: &mut Vec<ManifestProblem>, field: &str, message: impl Into<String>) {
    problems.push(ManifestProblem {
        field: field.to_string(),
        message: message.into(),
    });
}

fn resolve(node: &Value) -> &Value {
    match node.get("$ref").and_then(Value::as_str) {
        Some(reference) => {
            let name = reference.trim_start_matches("#/$defs/");
            schema()
                .get("$defs")
                .and_then(|defs| defs.get(name))
                .unwrap_or(&Value::Null)
        }
        None => node,
    }
}

fn check(node: &Value, value: &Value, path: &str, problems: &mut Vec<ManifestProblem>) {
    let node = resolve(node);
    match node.get("type").and_then(Value::as_str) {
        Some("object") => {
            let Some(object) = value.as_object() else {
                push(problems, path, "must be an object");
                return;
            };
            if let Some(required) = node.get("required").and_then(Value::as_array) {
                for key in required.iter().filter_map(Value::as_str) {
                    if !object.contains_key(key) {
                        push(problems, &join(path, key), "is required");
                    }
                }
            }
            let properties = node.get("properties").and_then(Value::as_object);
            let removed = node.get("x-removed").and_then(Value::as_object);
            for (key, entry) in object {
                let at = join(path, key);
                if let Some(message) = removed
                    .and_then(|removed| removed.get(key))
                    .and_then(Value::as_str)
                {
                    push(problems, &at, message);
                    continue;
                }
                if let Some(property) = properties.and_then(|props| props.get(key)) {
                    check(property, entry, &at, problems);
                    continue;
                }
                if let Some(format) = node
                    .get("propertyNames")
                    .and_then(|names| names.get("format"))
                    .and_then(Value::as_str)
                    && let Some(message) = format_problem(format, key)
                {
                    push(problems, &at, message);
                    continue;
                }
                match node.get("additionalProperties") {
                    Some(Value::Bool(false)) => push(problems, &at, "is not a known field"),
                    Some(extra @ Value::Object(_)) => check(extra, entry, &at, problems),
                    _ => {}
                }
            }
        }
        Some("array") => {
            let Some(items) = value.as_array() else {
                push(problems, path, "must be an array");
                return;
            };
            if let Some(item) = node.get("items") {
                for (index, entry) in items.iter().enumerate() {
                    check(item, entry, &format!("{path}[{index}]"), problems);
                }
            }
        }
        Some("string") => {
            let Some(text) = value.as_str() else {
                push(problems, path, "must be a string");
                return;
            };
            if !enum_allows(node, value) {
                push(problems, path, enum_message(node));
                return;
            }
            if let Some(format) = node.get("format").and_then(Value::as_str)
                && let Some(message) = format_problem(format, text)
            {
                push(problems, path, message);
            }
        }
        Some("boolean") => {
            if !value.is_boolean() {
                push(problems, path, "must be a boolean");
            }
        }
        Some("number") => {
            if !value.as_f64().is_some_and(f64::is_finite) {
                push(problems, path, "must be a number");
            }
        }
        Some("integer") => {
            let integer = value
                .as_f64()
                .filter(|number| number.is_finite() && number.fract() == 0.0);
            match integer {
                None => push(problems, path, "must be an integer"),
                Some(number) => {
                    if let Some(minimum) = node.get("minimum").and_then(Value::as_f64)
                        && number < minimum
                    {
                        push(problems, path, format!("must be at least {minimum}"));
                    }
                }
            }
        }
        _ => {}
    }
}

fn enum_allows(node: &Value, value: &Value) -> bool {
    node.get("enum")
        .and_then(Value::as_array)
        .is_none_or(|allowed| allowed.contains(value))
}

fn enum_message(node: &Value) -> String {
    let allowed: Vec<String> = node
        .get("enum")
        .and_then(Value::as_array)
        .map(|allowed| allowed.iter().map(Value::to_string).collect())
        .unwrap_or_default();
    format!("must be one of {}", allowed.join(", "))
}

pub fn format_problem(format: &str, text: &str) -> Option<&'static str> {
    let ok = match format {
        "plugin-id" => crate::plugins::is_valid_plugin_id(text),
        "semver" => crate::plugins::is_valid_version(text),
        "semver-range" => is_semver_range(text),
        "relative-path" => crate::plugins::safe_relative_path(text),
        "plugin-ref" => parse_plugin_ref(text).is_some(),
        _ => true,
    };
    if ok {
        return None;
    }
    Some(match format {
        "plugin-id" => "must match ^[a-z0-9][a-z0-9-]{0,63}$",
        "semver" => "must be a semver version",
        "semver-range" => "must be a semver range, e.g. ^1.0",
        "relative-path" => "must be a relative path inside the package, without `..`",
        "plugin-ref" => "must be <plugin-id>@<version>, e.g. editor@2.0.0",
        _ => "is malformed",
    })
}

pub fn parse_plugin_ref(text: &str) -> Option<(&str, &str)> {
    let (id, version) = text.split_once('@')?;
    (crate::plugins::is_valid_plugin_id(id) && crate::plugins::is_valid_version(version))
        .then_some((id, version))
}

pub fn is_semver_range(range: &str) -> bool {
    if range == "*" {
        return true;
    }
    let rest = ["^", "~", ">=", "<=", "=", ">", "<"]
        .iter()
        .find_map(|op| range.strip_prefix(op))
        .unwrap_or(range);
    let core_end = rest.find(['-', '+']).unwrap_or(rest.len());
    let (core, tail) = rest.split_at(core_end);
    let parts: Vec<&str> = core.split('.').collect();
    let core_ok = (1..=3).contains(&parts.len())
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    let tail_ok = tail.is_empty()
        || (tail.len() > 1
            && tail[1..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+'));
    core_ok && tail_ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Fixture {
        name: String,
        manifest: Value,
        problems: Vec<String>,
    }

    #[test]
    fn the_shared_fixture_corpus_passes() {
        let fixtures: Vec<Fixture> =
            serde_json::from_str(include_str!("../../../../schema/fixtures/manifests.json"))
                .expect("fixtures parse");
        assert!(fixtures.len() > 10, "the corpus is not empty");
        for fixture in fixtures {
            let mut got: Vec<String> = validate_manifest(&fixture.manifest)
                .into_iter()
                .map(|problem| problem.field)
                .collect();
            got.sort();
            let mut want = fixture.problems.clone();
            want.sort();
            assert_eq!(got, want, "fixture `{}`", fixture.name);
            if want.is_empty() {
                serde_json::from_value::<crate::plugins::PluginManifest>(fixture.manifest)
                    .unwrap_or_else(|err| panic!("fixture `{}` deserializes: {err}", fixture.name));
            }
        }
    }

    #[test]
    fn every_base_manifest_is_valid() {
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../plugins/base");
        let mut seen = 0;
        for entry in std::fs::read_dir(&base)
            .expect("plugins/base exists")
            .flatten()
        {
            let path = entry.path().join("manifest.json");
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let value: Value = serde_json::from_str(&raw).expect("manifest parses");
            let problems = validate_manifest(&value);
            assert!(
                problems.is_empty(),
                "{}: {}",
                path.display(),
                describe(&problems)
            );
            seen += 1;
        }
        assert!(seen > 20);
    }

    #[test]
    fn ranges() {
        for ok in ["*", "^1.0", "~1.2.3", "1.2.3", ">=1.0.0", "^0.2.1-beta.1"] {
            assert!(is_semver_range(ok), "{ok}");
        }
        for bad in ["", "^", "1.2.3.4", "latest", " ^1.0", "^1.x"] {
            assert!(!is_semver_range(bad), "{bad}");
        }
    }
}

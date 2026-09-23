//! Conformance-corpus support: corpus loading, and a miniature Mongo-query
//! interpreter used to prove `filter::mongo::compile` and
//! `filter::evaluator::evaluate` agree on every corpus row (SPEC §4.2).
//!
//! The interpreter deliberately reproduces the Mongo behaviour the compiler has
//! to defend against — implicit array traversal on comparison operators,
//! `$eq: null` matching absent fields, type bracketing — so a missing guard in
//! the compiler shows up as a parity failure rather than passing silently.

#![allow(dead_code)]

use std::cmp::Ordering;
use std::path::PathBuf;

use bson::{Bson, Document as BsonDocument};

/// Load one corpus file as JSON.
pub fn corpus(name: &str) -> serde_json::Value {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.push("corpus");
    path.push(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read corpus {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("corpus {} is not valid JSON: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// Mongo query interpreter
// ---------------------------------------------------------------------------

/// `true` when `doc` matches `query` under Mongo's find semantics.
pub fn mongo_matches(doc: &BsonDocument, query: &BsonDocument) -> bool {
    query.iter().all(|(key, value)| match key.as_str() {
        "$and" => clauses(value).iter().all(|c| mongo_matches(doc, c)),
        "$or" => clauses(value).iter().any(|c| mongo_matches(doc, c)),
        "$nor" => !clauses(value).iter().any(|c| mongo_matches(doc, c)),
        _ => field_matches(doc, key, value),
    })
}

fn clauses(value: &Bson) -> Vec<BsonDocument> {
    match value {
        Bson::Array(items) => items
            .iter()
            .map(|item| match item {
                Bson::Document(doc) => doc.clone(),
                other => panic!("logical operator takes documents, got {other:?}"),
            })
            .collect(),
        other => panic!("logical operator takes an array, got {other:?}"),
    }
}

fn field_matches(doc: &BsonDocument, path: &str, expected: &Bson) -> bool {
    let found = resolve(doc, path);
    match expected {
        Bson::Document(inner) if is_operator_doc(inner) => operators(found.as_ref(), inner),
        Bson::RegularExpression(regex) => traverse(found.as_ref(), &|value| match value {
            Bson::String(text) => regex_match(&regex.pattern, text, regex.options.contains('i')),
            _ => false,
        }),
        literal => eq_with_traversal(found.as_ref(), literal),
    }
}

fn is_operator_doc(doc: &BsonDocument) -> bool {
    !doc.is_empty() && doc.keys().all(|key| key.starts_with('$'))
}

/// Evaluate an operator expression document against one (possibly absent) value.
fn operators(found: Option<&Bson>, ops: &BsonDocument) -> bool {
    let mut regex: Option<(String, String)> = None;
    let mut result = true;
    for (op, arg) in ops {
        let ok = match op.as_str() {
            "$exists" => arg.as_bool().expect("$exists takes a bool") == found.is_some(),
            "$type" => match found {
                None => false,
                Some(value) => type_matches(value, arg.as_str().expect("$type takes a string")),
            },
            "$eq" => eq_with_traversal(found, arg),
            "$ne" => !eq_with_traversal(found, arg),
            "$in" => match arg {
                Bson::Array(items) => items.iter().any(|item| eq_with_traversal(found, item)),
                other => panic!("$in takes an array, got {other:?}"),
            },
            "$lt" | "$lte" | "$gt" | "$gte" => {
                traverse(found, &|value| match compare_bson(value, arg) {
                    None => false,
                    Some(ordering) => match op.as_str() {
                        "$lt" => ordering == Ordering::Less,
                        "$lte" => ordering != Ordering::Greater,
                        "$gt" => ordering == Ordering::Greater,
                        _ => ordering != Ordering::Less,
                    },
                })
            }
            "$not" => match arg {
                Bson::Document(inner) => !operators(found, inner),
                other => panic!("$not takes a document, got {other:?}"),
            },
            "$elemMatch" => match (found, arg) {
                (Some(Bson::Array(items)), Bson::Document(inner)) => {
                    items.iter().any(|item| operators(Some(item), inner))
                }
                _ => false,
            },
            "$regex" => {
                regex = Some((
                    arg.as_str().expect("$regex takes a string").to_string(),
                    String::new(),
                ));
                true
            }
            "$options" => {
                if let Some(entry) = regex.as_mut() {
                    entry.1 = arg.as_str().unwrap_or_default().to_string();
                }
                true
            }
            other => panic!("unsupported operator {other} in the test interpreter"),
        };
        result = result && ok;
    }
    if let Some((pattern, options)) = regex {
        let ok = traverse(found, &|value| match value {
            Bson::String(text) => regex_match(&pattern, text, options.contains('i')),
            _ => false,
        });
        result = result && ok;
    }
    result
}

/// Mongo's implicit array traversal: a predicate matches if the value matches or
/// any element of an array value matches.
fn traverse(found: Option<&Bson>, predicate: &dyn Fn(&Bson) -> bool) -> bool {
    match found {
        None => false,
        Some(value) => {
            if predicate(value) {
                return true;
            }
            match value {
                Bson::Array(items) => items.iter().any(predicate),
                _ => false,
            }
        }
    }
}

/// `$eq` semantics, including the special case that `$eq: null` also matches an
/// absent field.
fn eq_with_traversal(found: Option<&Bson>, expected: &Bson) -> bool {
    if matches!(expected, Bson::Null) && found.is_none() {
        return true;
    }
    traverse(found, &|value| {
        compare_bson(value, expected) == Some(Ordering::Equal)
    })
}

fn type_matches(value: &Bson, wanted: &str) -> bool {
    // `$type: "array"` is the one type that is never matched element-wise.
    if wanted == "array" {
        return matches!(value, Bson::Array(_));
    }
    if direct_type(value, wanted) {
        return true;
    }
    match value {
        Bson::Array(items) => items.iter().any(|item| direct_type(item, wanted)),
        _ => false,
    }
}

fn direct_type(value: &Bson, wanted: &str) -> bool {
    match wanted {
        "null" => matches!(value, Bson::Null),
        "bool" => matches!(value, Bson::Boolean(_)),
        "string" => matches!(value, Bson::String(_)),
        "int" => matches!(value, Bson::Int32(_)),
        "long" => matches!(value, Bson::Int64(_)),
        "double" => matches!(value, Bson::Double(_)),
        "date" => matches!(value, Bson::DateTime(_)),
        "object" => matches!(value, Bson::Document(_)),
        other => panic!("unsupported $type {other} in the test interpreter"),
    }
}

/// Mongo comparison with type bracketing: `None` when the two values are in
/// different brackets, so ordering operators do not match across types.
fn compare_bson(a: &Bson, b: &Bson) -> Option<Ordering> {
    fn number(value: &Bson) -> Option<f64> {
        match value {
            Bson::Int32(i) => Some(f64::from(*i)),
            Bson::Int64(i) => Some(*i as f64),
            Bson::Double(f) => Some(*f),
            _ => None,
        }
    }
    if let (Some(x), Some(y)) = (number(a), number(b)) {
        return Some(x.total_cmp(&y));
    }
    match (a, b) {
        (Bson::Null, Bson::Null) => Some(Ordering::Equal),
        (Bson::Boolean(x), Bson::Boolean(y)) => Some(x.cmp(y)),
        (Bson::String(x), Bson::String(y)) => Some(x.cmp(y)),
        (Bson::DateTime(x), Bson::DateTime(y)) => {
            Some(x.timestamp_millis().cmp(&y.timestamp_millis()))
        }
        (Bson::Array(x), Bson::Array(y)) => {
            for (left, right) in x.iter().zip(y.iter()) {
                match compare_bson(left, right) {
                    Some(Ordering::Equal) => {}
                    other => return other,
                }
            }
            Some(x.len().cmp(&y.len()))
        }
        (Bson::Document(x), Bson::Document(y)) => Some(format!("{x:?}").cmp(&format!("{y:?}"))),
        _ => None,
    }
}

/// Resolve a dotted path. Intermediate segments traverse documents only, which
/// is all the compiler's field paths need.
fn resolve(doc: &BsonDocument, path: &str) -> Option<Bson> {
    let mut current = Bson::Document(doc.clone());
    for segment in path.split('.') {
        current = match current {
            Bson::Document(inner) => inner.get(segment)?.clone(),
            _ => return None,
        };
    }
    Some(current)
}

// ---------------------------------------------------------------------------
// Miniature regex engine
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Node {
    Literal(char),
    Class(Vec<(char, char)>),
    Group(Vec<Node>, bool),
}

/// Match the subset of regex syntax the compiler emits: literals with `\`
/// escapes, `[a-z0-9]` classes, `{n}` exact repetition, one optional group
/// level, and the `^`/`$` anchors.
pub fn regex_match(pattern: &str, haystack: &str, case_insensitive: bool) -> bool {
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0usize;
    let anchor_start = chars.first() == Some(&'^');
    if anchor_start {
        index = 1;
    }
    let (nodes, anchor_end) = parse_nodes(&chars, &mut index, false);
    assert_eq!(index, chars.len(), "unparsed regex tail in {pattern:?}");
    let hay: Vec<char> = if case_insensitive {
        haystack.to_lowercase().chars().collect()
    } else {
        haystack.chars().collect()
    };
    let nodes = if case_insensitive {
        lowercase_nodes(&nodes)
    } else {
        nodes
    };
    let starts: Vec<usize> = if anchor_start {
        vec![0]
    } else {
        (0..=hay.len()).collect()
    };
    starts
        .into_iter()
        .any(|start| match_nodes(&nodes, &hay, start, anchor_end))
}

fn lowercase_nodes(nodes: &[Node]) -> Vec<Node> {
    nodes
        .iter()
        .map(|node| match node {
            Node::Literal(c) => Node::Literal(c.to_ascii_lowercase()),
            Node::Class(ranges) => Node::Class(ranges.clone()),
            Node::Group(inner, optional) => Node::Group(lowercase_nodes(inner), *optional),
        })
        .collect()
}

fn parse_nodes(chars: &[char], index: &mut usize, nested: bool) -> (Vec<Node>, bool) {
    let mut nodes: Vec<Node> = Vec::new();
    let mut anchor_end = false;
    while *index < chars.len() {
        let atom = match chars[*index] {
            ')' if nested => break,
            '$' if !nested && *index + 1 == chars.len() => {
                anchor_end = true;
                *index += 1;
                continue;
            }
            '(' => {
                *index += 1;
                let (inner, _) = parse_nodes(chars, index, true);
                assert_eq!(chars.get(*index), Some(&')'), "unbalanced group");
                *index += 1;
                let optional = chars.get(*index) == Some(&'?');
                if optional {
                    *index += 1;
                }
                Node::Group(inner, optional)
            }
            '[' => {
                *index += 1;
                let mut ranges = Vec::new();
                while *index < chars.len() && chars[*index] != ']' {
                    let from = chars[*index];
                    if chars.get(*index + 1) == Some(&'-') && chars.get(*index + 2).is_some() {
                        ranges.push((from, chars[*index + 2]));
                        *index += 3;
                    } else {
                        ranges.push((from, from));
                        *index += 1;
                    }
                }
                assert_eq!(chars.get(*index), Some(&']'), "unbalanced class");
                *index += 1;
                Node::Class(ranges)
            }
            '\\' => {
                *index += 1;
                let literal = *chars.get(*index).expect("trailing escape");
                *index += 1;
                Node::Literal(literal)
            }
            other => {
                *index += 1;
                Node::Literal(other)
            }
        };
        // `{n}` expands the atom in place; everything else appears once.
        let count = take_repetition(chars, index).unwrap_or(1);
        for _ in 0..count {
            nodes.push(atom.clone());
        }
    }
    (nodes, anchor_end)
}

fn take_repetition(chars: &[char], index: &mut usize) -> Option<usize> {
    if chars.get(*index) != Some(&'{') {
        return None;
    }
    let mut cursor = *index + 1;
    let mut digits = String::new();
    while cursor < chars.len() && chars[cursor].is_ascii_digit() {
        digits.push(chars[cursor]);
        cursor += 1;
    }
    if digits.is_empty() || chars.get(cursor) != Some(&'}') {
        return None;
    }
    *index = cursor + 1;
    digits.parse::<usize>().ok()
}

fn match_nodes(nodes: &[Node], hay: &[char], pos: usize, anchor_end: bool) -> bool {
    let Some((first, rest)) = nodes.split_first() else {
        return !anchor_end || pos == hay.len();
    };
    match first {
        Node::Literal(expected) => {
            hay.get(pos) == Some(expected) && match_nodes(rest, hay, pos + 1, anchor_end)
        }
        Node::Class(ranges) => match hay.get(pos) {
            Some(c) if ranges.iter().any(|(from, to)| c >= from && c <= to) => {
                match_nodes(rest, hay, pos + 1, anchor_end)
            }
            _ => false,
        },
        Node::Group(inner, optional) => {
            let mut combined = inner.clone();
            combined.extend_from_slice(rest);
            if match_nodes(&combined, hay, pos, anchor_end) {
                return true;
            }
            *optional && match_nodes(rest, hay, pos, anchor_end)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mini_regex_handles_the_emitted_patterns() {
        let shape = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)?$";
        assert!(regex_match(shape, "2026-09-23", false));
        assert!(regex_match(shape, "2026-09-23T10:00:00.000Z", false));
        assert!(!regex_match(shape, "2026-09-23T10:00:00Z", false));
        assert!(!regex_match(shape, "2026-09-2", false));
        assert!(!regex_match(shape, "x2026-09-23", false));
        assert!(regex_match(r"a\.b", "xa.by", false));
        assert!(!regex_match(r"a\.b", "xacby", false));
        assert!(regex_match(r"^ab", "ABc", true));
        assert!(regex_match(r"bc$", "ABC", true));
    }
}

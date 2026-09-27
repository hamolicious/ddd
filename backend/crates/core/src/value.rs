//! The value model shared by frontmatter, machine sections and the filter DSL.
//!
//! Strict YAML subset (SPEC §3.4): block mappings, flow sequences, top-level
//! frontmatter block sequences, and scalars typed string / int / float / bool /
//! null. Dates stay [`Value::Str`] at parse time and are normalized to canonical
//! form at materialization ([`crate::date`]).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::limits::{MAX_ARRAY_ITEMS, MAX_NESTING_DEPTH, MAX_STRING_VALUE_BYTES, is_valid_key};

/// Ordered string-keyed map. BTreeMap so serialization is deterministic on both
/// sides (materialized `fm` / `plugins` must be byte-comparable).
pub type Map = BTreeMap<String, Value>;

/// A parsed frontmatter / machine-section value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    List(Vec<Value>),
    Map(Map),
}

/// The type tag used for the DSL's "same-type comparisons only" rule (SPEC §4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueType {
    Null,
    Bool,
    Int,
    Float,
    Str,
    Date,
    List,
    Map,
}

impl Value {
    /// Type tag of this value. `Date` is never returned here — dates are typed
    /// only in the DSL, where the comparison literal carries the date type.
    pub fn value_type(&self) -> ValueType {
        match self {
            Value::Null => ValueType::Null,
            Value::Bool(_) => ValueType::Bool,
            Value::Int(_) => ValueType::Int,
            Value::Float(_) => ValueType::Float,
            Value::Str(_) => ValueType::Str,
            Value::List(_) => ValueType::List,
            Value::Map(_) => ValueType::Map,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_int(&self) -> Option<i64> {
        match self {
            Value::Int(i) => Some(*i),
            _ => None,
        }
    }

    pub fn as_float(&self) -> Option<f64> {
        match self {
            Value::Float(f) => Some(*f),
            Value::Int(i) => Some(*i as f64),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&[Value]> {
        match self {
            Value::List(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_map(&self) -> Option<&Map> {
        match self {
            Value::Map(map) => Some(map),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// Parse one scalar from its YAML text form, per the strict subset:
    /// `null`/`~`/empty → Null, `true`/`false` → Bool, integer → Int,
    /// float → Float, quoted or otherwise → Str (quotes stripped, escapes
    /// handled for double quotes only).
    ///
    /// Total and infallible: anything unrecognized becomes a string. Flow
    /// collections are *not* handled here — the block parsers use the internal
    /// strict value parser for those, and an unterminated quote is a dropped
    /// line there rather than a literal string (see `crate::yaml`).
    pub fn parse_scalar(raw: &str) -> Value {
        let s = strip_comment(raw.trim()).trim();
        if s.is_empty() {
            return Value::Null;
        }
        if let Some(inner) = double_quoted(s) {
            return Value::Str(unescape_double(inner));
        }
        if let Some(inner) = single_quoted(s) {
            return Value::Str(inner.replace("''", "'"));
        }
        match s {
            "null" | "Null" | "NULL" | "~" => return Value::Null,
            "true" | "True" | "TRUE" => return Value::Bool(true),
            "false" | "False" | "FALSE" => return Value::Bool(false),
            _ => {}
        }
        if int_shape(s) {
            return match s.parse::<i64>() {
                Ok(i) => Value::Int(i),
                // Out of i64 range: keep it numeric rather than silently
                // turning a number into a string.
                Err(_) => match s.parse::<f64>() {
                    Ok(f) if f.is_finite() => Value::Float(f),
                    _ => Value::Str(s.to_string()),
                },
            };
        }
        if float_shape(s)
            && let Ok(f) = s.parse::<f64>()
            && f.is_finite()
        {
            return Value::Float(f);
        }
        Value::Str(s.to_string())
    }

    /// Serialize back to the canonical single-line YAML form used by section
    /// line splices (SPEC §3.3). Never emits block scalars.
    pub fn to_yaml_inline(&self) -> String {
        match self {
            Value::Null => "null".to_string(),
            Value::Bool(true) => "true".to_string(),
            Value::Bool(false) => "false".to_string(),
            Value::Int(i) => i.to_string(),
            Value::Float(f) => {
                if f.is_finite() {
                    format_float(*f)
                } else {
                    "null".to_string()
                }
            }
            Value::Str(s) => {
                if needs_quoting(s) {
                    quote_double(s)
                } else {
                    s.clone()
                }
            }
            Value::List(items) => {
                let body: Vec<String> = items.iter().map(Value::to_yaml_inline).collect();
                format!("[{}]", body.join(", "))
            }
            Value::Map(map) => {
                let body: Vec<String> = map
                    .iter()
                    .map(|(k, v)| format!("{}: {}", k, v.to_yaml_inline()))
                    .collect();
                format!("{{{}}}", body.join(", "))
            }
        }
    }

    /// Convert to `serde_json::Value` (REST representation, wasm boundary).
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Value::Null => serde_json::Value::Null,
            Value::Bool(b) => serde_json::Value::Bool(*b),
            Value::Int(i) => serde_json::Value::Number((*i).into()),
            Value::Float(f) => serde_json::Number::from_f64(*f)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null),
            Value::Str(s) => serde_json::Value::String(s.clone()),
            Value::List(items) => {
                serde_json::Value::Array(items.iter().map(Value::to_json).collect())
            }
            Value::Map(map) => serde_json::Value::Object(
                map.iter().map(|(k, v)| (k.clone(), v.to_json())).collect(),
            ),
        }
    }

    /// Convert from `serde_json::Value`. Objects become [`Value::Map`],
    /// arrays [`Value::List`]; numbers become Int when integral.
    pub fn from_json(value: &serde_json::Value) -> Value {
        match value {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Bool(b) => Value::Bool(*b),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Value::Int(i)
                } else if let Some(f) = n.as_f64() {
                    Value::Float(f)
                } else {
                    Value::Null
                }
            }
            serde_json::Value::String(s) => Value::Str(s.clone()),
            serde_json::Value::Array(items) => {
                Value::List(items.iter().map(Value::from_json).collect())
            }
            serde_json::Value::Object(map) => Value::Map(
                map.iter()
                    .map(|(k, v)| (k.clone(), Value::from_json(v)))
                    .collect(),
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// Strict value parsing (internal): scalars plus flow collections, with caps.
// ---------------------------------------------------------------------------

/// Why a value was rejected. Mapped to a [`crate::diagnostics::Diagnostic`] by
/// the line parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ValueReject {
    /// Nesting deeper than [`MAX_NESTING_DEPTH`].
    Depth,
    /// Flow collection with more than [`MAX_ARRAY_ITEMS`] entries.
    ArrayItems,
    /// String scalar longer than [`MAX_STRING_VALUE_BYTES`].
    StringBytes,
    /// A YAML feature outside the supported subset.
    Unsupported(&'static str),
    /// Not a parseable value in the strict subset (unbalanced quote/bracket…).
    Malformed(&'static str),
}

/// Parse one value in the strict subset: a scalar, a flow sequence `[…]`, or a
/// flow mapping `{…}`. `depth` starts at 1 for a top-level value.
///
/// Stricter than [`Value::parse_scalar`]: an unterminated quote or bracket is a
/// rejection (the line is dropped and recorded) rather than a literal string.
pub(crate) fn parse_value(raw: &str, depth: usize) -> Result<Value, ValueReject> {
    if depth > MAX_NESTING_DEPTH {
        return Err(ValueReject::Depth);
    }
    let s = strip_comment(raw.trim()).trim();

    if let Some(rest) = s.strip_prefix('[') {
        let inner = rest
            .strip_suffix(']')
            .ok_or(ValueReject::Malformed("unterminated flow sequence"))?;
        let parts = split_flow(inner)?;
        if parts.len() > MAX_ARRAY_ITEMS {
            return Err(ValueReject::ArrayItems);
        }
        let mut out = Vec::with_capacity(parts.len());
        for part in parts {
            out.push(parse_value(part, depth + 1)?);
        }
        return Ok(Value::List(out));
    }

    if let Some(rest) = s.strip_prefix('{') {
        let inner = rest
            .strip_suffix('}')
            .ok_or(ValueReject::Malformed("unterminated flow mapping"))?;
        let parts = split_flow(inner)?;
        if parts.len() > MAX_ARRAY_ITEMS {
            return Err(ValueReject::ArrayItems);
        }
        let mut map = Map::new();
        for part in parts {
            let (key, value) = split_key(part).ok_or(ValueReject::Malformed(
                "flow mapping entry is not `key: value`",
            ))?;
            let key = unquote_key(key);
            if !is_valid_key(&key) {
                return Err(ValueReject::Malformed("invalid key in flow mapping"));
            }
            // Duplicate keys inside one flow mapping: last wins.
            map.insert(key, parse_value(value, depth + 1)?);
        }
        return Ok(Value::Map(map));
    }

    check_unsupported(s)?;

    // Quoted scalars must terminate; a mid-edit broken quote is a dropped line.
    if s.starts_with('"') && double_quoted(s).is_none() {
        return Err(ValueReject::Malformed("unterminated double-quoted string"));
    }
    if s.starts_with('\'') && single_quoted(s).is_none() {
        return Err(ValueReject::Malformed("unterminated single-quoted string"));
    }
    if s.ends_with(']') || s.ends_with('}') {
        return Err(ValueReject::Malformed("unbalanced flow collection"));
    }

    let value = Value::parse_scalar(s);
    if let Value::Str(ref text) = value
        && text.len() > MAX_STRING_VALUE_BYTES
    {
        return Err(ValueReject::StringBytes);
    }
    Ok(value)
}

fn check_unsupported(s: &str) -> Result<(), ValueReject> {
    let first = s.as_bytes().first().copied();
    match first {
        Some(b'&') => Err(ValueReject::Unsupported("anchors are not supported")),
        Some(b'*') => Err(ValueReject::Unsupported("aliases are not supported")),
        Some(b'!') => Err(ValueReject::Unsupported("tags are not supported")),
        Some(b'|') | Some(b'>') => Err(ValueReject::Unsupported("block scalars are not supported")),
        Some(b'?') => Err(ValueReject::Unsupported("explicit keys are not supported")),
        _ => {
            if s == "---" || s == "..." {
                Err(ValueReject::Unsupported(
                    "multi-document markers are not supported",
                ))
            } else {
                Ok(())
            }
        }
    }
}

/// Split a flow-collection interior on top-level commas, honouring nesting and
/// quoting. A single trailing comma is tolerated.
fn split_flow(inner: &str) -> Result<Vec<&str>, ValueReject> {
    let mut parts = Vec::new();
    if inner.trim().is_empty() {
        return Ok(parts);
    }
    let bytes = inner.as_bytes();
    let mut depth = 0i32;
    let mut quote: Option<u8> = None;
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        match quote {
            Some(q) => {
                if q == b'"' && c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                b'"' | b'\'' => quote = Some(c),
                b'[' | b'{' => depth += 1,
                b']' | b'}' => {
                    depth -= 1;
                    if depth < 0 {
                        return Err(ValueReject::Malformed("unbalanced flow collection"));
                    }
                }
                b',' if depth == 0 => {
                    parts.push(&inner[start..i]);
                    start = i + 1;
                }
                _ => {}
            },
        }
        i += 1;
    }
    if quote.is_some() {
        return Err(ValueReject::Malformed("unterminated quoted string"));
    }
    if depth != 0 {
        return Err(ValueReject::Malformed("unbalanced flow collection"));
    }
    let tail = &inner[start..];
    if !tail.trim().is_empty() || parts.is_empty() {
        parts.push(tail);
    }
    Ok(parts)
}

/// Split `key: value` at the first top-level `:` that is followed by a space or
/// ends the text. Returns `None` when there is no such colon.
pub(crate) fn split_key(text: &str) -> Option<(&str, &str)> {
    let bytes = text.as_bytes();
    let mut depth = 0i32;
    let mut quote: Option<u8> = None;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        match quote {
            Some(q) => {
                if q == b'"' && c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q {
                    quote = None;
                }
            }
            None => match c {
                b'"' | b'\'' => quote = Some(c),
                b'[' | b'{' => depth += 1,
                b']' | b'}' => depth -= 1,
                b':' if depth == 0 => {
                    let next = bytes.get(i + 1).copied();
                    if next.is_none() || next == Some(b' ') || next == Some(b'\t') {
                        return Some((&text[..i], &text[i + 1..]));
                    }
                }
                _ => {}
            },
        }
        i += 1;
    }
    None
}

/// Strip matching quotes off a key, if present.
pub(crate) fn unquote_key(key: &str) -> String {
    let k = key.trim();
    if let Some(inner) = double_quoted(k) {
        return unescape_double(inner);
    }
    if let Some(inner) = single_quoted(k) {
        return inner.replace("''", "'");
    }
    k.to_string()
}

/// Remove a trailing ` # comment` from an unquoted scalar. `#` only starts a
/// comment at the start of the value or after whitespace, and never inside
/// quotes.
pub(crate) fn strip_comment(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut quote: Option<u8> = None;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        match quote {
            Some(q) => {
                if q == b'"' && c == b'\\' {
                    i += 2;
                    continue;
                }
                if c == q {
                    quote = None;
                }
            }
            None => {
                if c == b'"' || c == b'\'' {
                    quote = Some(c);
                } else if c == b'#' && (i == 0 || bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
                    return s[..i].trim_end();
                }
            }
        }
        i += 1;
    }
    s
}

fn double_quoted(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'"' || bytes[bytes.len() - 1] != b'"' {
        return None;
    }
    // The closing quote must not itself be escaped, and no unescaped quote may
    // appear in between.
    let inner = &s[1..s.len() - 1];
    let ib = inner.as_bytes();
    let mut i = 0usize;
    while i < ib.len() {
        match ib[i] {
            b'\\' => i += 2,
            b'"' => return None,
            _ => i += 1,
        }
    }
    if i > ib.len() {
        // Trailing backslash escaped the closing quote.
        return None;
    }
    Some(inner)
}

fn single_quoted(s: &str) -> Option<&str> {
    let bytes = s.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'\'' || bytes[bytes.len() - 1] != b'\'' {
        return None;
    }
    let inner = &s[1..s.len() - 1];
    // Inner single quotes must be doubled.
    let ib = inner.as_bytes();
    let mut i = 0usize;
    while i < ib.len() {
        if ib[i] == b'\'' {
            if ib.get(i + 1) == Some(&b'\'') {
                i += 2;
            } else {
                return None;
            }
        } else {
            i += 1;
        }
    }
    Some(inner)
}

fn unescape_double(inner: &str) -> String {
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            None => out.push('\\'),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('0') => out.push('\0'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some('/') => out.push('/'),
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
                    Some(ch) => out.push(ch),
                    None => {
                        out.push_str("\\u");
                        out.push_str(&hex);
                    }
                }
            }
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
        }
    }
    out
}

fn quote_double(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn needs_quoting(s: &str) -> bool {
    if s.is_empty() || s != s.trim() {
        return true;
    }
    // Would round-trip to a different type?
    match Value::parse_scalar(s) {
        Value::Str(ref t) if t == s => {}
        _ => return true,
    }
    if s.bytes().any(|c| {
        matches!(
            c,
            b'\n' | b'\r' | b'\t' | b'#' | b',' | b'[' | b']' | b'{' | b'}' | b':' | b'"' | b'\''
        ) || c < 0x20
    }) {
        return true;
    }
    matches!(
        s.as_bytes()[0],
        b'-' | b'?' | b'&' | b'*' | b'!' | b'|' | b'>' | b'%' | b'@' | b'`'
    )
}

fn format_float(f: f64) -> String {
    // `{:?}` gives the shortest representation that round-trips, and always
    // keeps a decimal point or exponent so the value re-parses as a float.
    let text = format!("{f:?}");
    if text.contains('.') || text.contains('e') || text.contains('E') {
        text
    } else {
        format!("{text}.0")
    }
}

fn int_shape(s: &str) -> bool {
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit())
}

fn float_shape(s: &str) -> bool {
    let body = s.strip_prefix(['+', '-']).unwrap_or(s);
    if body.is_empty() {
        return false;
    }
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    if mantissa.is_empty() {
        return false;
    }
    let mut parts = mantissa.splitn(2, '.');
    let int_part = parts.next().unwrap_or("");
    let frac_part = parts.next();
    let digits_ok = |t: &str| t.bytes().all(|b| b.is_ascii_digit());
    if !digits_ok(int_part) {
        return false;
    }
    match frac_part {
        Some(frac) => {
            if !digits_ok(frac) {
                return false;
            }
            if int_part.is_empty() && frac.is_empty() {
                return false;
            }
        }
        None => {
            if int_part.is_empty() {
                return false;
            }
            // No dot and no exponent means it is an integer, not a float.
            if exponent.is_none() {
                return false;
            }
        }
    }
    match exponent {
        None => true,
        Some(exp) => {
            let exp = exp.strip_prefix(['+', '-']).unwrap_or(exp);
            !exp.is_empty() && digits_ok(exp)
        }
    }
}

/// Convert a materialized map to `bson` for storage / Mongo queries.
#[cfg(feature = "mongo")]
pub fn map_to_bson(map: &Map) -> bson::Document {
    let mut out = bson::Document::new();
    for (key, value) in map {
        out.insert(key.clone(), value_to_bson(value));
    }
    out
}

/// Convert a value to `bson`.
#[cfg(feature = "mongo")]
pub fn value_to_bson(value: &Value) -> bson::Bson {
    match value {
        Value::Null => bson::Bson::Null,
        Value::Bool(b) => bson::Bson::Boolean(*b),
        Value::Int(i) => bson::Bson::Int64(*i),
        Value::Float(f) => bson::Bson::Double(*f),
        Value::Str(s) => bson::Bson::String(s.clone()),
        Value::List(items) => bson::Bson::Array(items.iter().map(value_to_bson).collect()),
        Value::Map(map) => bson::Bson::Document(map_to_bson(map)),
    }
}

/// Convert a stored `bson` document back to a [`Map`] (used when evaluating the
/// DSL over rows read out of Mongo).
#[cfg(feature = "mongo")]
pub fn map_from_bson(doc: &bson::Document) -> Map {
    doc.iter()
        .map(|(key, value)| (key.clone(), value_from_bson(value)))
        .collect()
}

#[cfg(feature = "mongo")]
fn value_from_bson(value: &bson::Bson) -> Value {
    match value {
        bson::Bson::Null | bson::Bson::Undefined => Value::Null,
        bson::Bson::Boolean(b) => Value::Bool(*b),
        bson::Bson::Int32(i) => Value::Int(i64::from(*i)),
        bson::Bson::Int64(i) => Value::Int(*i),
        bson::Bson::Double(f) => Value::Float(*f),
        bson::Bson::String(s) => Value::Str(s.clone()),
        bson::Bson::Array(items) => Value::List(items.iter().map(value_from_bson).collect()),
        bson::Bson::Document(doc) => Value::Map(map_from_bson(doc)),
        bson::Bson::DateTime(dt) => Value::Str(
            crate::date::Date::from_epoch_millis(dt.timestamp_millis())
                .map(|d| d.canonical().to_string())
                .unwrap_or_default(),
        ),
        // Anything outside the shared value model degrades to a string so the
        // conversion stays total.
        other => Value::Str(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalars_type_as_documented() {
        assert_eq!(Value::parse_scalar(""), Value::Null);
        assert_eq!(Value::parse_scalar("~"), Value::Null);
        assert_eq!(Value::parse_scalar("null"), Value::Null);
        assert_eq!(Value::parse_scalar("true"), Value::Bool(true));
        assert_eq!(Value::parse_scalar("FALSE"), Value::Bool(false));
        assert_eq!(Value::parse_scalar("12"), Value::Int(12));
        assert_eq!(Value::parse_scalar("-12"), Value::Int(-12));
        assert_eq!(Value::parse_scalar("1.5"), Value::Float(1.5));
        assert_eq!(Value::parse_scalar("1e3"), Value::Float(1000.0));
        assert_eq!(Value::parse_scalar("v1.2.3"), Value::Str("v1.2.3".into()));
        assert_eq!(Value::parse_scalar("\"12\""), Value::Str("12".into()));
        assert_eq!(Value::parse_scalar("'it''s'"), Value::Str("it's".into()));
        assert_eq!(Value::parse_scalar("a # b"), Value::Str("a".into()));
        assert_eq!(Value::parse_scalar("\"a # b\""), Value::Str("a # b".into()));
    }

    #[test]
    fn flow_collections_nest() {
        assert_eq!(
            parse_value("[1, 2, 3]", 1).unwrap(),
            Value::List(vec![Value::Int(1), Value::Int(2), Value::Int(3)])
        );
        assert_eq!(parse_value("[]", 1).unwrap(), Value::List(vec![]));
        let map = parse_value("{a: 1, b: [x, y]}", 1).unwrap();
        let expected = Value::Map(Map::from([
            ("a".to_string(), Value::Int(1)),
            (
                "b".to_string(),
                Value::List(vec![Value::Str("x".into()), Value::Str("y".into())]),
            ),
        ]));
        assert_eq!(map, expected);
    }

    #[test]
    fn broken_quote_is_rejected_not_stringified() {
        assert!(matches!(
            parse_value("\"unclosed", 1),
            Err(ValueReject::Malformed(_))
        ));
        assert!(matches!(
            parse_value("[1, 2", 1),
            Err(ValueReject::Malformed(_))
        ));
    }

    #[test]
    fn depth_cap_is_enforced() {
        let deep = "[[[[[[1]]]]]]";
        assert_eq!(parse_value(deep, 1), Err(ValueReject::Depth));
    }

    #[test]
    fn inline_yaml_round_trips() {
        for value in [
            Value::Null,
            Value::Bool(true),
            Value::Int(-7),
            Value::Float(1.25),
            Value::Str("plain".into()),
            Value::Str("true".into()),
            Value::Str("12".into()),
            Value::Str("".into()),
            Value::Str("has: colon".into()),
            Value::Str("with \"quotes\"".into()),
            Value::List(vec![Value::Int(1), Value::Str("a b".into())]),
            Value::Map(Map::from([("k".to_string(), Value::Bool(false))])),
        ] {
            let text = value.to_yaml_inline();
            let back = parse_value(&text, 1).unwrap_or_else(|e| panic!("{text:?}: {e:?}"));
            assert_eq!(back, value, "round-trip of {text:?}");
        }
    }
}

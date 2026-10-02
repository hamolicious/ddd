use crate::date::Date;
use crate::diagnostics::{Diagnostic, DiagnosticKind};
use crate::limits::{MAX_ARRAY_ITEMS, is_valid_key};
use crate::value::{Map, Value, ValueReject, parse_value, split_key, unquote_key};

#[derive(Debug, Clone, Copy)]
pub(crate) struct Line<'t> {
    pub index: usize,
    pub start: usize,
    pub end: usize,
    pub full_end: usize,
    pub content: &'t str,
}

impl Line<'_> {
    pub fn number(&self) -> u32 {
        u32::try_from(self.index + 1).unwrap_or(u32::MAX)
    }
}

pub(crate) fn lines(text: &str) -> Vec<Line<'_>> {
    let mut out = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0usize;
    let mut index = 0usize;
    while start < bytes.len() {
        match text[start..].find('\n') {
            Some(offset) => {
                let newline = start + offset;
                let mut end = newline;
                if end > start && bytes[end - 1] == b'\r' {
                    end -= 1;
                }
                out.push(Line {
                    index,
                    start,
                    end,
                    full_end: newline + 1,
                    content: &text[start..end],
                });
                start = newline + 1;
                index += 1;
            }
            None => {
                let mut end = bytes.len();
                if end > start && bytes[end - 1] == b'\r' {
                    end -= 1;
                }
                out.push(Line {
                    index,
                    start,
                    end,
                    full_end: bytes.len(),
                    content: &text[start..end],
                });
                break;
            }
        }
    }
    out
}

pub(crate) enum LineOutcome {
    Skip,
    Pair {
        key: String,
        value: Value,
    },
    Reject {
        kind: DiagnosticKind,
        key: Option<String>,
        message: &'static str,
    },
}

pub(crate) fn parse_line(content: &str) -> LineOutcome {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return LineOutcome::Skip;
    }
    if trimmed.starts_with('#') {
        return LineOutcome::Skip;
    }
    if content.starts_with([' ', '\t']) {
        return LineOutcome::Reject {
            kind: DiagnosticKind::MalformedLine,
            key: None,
            message: "indented lines are outside the strict YAML subset",
        };
    }
    if trimmed == "---" || trimmed == "..." {
        return LineOutcome::Reject {
            kind: DiagnosticKind::UnsupportedFeature,
            key: None,
            message: "multi-document markers are not supported",
        };
    }
    if trimmed == "-" || trimmed.starts_with("- ") {
        return LineOutcome::Reject {
            kind: DiagnosticKind::UnsupportedFeature,
            key: None,
            message: "block sequences are outside the strict YAML subset",
        };
    }
    if trimmed.starts_with("<<") {
        return LineOutcome::Reject {
            kind: DiagnosticKind::UnsupportedFeature,
            key: None,
            message: "merge keys are not supported",
        };
    }
    let Some((raw_key, raw_value)) = split_key(trimmed) else {
        return LineOutcome::Reject {
            kind: DiagnosticKind::MalformedLine,
            key: None,
            message: "not a `key: value` line",
        };
    };
    let key = unquote_key(raw_key);
    if !is_valid_key(&key) {
        return LineOutcome::Reject {
            kind: DiagnosticKind::InvalidKey,
            key: Some(truncate_key(&key)),
            message: "key does not match ^[A-Za-z0-9_-]{1,64}$",
        };
    }
    match parse_value(raw_value, 1) {
        Ok(value) => LineOutcome::Pair { key, value },
        Err(reject) => {
            let (kind, message) = match reject {
                ValueReject::Depth => (
                    DiagnosticKind::LimitExceeded,
                    "value nesting exceeds the depth cap",
                ),
                ValueReject::ArrayItems => (
                    DiagnosticKind::LimitExceeded,
                    "flow collection exceeds the item cap",
                ),
                ValueReject::StringBytes => (
                    DiagnosticKind::LimitExceeded,
                    "string value exceeds the length cap",
                ),
                ValueReject::Unsupported(message) => (DiagnosticKind::UnsupportedFeature, message),
                ValueReject::Malformed(message) => (DiagnosticKind::InvalidValue, message),
            };
            LineOutcome::Reject {
                kind,
                key: Some(key),
                message,
            }
        }
    }
}

pub(crate) fn line_key(content: &str) -> Option<String> {
    let trimmed = content.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') || content.starts_with([' ', '\t']) {
        return None;
    }
    let (raw_key, _) = split_key(trimmed)?;
    let key = unquote_key(raw_key);
    is_valid_key(&key).then_some(key)
}

pub(crate) struct BlockParse {
    pub map: Map,
    pub diagnostics: Vec<Diagnostic>,
    pub had_error: bool,
}

pub(crate) fn parse_block_lines(inner: &str, first_line: u32, max_keys: usize) -> BlockParse {
    parse_lines(inner, first_line, max_keys, true)
}

pub(crate) fn parse_frontmatter_lines(inner: &str, first_line: u32, max_keys: usize) -> BlockParse {
    parse_lines(inner, first_line, max_keys, true)
}

fn parse_lines(
    inner: &str,
    first_line: u32,
    max_keys: usize,
    allow_block_sequences: bool,
) -> BlockParse {
    let mut map = Map::new();
    let mut diagnostics = Vec::new();
    let mut had_error = false;
    let source = lines(inner);
    let mut cursor = 0usize;
    while cursor < source.len() {
        let line = source[cursor];
        let number = first_line.saturating_add(u32::try_from(line.index).unwrap_or(u32::MAX));
        let mut consumed = 1usize;
        let mut outcome = parse_line(line.content);
        if allow_block_sequences
            && empty_value_key(line.content).is_some()
            && let LineOutcome::Pair { key, .. } = &outcome
        {
            let (items, used, mut item_diagnostics) =
                block_sequence(&source, cursor + 1, first_line);
            if used > 0 {
                had_error |= !item_diagnostics.is_empty();
                diagnostics.append(&mut item_diagnostics);
                consumed += used;
                outcome = LineOutcome::Pair {
                    key: key.clone(),
                    value: Value::List(items),
                };
            }
        }
        match outcome {
            LineOutcome::Skip => {}
            LineOutcome::Reject { kind, key, message } => {
                had_error = true;
                diagnostics.push(Diagnostic::new(kind, number, key, message));
            }
            LineOutcome::Pair { key, mut value } => {
                let known = map.contains_key(&key);
                if !known && map.len() >= max_keys {
                    had_error = true;
                    diagnostics.push(Diagnostic::new(
                        DiagnosticKind::LimitExceeded,
                        number,
                        Some(key),
                        "key count cap reached; remaining keys dropped",
                    ));
                    cursor += consumed;
                    continue;
                }
                if known {
                    diagnostics.push(Diagnostic::new(
                        DiagnosticKind::DuplicateKey,
                        number,
                        Some(key.clone()),
                        "duplicate key; last occurrence wins",
                    ));
                }
                normalize_dates(&mut value);
                map.insert(key, value);
            }
        }
        cursor += consumed;
    }
    BlockParse {
        map,
        diagnostics,
        had_error,
    }
}

pub(crate) fn empty_value_key(content: &str) -> Option<String> {
    if content.starts_with([' ', '\t']) {
        return None;
    }
    let (raw_key, raw_value) = split_key(content.trim())?;
    if !raw_value.trim().is_empty() {
        return None;
    }
    let key = unquote_key(raw_key);
    is_valid_key(&key).then_some(key)
}

fn block_sequence(
    source: &[Line<'_>],
    start: usize,
    first_line: u32,
) -> (Vec<Value>, usize, Vec<Diagnostic>) {
    let Some(first) = source.get(start) else {
        return (Vec::new(), 0, Vec::new());
    };
    let Some((indent, _)) = block_item(first.content) else {
        return (Vec::new(), 0, Vec::new());
    };
    let mut items = Vec::new();
    let mut diagnostics = Vec::new();
    let mut used = 0usize;
    for line in &source[start..] {
        let Some((item_indent, raw)) = block_item(line.content) else {
            break;
        };
        if item_indent != indent {
            break;
        }
        used += 1;
        let number = first_line.saturating_add(u32::try_from(line.index).unwrap_or(u32::MAX));
        if used > MAX_ARRAY_ITEMS {
            diagnostics.push(Diagnostic::new(
                DiagnosticKind::LimitExceeded,
                number,
                None,
                "block sequence exceeds the item cap; remaining items dropped",
            ));
            continue;
        }
        match parse_value(raw, 2) {
            Ok(value) => items.push(value),
            Err(reject) => {
                let (kind, message) = reject_detail(reject);
                diagnostics.push(Diagnostic::new(kind, number, None, message));
            }
        }
    }
    (items, used, diagnostics)
}

pub(crate) fn block_item(content: &str) -> Option<(usize, &str)> {
    let indent = content.len() - content.trim_start_matches([' ', '\t']).len();
    if indent == 0 {
        return None;
    }
    let rest = &content[indent..];
    if rest == "-" {
        return Some((indent, ""));
    }
    rest.strip_prefix("- ").map(|value| (indent, value))
}

pub(crate) fn expanded_value_end<'s, 't>(
    source: &'s [Line<'t>],
    header: usize,
) -> Option<&'s Line<'t>> {
    empty_value_key(source.get(header)?.content)?;
    let first = source.get(header + 1)?;
    let (indent, _) = block_item(first.content)?;
    let mut last = first;
    for line in &source[header + 2..] {
        let Some((item_indent, _)) = block_item(line.content) else {
            break;
        };
        if item_indent != indent {
            break;
        }
        last = line;
    }
    Some(last)
}

fn reject_detail(reject: ValueReject) -> (DiagnosticKind, &'static str) {
    match reject {
        ValueReject::Depth => (
            DiagnosticKind::LimitExceeded,
            "value nesting exceeds the depth cap",
        ),
        ValueReject::ArrayItems => (
            DiagnosticKind::LimitExceeded,
            "flow collection exceeds the item cap",
        ),
        ValueReject::StringBytes => (
            DiagnosticKind::LimitExceeded,
            "string value exceeds the length cap",
        ),
        ValueReject::Unsupported(message) => (DiagnosticKind::UnsupportedFeature, message),
        ValueReject::Malformed(message) => (DiagnosticKind::InvalidValue, message),
    }
}

pub(crate) fn normalize_dates(value: &mut Value) {
    match value {
        Value::Str(text) => {
            if Date::looks_like_date(text) {
                *text = Date::normalize_str(text);
            }
        }
        Value::List(items) => items.iter_mut().for_each(normalize_dates),
        Value::Map(map) => map.values_mut().for_each(normalize_dates),
        _ => {}
    }
}

fn truncate_key(key: &str) -> String {
    const MAX: usize = 80;
    if key.len() <= MAX {
        return key.to_string();
    }
    let mut end = MAX;
    while end > 0 && !key.is_char_boundary(end) {
        end -= 1;
    }
    key[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(inner: &str) -> Vec<String> {
        parse_block_lines(inner, 1, 200)
            .map
            .keys()
            .cloned()
            .collect()
    }

    #[test]
    fn lines_track_offsets_and_crlf() {
        let text = "a\r\nb\nc";
        let ls = lines(text);
        assert_eq!(ls.len(), 3);
        assert_eq!(ls[0].content, "a");
        assert_eq!(ls[0].full_end, 3);
        assert_eq!(ls[1].content, "b");
        assert_eq!(ls[2].content, "c");
        assert_eq!(ls[2].full_end, text.len());
    }

    #[test]
    fn tolerant_per_line_parse() {
        let parsed = parse_block_lines("title: A\nbroken\nkeep: 1\n", 1, 200);
        assert!(parsed.had_error);
        assert_eq!(parsed.map.len(), 2);
        assert_eq!(parsed.diagnostics.len(), 1);
        assert_eq!(parsed.diagnostics[0].line, 2);
    }

    #[test]
    fn duplicate_keys_last_wins_without_error_flag() {
        let parsed = parse_block_lines("a: 1\na: 2\n", 1, 200);
        assert!(!parsed.had_error);
        assert_eq!(parsed.map.get("a"), Some(&Value::Int(2)));
        assert_eq!(parsed.diagnostics.len(), 1);
        assert_eq!(parsed.diagnostics[0].kind, DiagnosticKind::DuplicateKey);
    }

    #[test]
    fn machine_block_sequences_are_materialized() {
        let parsed = parse_block_lines("tags:\n  - a\n  - b\nok: 1\n  stray: 2\n", 1, 200);
        assert_eq!(
            parsed.map.get("tags"),
            Some(&Value::List(vec![
                Value::Str("a".into()),
                Value::Str("b".into())
            ]))
        );
        assert_eq!(parsed.map.get("ok"), Some(&Value::Int(1)));
        assert!(parsed.had_error);
        assert_eq!(parsed.diagnostics.len(), 1);
    }

    #[test]
    fn frontmatter_block_sequences_are_materialized() {
        let parsed = parse_frontmatter_lines(
            "tags:\n  - work\n  - home\nrefs:\n\t- \"[[work]]\"\nok: 1\n",
            1,
            200,
        );
        assert!(!parsed.had_error);
        assert_eq!(
            parsed.map.get("tags"),
            Some(&Value::List(vec![
                Value::Str("work".into()),
                Value::Str("home".into()),
            ]))
        );
        assert_eq!(
            parsed.map.get("refs"),
            Some(&Value::List(vec![Value::Str("[[work]]".into())]))
        );
    }

    #[test]
    fn one_bad_block_item_does_not_drop_the_rest() {
        let parsed =
            parse_frontmatter_lines("tags:\n  - good\n  - [broken\n  - last\nok: 1\n", 1, 200);
        assert!(parsed.had_error);
        assert_eq!(
            parsed.map.get("tags"),
            Some(&Value::List(vec![
                Value::Str("good".into()),
                Value::Str("last".into()),
            ]))
        );
        assert_eq!(parsed.map.get("ok"), Some(&Value::Int(1)));
        assert_eq!(parsed.diagnostics.len(), 1);
        assert_eq!(parsed.diagnostics[0].line, 3);
    }

    #[test]
    fn dates_normalize_at_parse() {
        let parsed = parse_block_lines("due: 2026-09-23T12:00:00+02:00\n", 1, 200);
        assert_eq!(
            parsed.map.get("due"),
            Some(&Value::Str("2026-09-23T10:00:00.000Z".into()))
        );
    }

    #[test]
    fn key_cap_drops_extra_keys() {
        let inner: String = (0..5).map(|i| format!("k{i}: {i}\n")).collect();
        let parsed = parse_block_lines(&inner, 1, 3);
        assert!(parsed.had_error);
        assert_eq!(keys("a: 1\n"), vec!["a".to_string()]);
        assert_eq!(parsed.map.len(), 3);
    }

    #[test]
    fn invalid_keys_are_dropped() {
        let parsed = parse_block_lines("bad key: 1\nok: 2\n", 1, 200);
        assert!(parsed.had_error);
        assert_eq!(parsed.map.len(), 1);
        assert_eq!(parsed.diagnostics[0].kind, DiagnosticKind::InvalidKey);
    }
}

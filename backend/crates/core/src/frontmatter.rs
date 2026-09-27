//! Frontmatter: the leading `---` YAML block, human-owned (SPEC §3.3, §3.4).
//!
//! Fence rules are byte-exact on both sides: the block opens only if `---` is
//! the literal first line, and closes at the next line that is exactly `---`.
//! If it never closes, there is no frontmatter at all.
//!
//! "Literal" means literal: a fence line with trailing whitespace is not a
//! fence. Body parsing is per-line and stateless — see [`crate::yaml`].

use serde::{Deserialize, Serialize};

use crate::diagnostics::{Diagnostic, DiagnosticKind};
use crate::document::Span;
use crate::limits::{MAX_FRONTMATTER_BYTES, MAX_FRONTMATTER_KEYS};
use crate::value::Map;
use crate::yaml;

/// The fence line, byte-exact.
pub(crate) const FENCE: &str = "---";

/// Result of parsing one frontmatter block.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Frontmatter {
    /// Materialized keys. Keys failing `^[A-Za-z0-9_-]{1,64}$` are dropped.
    pub map: Map,
    /// `true` when at least one line was dropped or a cap was hit.
    pub had_error: bool,
    /// Dropped lines, in document order.
    pub diagnostics: Vec<Diagnostic>,
}

/// Locate the frontmatter block in a (normalized) document.
///
/// Returns `(outer, inner)`: `outer` covers both fence lines and the trailing
/// newline of the closing fence; `inner` covers only the YAML lines between
/// them. `None` when the document does not open with `---` or never closes it.
pub fn find_block(text: &str) -> Option<(Span, Span)> {
    let lines = yaml::lines(text);
    let first = lines.first()?;
    if first.content != FENCE {
        return None;
    }
    for line in &lines[1..] {
        if line.content == FENCE {
            return Some((
                Span::new(0, line.full_end),
                Span::new(first.full_end, line.start),
            ));
        }
    }
    None
}

/// Parse the YAML lines of a frontmatter block.
///
/// `inner` is the text between the fences; `first_line` is the 1-based document
/// line number of its first line, so diagnostics carry document coordinates.
pub fn parse_block(inner: &str, first_line: u32) -> Frontmatter {
    if inner.len() > MAX_FRONTMATTER_BYTES {
        return Frontmatter {
            map: Map::new(),
            had_error: true,
            diagnostics: vec![Diagnostic::new(
                DiagnosticKind::LimitExceeded,
                first_line,
                None,
                "frontmatter block exceeds the size cap; no keys materialized",
            )],
        };
    }
    let parsed = yaml::parse_frontmatter_lines(inner, first_line, MAX_FRONTMATTER_KEYS);
    Frontmatter {
        map: parsed.map,
        had_error: parsed.had_error,
        diagnostics: parsed.diagnostics,
    }
}

/// Convenience: locate and parse in one call.
///
/// When the first line is `---` but the block never closes, there is no
/// frontmatter (spans are `None`) and an [`DiagnosticKind::UnterminatedFence`]
/// diagnostic is recorded — which is also what tells
/// [`crate::document::edit_affects_metadata`] that the tail of this document is
/// metadata-sensitive.
pub fn parse(text: &str) -> (Option<(Span, Span)>, Frontmatter) {
    match find_block(text) {
        Some((outer, inner)) => {
            let frontmatter = parse_block(inner.slice(text), 2);
            (Some((outer, inner)), frontmatter)
        }
        None => {
            let opens = yaml::lines(text)
                .first()
                .is_some_and(|line| line.content == FENCE);
            if opens {
                (
                    None,
                    Frontmatter {
                        map: Map::new(),
                        had_error: true,
                        diagnostics: vec![Diagnostic::new(
                            DiagnosticKind::UnterminatedFence,
                            1,
                            None,
                            "frontmatter fence is never closed; no frontmatter block",
                        )],
                    },
                )
            } else {
                (None, Frontmatter::default())
            }
        }
    }
}

/// Span of the *value* of `key` inside the frontmatter block — the minimal
/// splice target for UI edits (SPEC §3.3: never parse→re-serialize→replace).
///
/// Returns `None` when there is no frontmatter or the key is absent. Only
/// top-level keys are addressable. When the key occurs more than once the
/// **last** occurrence is returned (last-occurrence-wins, SPEC §3.3). An empty
/// value yields an empty span at the end of the line.
pub fn value_span(text: &str, key: &str) -> Option<Span> {
    let (_, inner) = find_block(text)?;
    let block_lines = yaml::lines(inner.slice(text));
    let mut found = None;
    for (index, line) in block_lines.iter().enumerate() {
        if yaml::line_key(line.content).as_deref() != Some(key) {
            continue;
        }
        let line_start = inner.start + line.start;
        let line_end = inner.start + line.end;
        let colon = line.content.find(':')?;
        let after = line_start + colon + 1;
        // First non-space byte after the colon, then trim the trailing run.
        let rest = &text[after..line_end];
        let lead = rest.len() - rest.trim_start_matches([' ', '\t']).len();
        let trail = rest.len() - rest.trim_end_matches([' ', '\t']).len();
        let start = after + lead;
        let end = (line_end - trail).max(start);
        let expanded_end = yaml::expanded_value_end(&block_lines, index)
            .map(|last| inner.start + last.end)
            .unwrap_or(end);
        found = Some(Span::new(start, expanded_end));
    }
    found
}

/// Span of the whole `key: value` line, including its trailing newline. Used
/// when a key is removed entirely. Last occurrence when duplicated.
pub fn line_span(text: &str, key: &str) -> Option<Span> {
    line_spans(text, key).pop()
}

/// Every line span defining `key`, in document order. Removal touches all of
/// them so a duplicated key genuinely disappears.
pub(crate) fn line_spans(text: &str, key: &str) -> Vec<Span> {
    let Some((_, inner)) = find_block(text) else {
        return Vec::new();
    };
    let block_lines = yaml::lines(inner.slice(text));
    block_lines
        .iter()
        .enumerate()
        .filter(|(_, line)| yaml::line_key(line.content).as_deref() == Some(key))
        .map(|(index, line)| {
            let end = yaml::expanded_value_end(&block_lines, index)
                .map(|last| last.full_end)
                .unwrap_or(line.full_end);
            Span::new(inner.start + line.start, inner.start + end)
        })
        .collect()
}

/// Insertion point for a new key: the start of the closing fence line.
pub(crate) fn insert_point(text: &str) -> Option<usize> {
    find_block(text).map(|(_, inner)| inner.end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::Value;

    #[test]
    fn opens_only_on_a_literal_first_line() {
        assert!(find_block("---\na: 1\n---\n").is_some());
        assert!(find_block("\n---\na: 1\n---\n").is_none());
        assert!(find_block("--- \na: 1\n---\n").is_none());
        assert!(find_block("---\na: 1\n--- \n").is_none());
        assert!(find_block("---\na: 1\n").is_none());
        assert!(find_block("---").is_none());
        assert!(find_block("").is_none());
    }

    #[test]
    fn spans_cover_fences_and_body() {
        let text = "---\na: 1\n---\nbody\n";
        let (outer, inner) = find_block(text).unwrap();
        assert_eq!(outer, Span::new(0, 13));
        assert_eq!(inner, Span::new(4, 9));
        assert_eq!(inner.slice(text), "a: 1\n");
    }

    #[test]
    fn empty_block_parses_to_nothing() {
        let text = "---\n---\n";
        let (spans, fm) = parse(text);
        assert!(spans.is_some());
        assert!(fm.map.is_empty());
        assert!(!fm.had_error);
    }

    #[test]
    fn unterminated_fence_is_recorded() {
        let (spans, fm) = parse("---\na: 1\n");
        assert!(spans.is_none());
        assert!(fm.had_error);
        assert_eq!(fm.diagnostics[0].kind, DiagnosticKind::UnterminatedFence);
    }

    #[test]
    fn diagnostics_use_document_line_numbers() {
        let (_, fm) = parse("---\na: 1\nbroken\n---\n");
        assert_eq!(fm.diagnostics.len(), 1);
        assert_eq!(fm.diagnostics[0].line, 3);
    }

    #[test]
    fn value_and_line_spans() {
        let text = "---\ntitle: Groceries\nempty:\n---\n";
        let span = value_span(text, "title").unwrap();
        assert_eq!(span.slice(text), "Groceries");
        let span = value_span(text, "empty").unwrap();
        assert!(span.is_empty());
        assert_eq!(span.start, text.find("empty:").unwrap() + 6);
        let span = line_span(text, "title").unwrap();
        assert_eq!(span.slice(text), "title: Groceries\n");
        assert!(value_span(text, "missing").is_none());
    }

    #[test]
    fn duplicate_key_targets_the_last_occurrence() {
        let text = "---\na: 1\na: 2\n---\n";
        let (_, fm) = parse(text);
        assert_eq!(fm.map.get("a"), Some(&Value::Int(2)));
        assert_eq!(value_span(text, "a").unwrap().slice(text), "2");
        assert_eq!(line_spans(text, "a").len(), 2);
    }

    #[test]
    fn expanded_sequence_spans_include_the_item_lines() {
        let text = "---\nhubs:\n  - work\n  - home\nnext: 1\n---\n";
        assert_eq!(
            value_span(text, "hubs").unwrap().slice(text),
            "\n  - work\n  - home"
        );
        assert_eq!(
            line_span(text, "hubs").unwrap().slice(text),
            "hubs:\n  - work\n  - home\n"
        );
    }
}

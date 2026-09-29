//! `%%%` machine sections: the trailing, machine-owned region (SPEC §3.3, §3.4).
//!
//! Rules, byte-exact on both sides:
//! - Only the **last contiguous run** of `%%% <id>` … `%%%` fences at the end of
//!   the document counts. Anything earlier is body text.
//! - An opening fence is exactly `%%% ` followed by a plugin id matching
//!   `^[A-Za-z0-9_-]{1,64}$`; a closing fence is exactly `%%%`. Trailing
//!   whitespace on a fence line means it is not a fence.
//! - Blank lines are tolerated between sections of the run and after the final
//!   closing fence; they belong to the run, not to the body.
//! - One section per plugin id; format is YAML, **one key per line**.
//! - Duplicate lines for the same key resolve **last occurrence wins** (this is
//!   how per-key LWW is reconstructed on plain text). Two sections with the same
//!   plugin id merge the same way, later section winning per key.

use serde::{Deserialize, Serialize};

use crate::diagnostics::{Diagnostic, DiagnosticKind};
use crate::document::Span;
use crate::limits::{MAX_MACHINE_SECTIONS, MAX_SECTION_BYTES, MAX_SECTION_KEYS, is_valid_key};
use crate::value::{Map, Value};
use crate::yaml;

/// The closing fence line, byte-exact.
pub(crate) const FENCE: &str = "%%%";
/// The opening fence prefix, byte-exact.
pub(crate) const FENCE_OPEN: &str = "%%% ";

/// One parsed `%%% <plugin-id>` … `%%%` section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineSection {
    /// Plugin id from the opening fence.
    pub plugin_id: String,
    /// Span of the whole section including both fence lines.
    pub span: Span,
    /// Span of the YAML lines between the fences.
    pub body_span: Span,
    /// Materialized keys (last occurrence wins).
    pub map: Map,
    /// Dropped lines inside this section.
    pub diagnostics: Vec<Diagnostic>,
}

/// All machine sections of a document.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Sections {
    /// Sections in document order.
    pub sections: Vec<MachineSection>,
    /// Span covering the whole trailing run (first opening fence → end of the
    /// last closing fence). `None` when the document has no machine sections.
    pub run_span: Option<Span>,
    /// Diagnostics not attributable to a single section (unterminated fence,
    /// duplicate plugin id, section-count cap).
    pub diagnostics: Vec<Diagnostic>,
}

impl Sections {
    /// Look a section up by plugin id. The **last** section wins when a
    /// document contains the same plugin id twice, matching the
    /// last-occurrence-wins rule; that is also the section a splice writes to.
    pub fn get(&self, plugin_id: &str) -> Option<&MachineSection> {
        self.sections
            .iter()
            .rev()
            .find(|s| s.plugin_id == plugin_id)
    }

    /// Materialize the `plugins` map stored in Mongo: plugin id → its keys.
    pub fn to_plugins_map(&self) -> Map {
        let mut out = Map::new();
        for section in &self.sections {
            match out
                .entry(section.plugin_id.clone())
                .or_insert_with(|| Value::Map(Map::new()))
            {
                Value::Map(existing) => {
                    for (key, value) in &section.map {
                        existing.insert(key.clone(), value.clone());
                    }
                }
                // `or_insert_with` above guarantees a map.
                _ => unreachable!("plugins entries are always maps"),
            }
        }
        out
    }
}

/// Parse the trailing machine-section run out of a (normalized) document.
pub fn parse(text: &str) -> Sections {
    let lines = yaml::lines(text);
    let mut diagnostics = Vec::new();

    // Walk backwards from the last non-blank line, pairing `%%%` with the
    // nearest preceding `%%% <id>`.
    let mut cursor = lines.len();
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    loop {
        while cursor > 0 && lines[cursor - 1].content.trim().is_empty() {
            cursor -= 1;
        }
        if cursor == 0 {
            break;
        }
        let close = cursor - 1;
        if lines[close].content != FENCE {
            break;
        }
        let mut open = None;
        let mut probe = close;
        while probe > 0 {
            probe -= 1;
            if lines[probe].content == FENCE {
                break;
            }
            if open_fence_id(lines[probe].content).is_some() {
                open = Some(probe);
                break;
            }
        }
        match open {
            Some(index) => {
                pairs.push((index, close));
                cursor = index;
            }
            None => break,
        }
    }
    pairs.reverse();

    if pairs.is_empty() {
        // An opening fence with no closing fence anywhere after it: not a run,
        // but the tail of this document is metadata-sensitive.
        if let Some(open) = lines
            .iter()
            .rev()
            .find(|line| open_fence_id(line.content).is_some())
        {
            let closed = lines[open.index + 1..]
                .iter()
                .any(|line| line.content == FENCE);
            if !closed {
                diagnostics.push(Diagnostic::new(
                    DiagnosticKind::UnterminatedFence,
                    open.number(),
                    None,
                    "machine-section fence is never closed; no machine sections",
                ));
            }
        }
        return Sections {
            sections: Vec::new(),
            run_span: None,
            diagnostics,
        };
    }

    let run_span = Span::new(
        lines[pairs[0].0].start,
        lines[pairs[pairs.len() - 1].1].full_end,
    );

    let mut sections: Vec<MachineSection> = Vec::new();
    for (index, &(open, close)) in pairs.iter().enumerate() {
        if index >= MAX_MACHINE_SECTIONS {
            diagnostics.push(Diagnostic::new(
                DiagnosticKind::LimitExceeded,
                lines[open].number(),
                None,
                "machine-section count cap reached; remaining sections dropped",
            ));
            break;
        }
        let plugin_id = open_fence_id(lines[open].content)
            .expect("pairs only contain valid opening fences")
            .to_string();
        let span = Span::new(lines[open].start, lines[close].full_end);
        let body_span = Span::new(lines[open].full_end, lines[close].start);
        if sections.iter().any(|s| s.plugin_id == plugin_id) {
            diagnostics.push(Diagnostic::new(
                DiagnosticKind::DuplicateKey,
                lines[open].number(),
                Some(plugin_id.clone()),
                "duplicate machine section; later keys win",
            ));
        }
        let body = body_span.slice(text);
        let (map, section_diagnostics) = if body.len() > MAX_SECTION_BYTES {
            (
                Map::new(),
                vec![Diagnostic::new(
                    DiagnosticKind::LimitExceeded,
                    lines[open].number(),
                    Some(plugin_id.clone()),
                    "machine section exceeds the size cap; no keys materialized",
                )],
            )
        } else {
            let first_line = lines[open].number().saturating_add(1);
            let parsed = yaml::parse_block_lines(body, first_line, MAX_SECTION_KEYS);
            (parsed.map, parsed.diagnostics)
        };
        sections.push(MachineSection {
            plugin_id,
            span,
            body_span,
            map,
            diagnostics: section_diagnostics,
        });
    }

    Sections {
        sections,
        run_span: Some(run_span),
        diagnostics,
    }
}

/// Plugin id of an opening fence line, or `None` when the line is not one.
pub(crate) fn open_fence_id(content: &str) -> Option<&str> {
    let id = content.strip_prefix(FENCE_OPEN)?;
    is_valid_key(id).then_some(id)
}

/// Span of the line defining `key` inside `section` (including its trailing
/// newline) — the splice target for a single-key write (SPEC §3.3).
///
/// When the key occurs more than once, the **last** occurrence is returned.
pub fn key_line_span(text: &str, section: &MachineSection, key: &str) -> Option<Span> {
    key_line_spans(text, section, key).pop()
}

/// Every line span defining `key` inside `section`, in document order. A key
/// holding a block sequence spans its item lines too, so rewriting or removing
/// it never strands an item.
pub(crate) fn key_line_spans(text: &str, section: &MachineSection, key: &str) -> Vec<Span> {
    let body = section.body_span.slice(text);
    let body_lines = yaml::lines(body);
    body_lines
        .iter()
        .enumerate()
        .filter(|(_, line)| yaml::line_key(line.content).as_deref() == Some(key))
        .map(|(index, line)| {
            let end = yaml::expanded_value_end(&body_lines, index)
                .map(|last| last.full_end)
                .unwrap_or(line.full_end);
            Span::new(
                section.body_span.start + line.start,
                section.body_span.start + end,
            )
        })
        .collect()
}

/// Insertion point for a new key inside `section` (just before the closing
/// fence).
pub fn insert_point(section: &MachineSection) -> usize {
    section.body_span.end
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "# Groceries\n\nbody\n\n%%% calendar\nsource-uid: abc123\n%%%\n";

    #[test]
    fn parses_the_trailing_run() {
        let parsed = parse(DOC);
        assert_eq!(parsed.sections.len(), 1);
        let section = &parsed.sections[0];
        assert_eq!(section.plugin_id, "calendar");
        assert_eq!(
            section.span.slice(DOC),
            "%%% calendar\nsource-uid: abc123\n%%%\n"
        );
        assert_eq!(section.body_span.slice(DOC), "source-uid: abc123\n");
        assert_eq!(
            section.map.get("source-uid"),
            Some(&Value::Str("abc123".into()))
        );
        assert_eq!(
            parsed.run_span.unwrap().start,
            DOC.find("%%% calendar").unwrap()
        );
    }

    #[test]
    fn only_the_last_contiguous_run_counts() {
        let text = "%%% early\na: 1\n%%%\n\nbody text\n\n%%% late\nb: 2\n%%%\n";
        let parsed = parse(text);
        assert_eq!(parsed.sections.len(), 1);
        assert_eq!(parsed.sections[0].plugin_id, "late");
    }

    #[test]
    fn adjacent_and_blank_separated_sections_join_the_run() {
        let text = "body\n%%% a\nx: 1\n%%%\n%%% b\ny: 2\n%%%\n\n%%% c\nz: 3\n%%%\n\n";
        let parsed = parse(text);
        let ids: Vec<&str> = parsed
            .sections
            .iter()
            .map(|s| s.plugin_id.as_str())
            .collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
        assert_eq!(parsed.run_span.unwrap().start, text.find("%%% a").unwrap());
        assert_eq!(
            parsed.run_span.unwrap().end,
            text.rfind("%%%\n").unwrap() + 4
        );
    }

    #[test]
    fn unterminated_fence_yields_no_sections() {
        let parsed = parse("body\n%%% calendar\na: 1\n");
        assert!(parsed.sections.is_empty());
        assert_eq!(parsed.diagnostics.len(), 1);
        assert_eq!(
            parsed.diagnostics[0].kind,
            DiagnosticKind::UnterminatedFence
        );
    }

    #[test]
    fn fences_are_byte_exact() {
        assert!(parse("%%% a \nx: 1\n%%%\n").sections.is_empty());
        assert!(parse("%%%a\nx: 1\n%%%\n").sections.is_empty());
        assert!(parse("%%% a\nx: 1\n%%% \n").sections.is_empty());
        assert!(parse("%%% bad id\nx: 1\n%%%\n").sections.is_empty());
        assert_eq!(parse("%%% a\nx: 1\n%%%").sections.len(), 1);
    }

    #[test]
    fn duplicate_sections_merge_later_wins() {
        let text = "%%% a\nx: 1\ny: 1\n%%%\n%%% a\ny: 2\n%%%\n";
        let parsed = parse(text);
        assert_eq!(parsed.sections.len(), 2);
        assert_eq!(parsed.get("a").unwrap().map.get("y"), Some(&Value::Int(2)));
        let plugins = parsed.to_plugins_map();
        let a = plugins.get("a").unwrap().as_map().unwrap();
        assert_eq!(a.get("x"), Some(&Value::Int(1)));
        assert_eq!(a.get("y"), Some(&Value::Int(2)));
        assert_eq!(parsed.diagnostics[0].kind, DiagnosticKind::DuplicateKey);
    }

    #[test]
    fn duplicate_key_lines_resolve_last_occurrence_wins() {
        let text = "%%% a\nk: 1\nk: 2\n%%%\n";
        let parsed = parse(text);
        let section = &parsed.sections[0];
        assert_eq!(section.map.get("k"), Some(&Value::Int(2)));
        assert_eq!(key_line_spans(text, section, "k").len(), 2);
        assert_eq!(
            key_line_span(text, section, "k").unwrap().slice(text),
            "k: 2\n"
        );
    }

    #[test]
    fn insert_point_is_before_the_closing_fence() {
        let parsed = parse(DOC);
        let section = &parsed.sections[0];
        assert_eq!(insert_point(section), DOC.find("%%%\n").unwrap());
    }

    #[test]
    fn empty_section_body() {
        let text = "%%% a\n%%%\n";
        let parsed = parse(text);
        let section = &parsed.sections[0];
        assert!(section.map.is_empty());
        assert!(section.body_span.is_empty());
        assert_eq!(insert_point(section), 6);
    }
}

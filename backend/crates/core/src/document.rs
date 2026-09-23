//! The one-pass document parse: the three regions of one string
//! (SPEC §3.1, §3.4) and everything materialized from them (SPEC §3.5).

use std::borrow::Cow;

use serde::{Deserialize, Serialize};

use crate::diagnostics::{Diagnostic, DiagnosticKind};
use crate::sections::MachineSection;
use crate::value::Map;
use crate::{frontmatter, sections, title};

/// A half-open byte range into the document text. UTF-8 byte offsets — callers
/// that need UTF-16 indices (yrs/Yjs interop) convert at the boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    pub fn len(&self) -> usize {
        self.end.saturating_sub(self.start)
    }

    pub fn is_empty(&self) -> bool {
        self.end <= self.start
    }

    /// Slice the span out of `text`. Panics if the span is not on char
    /// boundaries — spans produced by this crate always are.
    pub fn slice<'t>(&self, text: &'t str) -> &'t str {
        &text[self.start..self.end]
    }

    /// `true` when the two spans overlap or merely touch. Touching counts: an
    /// insertion at a region's boundary can change that region.
    fn touches(&self, other: Span) -> bool {
        self.start <= other.end && other.start <= self.end
    }
}

/// Everything the shared core derives from one document text.
///
/// Field semantics are frozen: the server writes `fm`, `plugins`, `title`,
/// `fm_parse_error` straight into Mongo (SPEC §3.5) and the client kernel
/// projects the same shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedDocument {
    /// Span of the whole frontmatter block including both `---` fence lines,
    /// `None` when the document has no frontmatter.
    pub frontmatter_span: Option<Span>,
    /// Span of the markdown body: after the frontmatter block, before the
    /// trailing `%%%` run.
    pub body_span: Span,
    /// Materialized frontmatter keys (invalid keys dropped).
    pub fm: Map,
    /// `true` when any frontmatter line was dropped or a cap was hit.
    pub fm_parse_error: bool,
    /// Parsed `%%%` machine sections, document order.
    pub sections: Vec<MachineSection>,
    /// Materialized `plugins` map: plugin id → section keys.
    pub plugins: Map,
    /// Resolved title (SPEC §3.4 title resolution).
    pub title: String,
    /// Every dropped line, frontmatter and sections together.
    pub diagnostics: Vec<Diagnostic>,
}

impl ParsedDocument {
    /// Span of the trailing machine-section run, when the document has one.
    pub fn sections_span(&self) -> Option<Span> {
        match (self.sections.first(), self.sections.last()) {
            (Some(first), Some(last)) => Some(Span::new(first.span.start, last.span.end)),
            _ => None,
        }
    }
}

/// Parse a document text into all three regions plus everything materialized.
///
/// Deterministic and total: any input, however malformed, yields a
/// `ParsedDocument`. Caps from [`crate::limits`] are enforced here.
///
/// `text` is expected to already be newline-normalized ([`normalize_input`]);
/// this function normalizes defensively and reports spans against the
/// normalized text.
pub fn parse_document(text: &str) -> ParsedDocument {
    let normalized = normalize_input(text);
    let text = normalized.as_ref();

    let (frontmatter_span, fm) = frontmatter::parse(text);
    let sections = sections::parse(text);

    let body_start = frontmatter_span.map_or(0, |(outer, _)| outer.end);
    let body_end = sections.run_span.map_or(text.len(), |run| run.start);
    let body_span = Span::new(body_start, body_end.max(body_start));

    let title = title::resolve(&fm.map, body_span.slice(text));
    let plugins = sections.to_plugins_map();

    let mut diagnostics = fm.diagnostics;
    diagnostics.extend(sections.diagnostics.iter().cloned());
    for section in &sections.sections {
        diagnostics.extend(section.diagnostics.iter().cloned());
    }
    // Stable sort by line so the diagnostic list is deterministic regardless of
    // which region produced an entry.
    diagnostics.sort_by_key(|diagnostic| diagnostic.line);

    ParsedDocument {
        frontmatter_span: frontmatter_span.map(|(outer, _)| outer),
        body_span,
        fm: fm.map,
        fm_parse_error: fm.had_error,
        sections: sections.sections,
        plugins,
        title,
        diagnostics,
    }
}

/// Normalize input before parsing: strip a leading UTF-8 BOM, convert CRLF and
/// lone CR to LF. Returns borrowed text when already normal (SPEC §3.4).
pub fn normalize_input(text: &str) -> Cow<'_, str> {
    let stripped = text.strip_prefix('\u{feff}').unwrap_or(text);
    if !stripped.contains('\r') {
        return match stripped.len() == text.len() {
            true => Cow::Borrowed(text),
            false => Cow::Borrowed(stripped),
        };
    }
    let mut out = String::with_capacity(stripped.len());
    let mut chars = stripped.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            // CRLF and a lone CR both become one LF.
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    Cow::Owned(out)
}

/// Stable hash of a document's materialized inputs, used as
/// `materialized_version` when no CRDT state vector is at hand.
///
/// FNV-1a, two independently seeded passes, hex-encoded — no dependency, and
/// byte-identical on every target (the Wasm build must agree with the server).
pub fn content_fingerprint(text: &str) -> String {
    const OFFSET_A: u64 = 0xcbf2_9ce4_8422_2325;
    const OFFSET_B: u64 = 0x1e07_9db3_c9be_7b8f;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut a = OFFSET_A;
    let mut b = OFFSET_B;
    for byte in text.as_bytes() {
        a = (a ^ u64::from(*byte)).wrapping_mul(PRIME);
        b = (b ^ u64::from(byte.rotate_left(3))).wrapping_mul(PRIME);
    }
    format!("{a:016x}{b:016x}")
}

/// `true` when a text edit spanning `edited` requires frontmatter / `%%%`
/// sections to be re-parsed, because the delta touches those regions, their
/// fences, or a document boundary where a new fence could appear.
///
/// Callers use the negation as the materialization short-circuit (SPEC §3.5:
/// "re-parse of fm/`%%%` is skipped when the post-apply text delta doesn't
/// intersect those regions or their fences"). `edited` is a span in the
/// **post-apply** text and `parsed` is the parse of that same text.
///
/// Conservative by construction: any unterminated fence makes the whole
/// document sensitive, since closing it elsewhere creates a region.
pub fn edit_affects_metadata(parsed: &ParsedDocument, edited: Span) -> bool {
    if parsed
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.kind == DiagnosticKind::UnterminatedFence)
    {
        return true;
    }
    match parsed.frontmatter_span {
        Some(span) => {
            if span.touches(edited) {
                return true;
            }
        }
        // No block yet: only an edit at the very start can open one, because a
        // frontmatter fence must be the literal first line.
        None => {
            if edited.start <= parsed.body_span.start {
                return true;
            }
        }
    }
    match parsed.sections_span() {
        Some(span) => span.touches(edited),
        // No run yet: only an edit reaching the end of the document can create
        // one, because a run must end at the last non-blank line.
        None => edited.end >= parsed.body_span.end,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::Value;

    const FULL: &str = "---\ntitle: Groceries\npath: home/lists\ndate: 2026-09-23\n---\n\n# Groceries\n\n- [ ] milk\n\n%%% calendar\nsource-uid: abc123@google.com\n%%%\n";

    #[test]
    fn parses_all_three_regions() {
        let parsed = parse_document(FULL);
        assert_eq!(
            parsed.frontmatter_span.unwrap().slice(FULL).lines().count(),
            5
        );
        assert_eq!(parsed.title, "Groceries");
        assert_eq!(
            parsed.fm.get("path"),
            Some(&Value::Str("home/lists".into()))
        );
        assert_eq!(
            parsed.fm.get("date"),
            Some(&Value::Str("2026-09-23".into()))
        );
        assert!(!parsed.fm_parse_error);
        assert_eq!(parsed.sections.len(), 1);
        let calendar = parsed.plugins.get("calendar").unwrap().as_map().unwrap();
        assert_eq!(
            calendar.get("source-uid"),
            Some(&Value::Str("abc123@google.com".into()))
        );
        let body = parsed.body_span.slice(FULL);
        assert!(body.starts_with("\n# Groceries"));
        assert!(!body.contains("%%%"));
        assert!(parsed.diagnostics.is_empty());
    }

    #[test]
    fn crlf_is_normalized_and_spans_follow() {
        let crlf = "---\r\ntitle: A\r\n---\r\n\r\nbody\r\n";
        let parsed = parse_document(crlf);
        assert_eq!(parsed.title, "A");
        let normalized = normalize_input(crlf);
        assert_eq!(normalized.as_ref(), "---\ntitle: A\n---\n\nbody\n");
        assert_eq!(
            parsed.frontmatter_span.unwrap().slice(normalized.as_ref()),
            "---\ntitle: A\n---\n"
        );
    }

    #[test]
    fn bom_is_stripped_only() {
        let parsed = parse_document("\u{feff}---\ntitle: A\n---\n");
        assert_eq!(parsed.title, "A");
        assert!(parsed.frontmatter_span.is_some());
        assert!(matches!(normalize_input("plain"), Cow::Borrowed("plain")));
        assert_eq!(normalize_input("a\rb").as_ref(), "a\nb");
    }

    #[test]
    fn empty_document() {
        let parsed = parse_document("");
        assert_eq!(parsed.title, "Untitled");
        assert!(parsed.frontmatter_span.is_none());
        assert!(parsed.sections.is_empty());
        assert!(parsed.body_span.is_empty());
    }

    #[test]
    fn fingerprint_is_stable_and_sensitive() {
        assert_eq!(content_fingerprint("abc"), content_fingerprint("abc"));
        assert_ne!(content_fingerprint("abc"), content_fingerprint("abd"));
        assert_ne!(content_fingerprint(""), content_fingerprint("a"));
        assert_eq!(content_fingerprint("abc").len(), 32);
    }

    #[test]
    fn metadata_intersection() {
        let parsed = parse_document(FULL);
        let fm = parsed.frontmatter_span.unwrap();
        assert!(edit_affects_metadata(&parsed, Span::new(0, 1)));
        assert!(edit_affects_metadata(&parsed, Span::new(fm.end, fm.end)));
        let run = parsed.sections_span().unwrap();
        assert!(edit_affects_metadata(
            &parsed,
            Span::new(run.start, run.start)
        ));
        assert!(edit_affects_metadata(
            &parsed,
            Span::new(FULL.len(), FULL.len())
        ));
        // Strictly inside the body: no re-parse needed.
        let inside = Span::new(fm.end + 2, fm.end + 3);
        assert!(!edit_affects_metadata(&parsed, inside));
    }

    #[test]
    fn unterminated_fence_forces_reparse() {
        let parsed = parse_document("---\ntitle: A\n\nbody\n");
        assert!(parsed.frontmatter_span.is_none());
        assert!(parsed.fm_parse_error);
        assert!(edit_affects_metadata(&parsed, Span::new(5, 5)));
    }

    #[test]
    fn tolerates_garbage_everywhere() {
        let ugly =
            "---\ntitle: \"broken\nbad key: 1\n2: x\n---\n\nbody\n\n%%% p\nok: 1\n!!: 2\n%%%\n";
        let parsed = parse_document(ugly);
        assert!(parsed.fm_parse_error);
        // `title` (broken quote) and `bad key` are dropped; `2` is a legal key.
        assert_eq!(parsed.fm.keys().collect::<Vec<_>>(), vec!["2"]);
        assert_eq!(parsed.title, "body");
        assert_eq!(parsed.sections.len(), 1);
        assert_eq!(parsed.sections[0].map.len(), 1);
        assert!(parsed.diagnostics.len() >= 3);
        // Deterministic: a second parse of the same text agrees exactly.
        assert_eq!(parsed, parse_document(ugly));
    }
}

use std::borrow::Cow;

use serde::{Deserialize, Serialize};

use crate::diagnostics::{Diagnostic, DiagnosticKind};
use crate::sections::MachineSection;
use crate::value::Map;
use crate::{frontmatter, sections, title};

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

    pub fn slice<'t>(&self, text: &'t str) -> &'t str {
        &text[self.start..self.end]
    }

    fn touches(&self, other: Span) -> bool {
        self.start <= other.end && other.start <= self.end
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedDocument {
    pub frontmatter_span: Option<Span>,
    pub body_span: Span,
    pub fm: Map,
    pub fm_parse_error: bool,
    pub sections: Vec<MachineSection>,
    pub plugins: Map,
    pub title: String,
    pub diagnostics: Vec<Diagnostic>,
}

impl ParsedDocument {
    pub fn sections_span(&self) -> Option<Span> {
        match (self.sections.first(), self.sections.last()) {
            (Some(first), Some(last)) => Some(Span::new(first.span.start, last.span.end)),
            _ => None,
        }
    }
}

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
        None => {
            if edited.start <= parsed.body_span.start {
                return true;
            }
        }
    }
    match parsed.sections_span() {
        Some(span) => span.touches(edited),
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
        assert_eq!(parsed.fm.keys().collect::<Vec<_>>(), vec!["2"]);
        assert_eq!(parsed.title, "body");
        assert_eq!(parsed.sections.len(), 1);
        assert_eq!(parsed.sections[0].map.len(), 1);
        assert!(parsed.diagnostics.len() >= 3);
        assert_eq!(parsed, parse_document(ugly));
    }
}

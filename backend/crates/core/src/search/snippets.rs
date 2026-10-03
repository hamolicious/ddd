use crate::document::{normalize_input, parse_document};
use crate::query::{Snippet, snippet_for};

pub fn snippet(content: &str, terms: &[String]) -> Option<Snippet> {
    let parsed = parse_document(content);
    let normalized = normalize_input(content);
    let body = parsed.body_span.slice(&normalized);
    let before = normalized[..parsed.body_span.start].matches('\n').count();
    snippet_for(body, terms).map(|found| Snippet {
        line: found.line + before,
        ..found
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippets_come_from_the_body_with_document_lines() {
        let found = snippet("---\nstatus: three\n---\n# T\n\n- [ ] three things\n", &["three".into()]).unwrap();
        assert_eq!(found.text, "- [ ] three things");
        assert_eq!(found.line, 6);
        assert_eq!(found.ranges.len(), 1);
        assert_eq!(&found.text[found.ranges[0].start..found.ranges[0].end], "three");
    }
}

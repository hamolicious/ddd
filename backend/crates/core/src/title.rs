use crate::limits::{TITLE_FALLBACK_MAX_CHARS, UNTITLED};
use crate::value::Map;

pub fn resolve(fm: &Map, body: &str) -> String {
    if let Some(title) = fm.get("title").and_then(|value| value.as_str()) {
        let trimmed = title.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(heading) = first_heading(body)
        && !heading.is_empty()
    {
        return truncate_chars(heading, TITLE_FALLBACK_MAX_CHARS).to_string();
    }
    if let Some(line) = first_non_empty_line(body)
        && !line.is_empty()
    {
        return truncate_chars(line, TITLE_FALLBACK_MAX_CHARS).to_string();
    }
    UNTITLED.to_string()
}

pub fn first_heading(body: &str) -> Option<&str> {
    for line in body.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let hashes = line.len() - line.trim_start_matches('#').len();
        if hashes == 0 || hashes > 6 {
            continue;
        }
        let rest = &line[hashes..];
        if !rest.starts_with([' ', '\t']) {
            continue;
        }
        let text = rest.trim();
        let stripped = text.trim_end_matches('#');
        let text = if stripped.len() == text.len() {
            text
        } else if stripped.is_empty() || stripped.ends_with([' ', '\t']) {
            stripped.trim_end()
        } else {
            text
        };
        if text.is_empty() {
            continue;
        }
        return Some(text);
    }
    None
}

pub fn first_non_empty_line(body: &str) -> Option<&str> {
    body.split('\n')
        .map(|line| line.trim())
        .find(|line| !line.is_empty())
}

pub fn truncate_chars(input: &str, max_chars: usize) -> &str {
    match input.char_indices().nth(max_chars) {
        Some((offset, _)) => &input[..offset],
        None => input,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::Value;

    fn fm(pairs: &[(&str, Value)]) -> Map {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn frontmatter_title_wins() {
        let map = fm(&[("title", Value::Str("  Groceries  ".into()))]);
        assert_eq!(resolve(&map, "# Heading\n"), "Groceries");
    }

    #[test]
    fn blank_or_non_string_title_falls_through() {
        assert_eq!(
            resolve(&fm(&[("title", Value::Str("   ".into()))]), "# Heading\n"),
            "Heading"
        );
        assert_eq!(
            resolve(&fm(&[("title", Value::Int(7))]), "# Heading\n"),
            "Heading"
        );
        assert_eq!(resolve(&fm(&[]), ""), UNTITLED);
        assert_eq!(resolve(&fm(&[]), "\n\n   \n"), UNTITLED);
    }

    #[test]
    fn headings() {
        assert_eq!(first_heading("## Two ##\n"), Some("Two"));
        assert_eq!(first_heading("text\n### Deep\n"), Some("Deep"));
        assert_eq!(first_heading("#NoSpace\n"), None);
        assert_eq!(first_heading("####### Seven\n"), None);
        assert_eq!(first_heading("  # Indented\n"), None);
        assert_eq!(first_heading("# a#b\n"), Some("a#b"));
        assert_eq!(first_heading("# \n## Real\n"), Some("Real"));
        assert_eq!(first_heading("# \n"), None);
        assert_eq!(resolve(&fm(&[]), "# \nplain line\n"), "#");
    }

    #[test]
    fn body_line_fallback_is_truncated() {
        let long = "x".repeat(200);
        let title = resolve(&fm(&[]), &long);
        assert_eq!(title.chars().count(), TITLE_FALLBACK_MAX_CHARS);
        let long_heading = format!("# {}", "y".repeat(200));
        let title = resolve(&fm(&[]), &long_heading);
        assert_eq!(title.chars().count(), TITLE_FALLBACK_MAX_CHARS);
    }

    #[test]
    fn truncation_respects_char_boundaries() {
        assert_eq!(truncate_chars("äöü", 2), "äö");
        assert_eq!(truncate_chars("abc", 10), "abc");
        assert_eq!(truncate_chars("abc", 0), "");
    }

    #[test]
    fn crlf_body_lines() {
        assert_eq!(first_heading("# Heading\r\n"), Some("Heading"));
        assert_eq!(first_non_empty_line("\r\n  hi \r\n"), Some("hi"));
    }
}

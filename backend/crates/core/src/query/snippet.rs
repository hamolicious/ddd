use serde::{Deserialize, Serialize};

pub const SNIPPET_MAX_CHARS: usize = 180;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snippet {
    pub text: String,
    pub ranges: Vec<Range>,
    pub line: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub start: usize,
    pub end: usize,
}

pub fn snippet_for(content: &str, terms: &[String]) -> Option<Snippet> {
    let needles: Vec<Vec<char>> = terms
        .iter()
        .map(|term| fold(term.trim()))
        .filter(|needle| !needle.is_empty())
        .collect();

    let lines: Vec<&str> = content.split('\n').collect();
    let holds_term = |line: &&str| {
        let folded = fold(line);
        line.trim() != ""
            && needles
                .iter()
                .any(|needle| find(&folded, needle, 0).is_some())
    };
    let at = lines
        .iter()
        .position(|line| !needles.is_empty() && holds_term(line))
        .or_else(|| lines.iter().position(|line| line.trim() != ""))?;

    let trimmed = lines[at].trim();
    let text = if trimmed.chars().count() > SNIPPET_MAX_CHARS {
        let mut cut: String = trimmed.chars().take(SNIPPET_MAX_CHARS - 1).collect();
        cut.push('…');
        cut
    } else {
        trimmed.to_string()
    };
    let ranges = locate(&text, &needles);
    Some(Snippet {
        text,
        ranges,
        line: at + 1,
    })
}

fn fold(text: &str) -> Vec<char> {
    text.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

fn find(haystack: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&at| haystack[at..at + needle.len()] == *needle)
}

fn locate(text: &str, needles: &[Vec<char>]) -> Vec<Range> {
    let chars: Vec<char> = text.chars().collect();
    let folded = fold(text);
    let mut utf16 = Vec::with_capacity(chars.len() + 1);
    let mut offset = 0;
    for c in &chars {
        utf16.push(offset);
        offset += c.len_utf16();
    }
    utf16.push(offset);

    let mut found: Vec<(usize, usize)> = Vec::new();
    for needle in needles {
        let mut from = 0;
        while let Some(at) = find(&folded, needle, from) {
            found.push((at, at + needle.len()));
            from = at + needle.len();
        }
    }
    found.sort_unstable();

    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in found {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
        .into_iter()
        .map(|(start, end)| Range {
            start: utf16[start],
            end: utf16[end],
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(list: &[&str]) -> Vec<String> {
        list.iter().map(|term| (*term).to_string()).collect()
    }

    #[test]
    fn the_first_line_holding_a_term_is_chosen() {
        let snippet =
            snippet_for("# Shopping\n\n  Buy Milk and milk  \n", &terms(&["milk"])).unwrap();
        assert_eq!(snippet.text, "Buy Milk and milk");
        assert_eq!(snippet.line, 3);
        assert_eq!(
            snippet.ranges,
            [Range { start: 4, end: 8 }, Range { start: 13, end: 17 }]
        );
    }

    #[test]
    fn without_a_match_the_first_line_is_shown_plain() {
        let snippet = snippet_for("\nfirst\nsecond", &terms(&["zebra"])).unwrap();
        assert_eq!((snippet.text.as_str(), snippet.line), ("first", 2));
        assert!(snippet.ranges.is_empty());
        assert_eq!(snippet_for("", &terms(&["a"])), None);
    }

    #[test]
    fn overlapping_occurrences_merge() {
        let snippet = snippet_for("milkshake", &terms(&["milk", "lksh"])).unwrap();
        assert_eq!(snippet.ranges, [Range { start: 0, end: 6 }]);
    }

    #[test]
    fn offsets_are_utf16() {
        let snippet = snippet_for("🥛 milk", &terms(&["milk"])).unwrap();
        assert_eq!(snippet.ranges, [Range { start: 3, end: 7 }]);
    }

    #[test]
    fn long_lines_are_cut() {
        let line = "x".repeat(400);
        let snippet = snippet_for(&line, &[]).unwrap();
        assert_eq!(snippet.text.chars().count(), SNIPPET_MAX_CHARS);
        assert!(snippet.text.ends_with('…'));
    }
}

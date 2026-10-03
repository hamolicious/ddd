use serde::Serialize;

use crate::date::Date;
use crate::value::{Map, Value};

pub const MAX_FM_DEPTH: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    Link,
    Embed,
    Frontmatter,
}

impl LinkKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkKind::Link => "link",
            LinkKind::Embed => "embed",
            LinkKind::Frontmatter => "frontmatter",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Reference {
    pub target: String,
    pub kind: LinkKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Open,
    Done,
    Other,
}

impl TaskState {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskState::Open => "open",
            TaskState::Done => "done",
            TaskState::Other => "other",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Task {
    pub line: u32,
    pub state: TaskState,
    pub marker: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttachmentRef {
    pub attachment: String,
    pub line: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FmKind {
    String,
    Number,
    Boolean,
    Date,
    Null,
}

impl FmKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FmKind::String => "string",
            FmKind::Number => "number",
            FmKind::Boolean => "boolean",
            FmKind::Date => "date",
            FmKind::Null => "null",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FmEntry {
    pub key: String,
    pub value: Value,
    pub kind: FmKind,
    pub position: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct BodyFacts {
    pub words: u32,
    pub characters: u32,
    pub tasks: Vec<Task>,
    pub references: Vec<Reference>,
    pub attachments: Vec<AttachmentRef>,
}

pub fn extract_body(id: &str, fm: &Map, body: &str, first_line: u32) -> BodyFacts {
    let mut references = References::new(id);
    for (key, value) in flatten_paths(fm) {
        let items: &[Value] = match value {
            Value::List(items) => items,
            other => std::slice::from_ref(other),
        };
        for item in items {
            if let Value::Str(text) = item {
                references.add(text.trim(), LinkKind::Frontmatter, Some(&key));
            }
        }
    }
    let mut facts = scan_body(body, first_line, &mut references);
    facts.references = references.list;
    facts
}

pub fn flatten_paths(fm: &Map) -> Vec<(String, &Value)> {
    fn walk<'a>(map: &'a Map, prefix: &str, depth: usize, out: &mut Vec<(String, &'a Value)>) {
        for (key, value) in map {
            let path = join(prefix, key);
            out.push((path.clone(), value));
            if let Value::Map(inner) = value
                && depth < MAX_FM_DEPTH
            {
                walk(inner, &path, depth + 1, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(fm, "", 1, &mut out);
    out
}

pub fn fm_entries(fm: &Map) -> Vec<FmEntry> {
    fn scalar(out: &mut Vec<FmEntry>, key: &str, value: &Value, position: Option<u32>) {
        let kind = match value {
            Value::Null => FmKind::Null,
            Value::Bool(_) => FmKind::Boolean,
            Value::Int(_) | Value::Float(_) => FmKind::Number,
            Value::Str(text) if Date::looks_like_date(text) && Date::parse(text).is_ok() => {
                FmKind::Date
            }
            Value::Str(_) => FmKind::String,
            Value::List(_) | Value::Map(_) => return,
        };
        out.push(FmEntry {
            key: key.to_string(),
            value: value.clone(),
            kind,
            position,
        });
    }
    fn walk(out: &mut Vec<FmEntry>, key: &str, value: &Value, depth: usize, position: Option<u32>) {
        match value {
            Value::Map(map) => {
                if depth >= MAX_FM_DEPTH {
                    return;
                }
                for (child, inner) in map {
                    walk(out, &join(key, child), inner, depth + 1, position);
                }
            }
            Value::List(items) => {
                for (index, item) in items.iter().enumerate() {
                    let at = position.or(Some(index as u32));
                    match item {
                        Value::List(_) => {}
                        other => walk(out, key, other, depth, at),
                    }
                }
            }
            other => scalar(out, key, other, position),
        }
    }
    let mut out = Vec::new();
    for (key, value) in fm {
        walk(&mut out, key, value, 1, None);
    }
    out
}

fn join(prefix: &str, key: &str) -> String {
    if prefix.is_empty() {
        key.to_string()
    } else {
        format!("{prefix}.{key}")
    }
}

pub fn doc_id_of(destination: &str) -> Option<&str> {
    let rest = destination.strip_prefix("doc:")?;
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let id = &rest[..end];
    (!id.is_empty()).then_some(id)
}

struct References<'a> {
    own: &'a str,
    list: Vec<Reference>,
}

impl<'a> References<'a> {
    fn new(own: &'a str) -> References<'a> {
        References {
            own,
            list: Vec::new(),
        }
    }

    fn add(&mut self, destination: &str, kind: LinkKind, key: Option<&str>) {
        let Some(target) = doc_id_of(destination) else {
            return;
        };
        if target == self.own {
            return;
        }
        if let Some(existing) = self
            .list
            .iter_mut()
            .find(|r| r.target == target && r.kind == kind && r.key.as_deref() == key)
        {
            existing.count += 1;
            return;
        }
        self.list.push(Reference {
            target: target.to_string(),
            kind,
            key: key.map(str::to_string),
            count: 1,
        });
    }
}

fn scan_body(body: &str, first_line: u32, references: &mut References<'_>) -> BodyFacts {
    let mut facts = BodyFacts {
        characters: body.trim().encode_utf16().count() as u32,
        ..BodyFacts::default()
    };
    let mut fence: Option<(char, usize)> = None;

    for (index, line) in body.split('\n').enumerate() {
        let line_number = first_line + index as u32;
        facts.words += count_words(&strip_destinations(line));

        let opener = fence_opener(line);
        if let Some((fence_char, fence_len)) = fence {
            if let Some((c, len)) = opener
                && c == fence_char
                && len >= fence_len
                && line.trim().chars().all(|ch| ch == c)
            {
                fence = None;
            }
            continue;
        }
        if opener.is_some() {
            fence = opener;
            continue;
        }

        if let Some((marker, text)) = task_of(line) {
            let state = match marker {
                ' ' => TaskState::Open,
                'x' | 'X' => TaskState::Done,
                _ => TaskState::Other,
            };
            facts.tasks.push(Task {
                line: line_number,
                state,
                marker: marker.to_string(),
                text: text.trim().to_string(),
            });
        }

        let prose = strip_inline_code(line);
        for (embed, destination) in inline_links(&prose) {
            references.add(
                destination,
                if embed {
                    LinkKind::Embed
                } else {
                    LinkKind::Link
                },
                None,
            );
        }
        for destination in autolinks(&prose) {
            references.add(destination, LinkKind::Link, None);
        }
        if let Some(destination) = reference_definition(&prose) {
            references.add(destination, LinkKind::Link, None);
        }
        for attachment in attachments(&prose) {
            if !facts
                .attachments
                .iter()
                .any(|a| a.attachment == attachment && a.line == line_number)
            {
                facts.attachments.push(AttachmentRef {
                    attachment: attachment.to_string(),
                    line: line_number,
                });
            }
        }
    }
    facts
}

fn fence_opener(line: &str) -> Option<(char, usize)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let c = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let len = rest.chars().take_while(|ch| *ch == c).count();
    (len >= 3).then_some((c, len))
}

fn task_of(line: &str) -> Option<(char, &str)> {
    let rest = line.trim_start();
    let rest = if let Some(after) = rest.strip_prefix(['-', '*', '+']) {
        after
    } else {
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 || digits > 9 {
            return None;
        }
        rest[digits..].strip_prefix(['.', ')'])?
    };
    let trimmed = rest.trim_start();
    if trimmed.len() == rest.len() {
        return None;
    }
    let mut chars = trimmed.strip_prefix('[')?.chars();
    let marker = chars.next().filter(|c| *c != '\n')?;
    let after = chars.as_str().strip_prefix(']')?;
    Some((marker, after))
}

fn strip_inline_code(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    let mut copied = 0;
    while i < bytes.len() {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let run = bytes[i..].iter().take_while(|b| **b == b'`').count();
        let mut matched = None;
        for n in (1..=run).rev() {
            let closing = "`".repeat(n);
            if let Some(found) = line[i + n..].find(&closing) {
                matched = Some(i + n + found + n);
                break;
            }
        }
        match matched {
            Some(end) => {
                out.push_str(&line[copied..i]);
                copied = end;
                i = end;
            }
            None => i += 1,
        }
    }
    out.push_str(&line[copied..]);
    out
}

fn doc_destination(text: &str, stop_at_paren: bool) -> Option<&str> {
    if !text.starts_with("doc:") {
        return None;
    }
    let end = text
        .find(|c: char| c.is_whitespace() || c == '>' || (stop_at_paren && c == ')'))
        .unwrap_or(text.len());
    Some(&text[..end])
}

fn inline_links(prose: &str) -> Vec<(bool, &str)> {
    let mut found = Vec::new();
    let mut i = 0;
    while i < prose.len() {
        match inline_link_at(prose, i) {
            Some((end, embed, destination)) => {
                found.push((embed, destination));
                i = end;
            }
            None => i += prose[i..].chars().next().map_or(1, char::len_utf8),
        }
    }
    found
}

fn inline_link_at(prose: &str, start: usize) -> Option<(usize, bool, &str)> {
    let bytes = prose.as_bytes();
    let embed = bytes[start] == b'!';
    let mut j = start + usize::from(embed);
    if bytes.get(j) != Some(&b'[') {
        return None;
    }
    j += 1;
    loop {
        match bytes.get(j)? {
            b']' => break,
            b'[' => {
                let close = prose[j + 1..].find(']')?;
                j += 1 + close + 1;
            }
            _ => j += 1,
        }
    }
    j += 1;
    if bytes.get(j) != Some(&b'(') {
        return None;
    }
    j += 1;
    let rest = prose[j..].trim_start();
    let skipped = prose.len() - j - rest.len();
    let rest = rest.strip_prefix('<').unwrap_or(rest);
    let lead = prose.len() - j - skipped - rest.len();
    let destination = doc_destination(rest, true)?;
    Some((j + skipped + lead + destination.len(), embed, destination))
}

fn autolinks(prose: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(offset) = prose[from..].find("<doc:") {
        let start = from + offset + 1;
        let rest = &prose[start..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(rest.len());
        if rest[end..].starts_with('>') {
            found.push(&rest[..end]);
            from = start + end + 1;
        } else {
            from = start;
        }
    }
    found
}

fn reference_definition(prose: &str) -> Option<&str> {
    let indent = prose.len() - prose.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = prose[indent..].strip_prefix('[')?;
    let close = rest.find(']')?;
    if close == 0 {
        return None;
    }
    let rest = rest[close + 1..].strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('<').unwrap_or(rest);
    doc_destination(rest, false)
}

fn attachments(prose: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(offset) = prose[from..].find("attachment:") {
        let start = from + offset + "attachment:".len();
        from = start;
        let rest = prose[start..].strip_prefix("//").unwrap_or(&prose[start..]);
        let ascii_alnum = rest.bytes().take_while(u8::is_ascii_alphanumeric).count();
        if ascii_alnum < 26 {
            continue;
        }
        let after = rest[26..].chars().next();
        if after.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-') {
            continue;
        }
        found.push(&rest[..26]);
    }
    found
}

fn strip_destinations(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < line.len() {
        let rest = &line[i..];
        if rest.starts_with("](")
            && let Some(close) = rest[2..].find(')')
        {
            out.push(' ');
            i += 2 + close + 1;
            continue;
        }
        if rest.starts_with('<')
            && let Some(len) = scheme_autolink_len(rest)
        {
            out.push(' ');
            i += len;
            continue;
        }
        let c = rest.chars().next().unwrap_or(' ');
        out.push(c);
        i += c.len_utf8();
    }
    out
}

fn scheme_autolink_len(rest: &str) -> Option<usize> {
    let body = &rest[1..];
    let mut chars = body.char_indices();
    let (_, first) = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let colon = body
        .char_indices()
        .skip(1)
        .find(|(_, c)| !(c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')))?;
    if colon.1 != ':' {
        return None;
    }
    let after = &body[colon.0 + 1..];
    let end = after
        .find(|c: char| c.is_whitespace() || c == '>')
        .unwrap_or(after.len());
    after[end..]
        .starts_with('>')
        .then_some(1 + colon.0 + 1 + end + 1)
}

fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric()
}

fn count_words(text: &str) -> u32 {
    let chars: Vec<char> = text.chars().collect();
    let mut count = 0;
    let mut i = 0;
    while i < chars.len() {
        if !is_word_char(chars[i]) {
            i += 1;
            continue;
        }
        count += 1;
        while i < chars.len() && is_word_char(chars[i]) {
            i += 1;
        }
        while i + 1 < chars.len()
            && matches!(chars[i], '\'' | '’' | '-')
            && is_word_char(chars[i + 1])
        {
            i += 1;
            while i < chars.len() && is_word_char(chars[i]) {
                i += 1;
            }
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs(id: &str, body: &str) -> Vec<(String, &'static str, u32)> {
        extract_body(id, &Map::new(), body, 1)
            .references
            .into_iter()
            .map(|r| (r.target, r.kind.as_str(), r.count))
            .collect()
    }

    #[test]
    fn reads_links_embeds_autolinks_and_definitions() {
        let body = [
            "See [the list](doc://A) and [again](doc:A#part).",
            "![](doc://B)",
            "<doc://C>",
            "[ref]: doc://D",
            "[nested [brackets]](doc://E \"title\")",
        ]
        .join("\n");
        assert_eq!(
            refs("X", &body),
            vec![
                ("A".into(), "link", 2),
                ("B".into(), "embed", 1),
                ("C".into(), "link", 1),
                ("D".into(), "link", 1),
                ("E".into(), "link", 1),
            ]
        );
    }

    #[test]
    fn skips_inline_code_fences_and_self_references() {
        let body = "`[inline](doc://A)` and [self](doc://X)\n```md\n[fenced](doc://B)\n```\n[real](doc://C)";
        assert_eq!(refs("X", body), vec![("C".into(), "link", 1)]);
    }

    #[test]
    fn reads_frontmatter_references_by_key() {
        let mut project = Map::new();
        project.insert("lead".into(), Value::Str("doc://S".into()));
        let mut fm = Map::new();
        fm.insert("parent".into(), Value::Str("doc://P".into()));
        fm.insert(
            "related".into(),
            Value::List(vec![
                Value::Str("doc://Q".into()),
                Value::Str("plain".into()),
                Value::Str("doc:R".into()),
            ]),
        );
        fm.insert("project".into(), Value::Map(project));
        let found: Vec<_> = extract_body("X", &fm, "", 1)
            .references
            .into_iter()
            .map(|r| (r.target, r.key.unwrap_or_default()))
            .collect();
        assert_eq!(
            found,
            vec![
                ("P".into(), "parent".into()),
                ("S".into(), "project.lead".into()),
                ("Q".into(), "related".into()),
                ("R".into(), "related".into()),
            ]
        );
    }

    #[test]
    fn reads_tasks_with_lines_outside_code() {
        let body = [
            "- [ ] a",
            "* [x] b",
            "1. [X] c",
            "- [/] d",
            "```",
            "- [ ] no",
            "```",
            "not [ ] a task",
        ]
        .join("\n");
        let tasks = extract_body("X", &Map::new(), &body, 4).tasks;
        let summary: Vec<_> = tasks
            .iter()
            .map(|t| (t.line, t.state.as_str(), t.text.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                (4, "open", "a"),
                (5, "done", "b"),
                (6, "done", "c"),
                (7, "other", "d")
            ]
        );
        assert_eq!(tasks[3].marker, "/");
    }

    #[test]
    fn counts_words_and_attachments() {
        let f1 = "01J0000000000000000000000A";
        let f2 = "01J0000000000000000000000B";
        let body = format!(
            "one two  three\n![a](attachment://{f1}) [b](attachment:{f2}) ![c](attachment://{f1}) ![d](attachment://waiting-1a2b3c4d)\n"
        );
        let facts = extract_body("X", &Map::new(), &body, 1);
        assert_eq!(facts.words, 7);
        let found: Vec<_> = facts
            .attachments
            .iter()
            .map(|a| (a.attachment.as_str(), a.line))
            .collect();
        assert_eq!(found, vec![(f1, 2), (f2, 2)]);
    }

    #[test]
    fn counts_joined_words_once() {
        assert_eq!(count_words("don't re-use rock’n’roll -x- ünïcode 42"), 6);
    }

    #[test]
    fn characters_count_utf16_units_of_the_trimmed_body() {
        assert_eq!(extract_body("X", &Map::new(), "  a😀 \n", 1).characters, 3);
    }

    #[test]
    fn flattens_frontmatter_into_scalar_entries() {
        let mut inner = Map::new();
        inner.insert("lead".into(), Value::Str("Ann".into()));
        let mut fm = Map::new();
        fm.insert("due".into(), Value::Str("2026-10-03".into()));
        fm.insert("done".into(), Value::Bool(false));
        fm.insert("n".into(), Value::Int(3));
        fm.insert("none".into(), Value::Null);
        fm.insert("project".into(), Value::Map(inner));
        fm.insert(
            "tags".into(),
            Value::List(vec![Value::Str("a".into()), Value::Str("b".into())]),
        );
        let entries: Vec<_> = fm_entries(&fm)
            .into_iter()
            .map(|e| (e.key, e.kind.as_str(), e.position))
            .collect();
        assert_eq!(
            entries,
            vec![
                ("done".into(), "boolean", None),
                ("due".into(), "date", None),
                ("n".into(), "number", None),
                ("none".into(), "null", None),
                ("project.lead".into(), "string", None),
                ("tags".into(), "string", Some(0)),
                ("tags".into(), "string", Some(1)),
            ]
        );
    }

    #[test]
    fn frontmatter_depth_is_capped() {
        let mut map = Map::new();
        map.insert("leaf".into(), Value::Int(1));
        for level in (0..6).rev() {
            let mut outer = Map::new();
            outer.insert(format!("k{level}"), Value::Map(map));
            map = outer;
        }
        assert!(fm_entries(&map).is_empty());
    }

    #[test]
    fn doc_ids_come_from_doc_destinations_only() {
        assert_eq!(doc_id_of("doc://A/b?c#d"), Some("A"));
        assert_eq!(doc_id_of("doc:B"), Some("B"));
        assert_eq!(doc_id_of("doc://"), None);
        assert_eq!(doc_id_of("https://example.invalid"), None);
    }
}

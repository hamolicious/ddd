//! Minimal text splices (SPEC §3.3). The only supported way to write a
//! frontmatter value or a machine-section key: compute the smallest text edit,
//! never a parse→re-serialize→replace of a whole block.
//!
//! This module computes edits only. Applying them to the CRDT is the caller's
//! job (server: the per-document actor; client: the kernel splice helper).
//!
//! Every returned list is disjoint and sorted by `range.start` descending, so a
//! caller can apply the edits in order without re-offsetting.

use serde::{Deserialize, Serialize};

use crate::document::Span;
use crate::error::CoreError;
use crate::limits::{MAX_DOCUMENT_BYTES, is_valid_key};
use crate::value::{Value, parse_value};
use crate::{frontmatter, sections, yaml};

/// One replace-range-with-text edit against the document text.
/// Offsets are UTF-8 byte offsets into the text the edit was computed from;
/// edits in a list are disjoint and sorted by `range.start` descending so they
/// can be applied in order without re-offsetting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextEdit {
    pub range: Span,
    pub text: String,
}

/// Set (or insert) a top-level frontmatter key, touching only that key's value
/// span. Creates the block, or the key line, when absent.
///
/// A key that cannot be written at all (it does not match
/// `^[A-Za-z0-9_-]{1,64}$`, so the parser would drop it again) is
/// [`CoreError::SpliceTargetMissing`].
pub fn set_frontmatter_value(
    text: &str,
    key: &str,
    value: &Value,
) -> Result<Vec<TextEdit>, CoreError> {
    guard(text)?;
    require_key(key)?;
    let serialized = value.to_yaml_inline();

    if frontmatter::find_block(text).is_none() {
        let mut block = format!("---\n{key}: {serialized}\n---\n");
        if !text.is_empty() && !text.starts_with('\n') {
            block.push('\n');
        }
        return Ok(vec![TextEdit {
            range: Span::new(0, 0),
            text: block,
        }]);
    }

    if let Some(span) = frontmatter::value_span(text, key) {
        // `key:` with no same-line value starts its span right after the colon.
        // This covers both an empty value and an expanded sequence; keep the
        // canonical single space when replacing either one.
        let needs_space = text[..span.start].ends_with(':');
        let replacement = if needs_space {
            format!(" {serialized}")
        } else {
            serialized
        };
        return Ok(vec![TextEdit {
            range: span,
            text: replacement,
        }]);
    }

    let at = frontmatter::insert_point(text).unwrap_or(0);
    Ok(vec![TextEdit {
        range: Span::new(at, at),
        text: format!("{key}: {serialized}\n"),
    }])
}

/// Remove a top-level frontmatter key line. No-op (empty edit list) when absent.
/// A duplicated key is removed in full, every occurrence.
pub fn remove_frontmatter_key(text: &str, key: &str) -> Result<Vec<TextEdit>, CoreError> {
    guard(text)?;
    let mut edits: Vec<TextEdit> = frontmatter::line_spans(text, key)
        .into_iter()
        .map(|range| TextEdit {
            range,
            text: String::new(),
        })
        .collect();
    sort_edits(&mut edits);
    Ok(edits)
}

/// One key write inside a `%%%` section. `None` value removes the key's line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SectionLineEdit {
    pub key: String,
    pub value: Option<Value>,
}

/// Apply line edits to `plugin_id`'s machine section, creating the section (and
/// the trailing run) when it does not exist yet. Only that plugin's section is
/// ever touched.
///
/// Writes target the **last** section carrying `plugin_id` and the last line
/// carrying each key, matching last-occurrence-wins; earlier duplicate lines for
/// a written key are removed in the same splice ("the next write cleans up",
/// SPEC §3.3). When `edits` names the same key twice, the last entry wins.
pub fn splice_section(
    text: &str,
    plugin_id: &str,
    edits: &[SectionLineEdit],
) -> Result<Vec<TextEdit>, CoreError> {
    guard(text)?;
    require_key(plugin_id)?;
    for edit in edits {
        require_key(&edit.key)?;
    }

    // Deduplicate by key, last entry wins, insertion order preserved.
    let mut ordered: Vec<&SectionLineEdit> = Vec::new();
    for edit in edits {
        match ordered.iter().position(|kept| kept.key == edit.key) {
            Some(index) => ordered[index] = edit,
            None => ordered.push(edit),
        }
    }

    let parsed = sections::parse(text);
    let Some(section) = parsed.get(plugin_id) else {
        let body: String = ordered
            .iter()
            .filter_map(|edit| {
                edit.value
                    .as_ref()
                    .map(|value| format!("{}: {}\n", edit.key, value.to_yaml_inline()))
            })
            .collect();
        return Ok(vec![new_section(text, &parsed, plugin_id, &body)]);
    };

    let mut out: Vec<TextEdit> = Vec::new();
    let mut appended = String::new();
    for edit in ordered {
        let mut spans = sections::key_line_spans(text, section, &edit.key);
        let last = spans.pop();
        // Earlier duplicates of a key we are writing always go away.
        for range in spans {
            out.push(TextEdit {
                range,
                text: String::new(),
            });
        }
        match (last, &edit.value) {
            (Some(range), Some(value)) => out.push(TextEdit {
                range,
                text: format!("{}: {}\n", edit.key, value.to_yaml_inline()),
            }),
            (Some(range), None) => out.push(TextEdit {
                range,
                text: String::new(),
            }),
            (None, Some(value)) => {
                appended.push_str(&format!("{}: {}\n", edit.key, value.to_yaml_inline()));
            }
            (None, None) => {}
        }
    }
    if !appended.is_empty() {
        let at = sections::insert_point(section);
        out.push(TextEdit {
            range: Span::new(at, at),
            text: appended,
        });
    }
    sort_edits(&mut out);
    Ok(out)
}

/// One change to a list value (frontmatter key or section key).
///
/// Lists are written as **block sequences**, one `  - item` line per item, so each
/// action is a line insert or a line delete. Two replicas pushing at once insert two
/// separate lines; two removing the same item delete the same span. The text CRDT
/// merges both, where a rewritten `[a, b]` line would lose one side.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ListAction {
    /// Append an item.
    Push { value: Value },
    /// Insert before the item at `index`; past the end appends.
    Insert { index: usize, value: Value },
    /// Delete every item equal to `value`. A missing item is not an error.
    Remove { value: Value },
    /// Delete the last item.
    Pop,
}

/// The edits a [`ListAction`] makes, and the item [`ListAction::Pop`] took off.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ListEdit {
    pub edits: Vec<TextEdit>,
    pub popped: Option<Value>,
}

/// Apply a [`ListAction`] to a top-level frontmatter key.
///
/// A key already in block form is edited one item line at a time. A key holding a
/// flow list or a scalar is first rewritten into block form (a one-time whole-value
/// replace — the only step that does not merge line by line). A missing key is
/// created by push/insert; remove/pop on it are no-ops.
pub fn frontmatter_list(text: &str, key: &str, action: &ListAction) -> Result<ListEdit, CoreError> {
    guard(text)?;
    require_key(key)?;
    require_item(action)?;

    let Some((_, inner)) = frontmatter::find_block(text) else {
        let Some(item) = created_item(action) else {
            return Ok(ListEdit::default());
        };
        let mut block = format!(
            "---\n{key}:\n{DEFAULT_INDENT}- {}\n---\n",
            item.to_yaml_inline()
        );
        if !text.is_empty() && !text.starts_with('\n') {
            block.push('\n');
        }
        return Ok(ListEdit {
            edits: vec![TextEdit {
                range: Span::new(0, 0),
                text: block,
            }],
            popped: None,
        });
    };

    Ok(region_list(text, inner, key, action))
}

/// Apply a [`ListAction`] to a key in `plugin_id`'s `%%%` section, creating the
/// section when push/insert needs one. Same rules as [`frontmatter_list`].
pub fn section_list(
    text: &str,
    plugin_id: &str,
    key: &str,
    action: &ListAction,
) -> Result<ListEdit, CoreError> {
    guard(text)?;
    require_key(plugin_id)?;
    require_key(key)?;
    require_item(action)?;

    let parsed = sections::parse(text);
    let Some(section) = parsed.get(plugin_id) else {
        let Some(item) = created_item(action) else {
            return Ok(ListEdit::default());
        };
        let body = format!("{key}:\n{}", item_line(DEFAULT_INDENT, item));
        return Ok(ListEdit {
            edits: vec![new_section(text, &parsed, plugin_id, &body)],
            popped: None,
        });
    };

    Ok(region_list(text, section.body_span, key, action))
}

/// Indentation for items of a list that has none yet.
const DEFAULT_INDENT: &str = "  ";

/// The item a push/insert would create a missing list with.
fn created_item(action: &ListAction) -> Option<&Value> {
    match action {
        ListAction::Push { value } | ListAction::Insert { value, .. } => Some(value),
        ListAction::Remove { .. } | ListAction::Pop => None,
    }
}

/// Items are scalars: a nested item could not be written as one line.
fn require_item(action: &ListAction) -> Result<(), CoreError> {
    match action {
        ListAction::Push { value }
        | ListAction::Insert { value, .. }
        | ListAction::Remove { value } => match value {
            Value::List(_) | Value::Map(_) => Err(CoreError::SpliceTargetMissing(
                "list items must be scalars".to_string(),
            )),
            _ => Ok(()),
        },
        ListAction::Pop => Ok(()),
    }
}

/// One occurrence of the key inside a region: its header line, and its item lines
/// when it is already in block form.
struct Occurrence {
    /// Absolute span of the header line plus every item line.
    span: Span,
    /// Absolute span of the header line alone.
    header: Span,
    /// `Some` when the header has nothing after the colon (`key:`).
    block: Option<Vec<Item>>,
    /// The inline value, when the header carries one.
    inline: Option<Value>,
}

/// One block-sequence item. Every item line has a terminator: a region (the
/// frontmatter's inner span, a section's body) always ends before its closing fence.
struct Item {
    /// Absolute span of the whole line, terminator included.
    line: Span,
    indent: String,
    value: Option<Value>,
}

fn occurrences(text: &str, region: Span, key: &str) -> Vec<Occurrence> {
    let body = region.slice(text);
    let lines = yaml::lines(body);
    let at = |offset: usize| region.start + offset;
    let mut out = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if yaml::line_key(line.content).as_deref() != Some(key) {
            continue;
        }
        let header = Span::new(at(line.start), at(line.full_end));
        if yaml::empty_value_key(line.content).is_some() {
            let mut items = Vec::new();
            let mut end = line.full_end;
            if let Some(first) = lines.get(index + 1)
                && let Some((indent, _)) = yaml::block_item(first.content)
            {
                for item in &lines[index + 1..] {
                    let Some((item_indent, raw)) = yaml::block_item(item.content) else {
                        break;
                    };
                    if item_indent != indent {
                        break;
                    }
                    items.push(Item {
                        line: Span::new(at(item.start), at(item.full_end)),
                        indent: item.content[..indent].to_string(),
                        value: parse_value(raw, 2).ok(),
                    });
                    end = item.full_end;
                }
            }
            out.push(Occurrence {
                span: Span::new(at(line.start), at(end)),
                header,
                block: Some(items),
                inline: None,
            });
        } else {
            let inline = match yaml::parse_line(line.content) {
                yaml::LineOutcome::Pair { value, .. } => Some(value),
                _ => None,
            };
            out.push(Occurrence {
                span: header,
                header,
                block: None,
                inline,
            });
        }
    }
    out
}

/// The values a non-block occurrence holds, as list items.
fn inline_items(value: Option<&Value>) -> Vec<Value> {
    match value {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::List(items)) => items.clone(),
        Some(other) => vec![other.clone()],
    }
}

fn item_line(indent: &str, value: &Value) -> String {
    format!("{indent}- {}\n", value.to_yaml_inline())
}

/// `action` against the last occurrence of `key` inside `region` (frontmatter
/// inner span or section body span).
///
/// Earlier occurrences (two replicas each creating the list at once) are folded
/// into the last one: their lines go, and their items that the last one lacks are
/// appended. That is "the next write cleans up" (SPEC §3.3) without losing an item.
fn region_list(text: &str, region: Span, key: &str, action: &ListAction) -> ListEdit {
    let mut found = occurrences(text, region, key);
    let Some(last) = found.pop() else {
        let Some(item) = created_item(action) else {
            return ListEdit::default();
        };
        return ListEdit {
            edits: vec![TextEdit {
                range: Span::new(region.end, region.end),
                text: format!("{key}:\n{}", item_line(DEFAULT_INDENT, item)),
            }],
            popped: None,
        };
    };

    let mut edits: Vec<TextEdit> = Vec::new();
    let mut folded: Vec<Value> = Vec::new();
    for earlier in &found {
        edits.push(TextEdit {
            range: earlier.span,
            text: String::new(),
        });
        let values: Vec<Value> = match &earlier.block {
            Some(items) => items.iter().filter_map(|item| item.value.clone()).collect(),
            None => inline_items(earlier.inline.as_ref()),
        };
        folded.extend(values);
    }

    let popped = match &last.block {
        Some(items) => block_list(&mut edits, &last, items, folded, action),
        None => rewrite_list(&mut edits, key, &last, folded, action),
    };
    sort_edits(&mut edits);
    ListEdit { edits, popped }
}

/// A list already in block form: line inserts and deletes only.
fn block_list(
    edits: &mut Vec<TextEdit>,
    last: &Occurrence,
    items: &[Item],
    folded: Vec<Value>,
    action: &ListAction,
) -> Option<Value> {
    let indent = items
        .first()
        .map_or(DEFAULT_INDENT.to_string(), |item| item.indent.clone());
    // Where appended lines go: after the last item, or after the header.
    let tail = items.last().map_or(last.header.end, |item| item.line.end);

    let present: Vec<&Value> = items
        .iter()
        .filter_map(|item| item.value.as_ref())
        .collect();
    let mut appended: Vec<Value> = Vec::new();
    for value in folded {
        if !present.contains(&&value) && !appended.contains(&value) {
            appended.push(value);
        }
    }

    let mut popped = None;
    match action {
        ListAction::Push { value } => appended.push(value.clone()),
        ListAction::Insert { index, value } => match items.get(*index) {
            Some(item) => edits.push(TextEdit {
                range: Span::new(item.line.start, item.line.start),
                text: item_line(&indent, value),
            }),
            None => appended.push(value.clone()),
        },
        ListAction::Remove { value } => {
            for item in items {
                if item.value.as_ref() == Some(value) {
                    edits.push(TextEdit {
                        range: item.line,
                        text: String::new(),
                    });
                }
            }
        }
        ListAction::Pop => {
            if let Some(item) = items.last() {
                popped = item.value.clone();
                edits.push(TextEdit {
                    range: item.line,
                    text: String::new(),
                });
            }
        }
    }

    if !appended.is_empty() {
        // After the last item's line — which a pop or remove may be deleting: the
        // insert sits at that deletion's end, so the two edits stay disjoint.
        edits.push(TextEdit {
            range: Span::new(tail, tail),
            text: appended
                .iter()
                .map(|value| item_line(&indent, value))
                .collect(),
        });
    }
    popped
}

/// A key holding an inline value (flow list or scalar): rewrite it into block form
/// with the action already applied. No change → no edit.
fn rewrite_list(
    edits: &mut Vec<TextEdit>,
    key: &str,
    last: &Occurrence,
    folded: Vec<Value>,
    action: &ListAction,
) -> Option<Value> {
    let before = inline_items(last.inline.as_ref());
    let mut items = before.clone();
    for value in folded {
        if !items.contains(&value) {
            items.push(value);
        }
    }
    let mut popped = None;
    match action {
        ListAction::Push { value } => items.push(value.clone()),
        ListAction::Insert { index, value } => {
            items.insert((*index).min(items.len()), value.clone())
        }
        ListAction::Remove { value } => items.retain(|item| item != value),
        ListAction::Pop => popped = items.pop(),
    }
    if items == before && edits.is_empty() {
        return popped;
    }
    let mut block = format!("{key}:\n");
    for item in &items {
        block.push_str(&item_line(DEFAULT_INDENT, item));
    }
    edits.push(TextEdit {
        range: last.header,
        text: block,
    });
    popped
}

/// The edit that adds a new `%%% plugin_id` section holding `body` to the end of
/// the trailing run, creating the run when the document has none.
fn new_section(text: &str, parsed: &sections::Sections, plugin_id: &str, body: &str) -> TextEdit {
    let fenced = format!("%%% {plugin_id}\n{body}%%%\n");
    match parsed.run_span {
        Some(run) => TextEdit {
            range: Span::new(run.end, run.end),
            text: fenced,
        },
        None => {
            let mut separator = String::new();
            if !text.is_empty() {
                if !text.ends_with('\n') {
                    separator.push_str("\n\n");
                } else if !text.ends_with("\n\n") {
                    separator.push('\n');
                }
            }
            TextEdit {
                range: Span::new(text.len(), text.len()),
                text: format!("{separator}{fenced}"),
            }
        }
    }
}

/// Remove a plugin's whole `%%%` section (uninstall-with-purge path). Every
/// section carrying the id goes. No-op when the plugin has none.
pub fn remove_section(text: &str, plugin_id: &str) -> Result<Vec<TextEdit>, CoreError> {
    guard(text)?;
    let parsed = sections::parse(text);
    let mut edits: Vec<TextEdit> = parsed
        .sections
        .iter()
        .filter(|section| section.plugin_id == plugin_id)
        .map(|section| TextEdit {
            range: section.span,
            text: String::new(),
        })
        .collect();
    sort_edits(&mut edits);
    Ok(edits)
}

/// Apply edits to a string. Reference implementation used by tests and by the
/// REST full-text paths; CRDT callers apply the same edits transactionally.
///
/// Defensive: the edits are re-sorted (descending, longest range first at an
/// equal start) and clamped to the text, so a caller cannot corrupt the text by
/// passing them in another order.
pub fn apply(text: &str, edits: &[TextEdit]) -> String {
    let mut ordered: Vec<&TextEdit> = edits.iter().collect();
    ordered.sort_by(|a, b| {
        b.range
            .start
            .cmp(&a.range.start)
            .then(b.range.end.cmp(&a.range.end))
    });
    let mut out = text.to_string();
    for edit in ordered {
        let start = clamp_boundary(&out, edit.range.start);
        let end = clamp_boundary(&out, edit.range.end.max(edit.range.start));
        out.replace_range(start..end, &edit.text);
    }
    out
}

fn clamp_boundary(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

fn sort_edits(edits: &mut [TextEdit]) {
    edits.sort_by(|a, b| {
        b.range
            .start
            .cmp(&a.range.start)
            .then(b.range.end.cmp(&a.range.end))
    });
}

fn guard(text: &str) -> Result<(), CoreError> {
    if text.len() > MAX_DOCUMENT_BYTES {
        return Err(CoreError::DocumentTooLarge {
            len: text.len(),
            limit: MAX_DOCUMENT_BYTES,
        });
    }
    Ok(())
}

fn require_key(key: &str) -> Result<(), CoreError> {
    if is_valid_key(key) {
        Ok(())
    } else {
        Err(CoreError::SpliceTargetMissing(key.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::parse_document;

    fn spliced(text: &str, edits: Vec<TextEdit>) -> String {
        apply(text, &edits)
    }

    #[test]
    fn replaces_only_the_value_span() {
        let text = "---\ntitle: Old\npath: home\n---\n\nbody\n";
        let edits = set_frontmatter_value(text, "title", &Value::Str("New".into())).unwrap();
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0].range.slice(text), "Old");
        assert_eq!(
            spliced(text, edits),
            "---\ntitle: New\npath: home\n---\n\nbody\n"
        );
    }

    #[test]
    fn inserts_a_missing_key_before_the_closing_fence() {
        let text = "---\ntitle: A\n---\nbody\n";
        let edits = set_frontmatter_value(text, "path", &Value::Str("home/lists".into())).unwrap();
        assert_eq!(
            spliced(text, edits),
            "---\ntitle: A\npath: home/lists\n---\nbody\n"
        );
    }

    #[test]
    fn fills_an_empty_value() {
        let text = "---\npath:\n---\n";
        let edits = set_frontmatter_value(text, "path", &Value::Str("home".into())).unwrap();
        assert_eq!(spliced(text, edits), "---\npath: home\n---\n");
    }

    #[test]
    fn creates_a_block_when_there_is_none() {
        assert_eq!(
            spliced(
                "body\n",
                set_frontmatter_value("body\n", "title", &Value::Str("A".into())).unwrap()
            ),
            "---\ntitle: A\n---\n\nbody\n"
        );
        assert_eq!(
            spliced(
                "",
                set_frontmatter_value("", "title", &Value::Str("A".into())).unwrap()
            ),
            "---\ntitle: A\n---\n"
        );
    }

    #[test]
    fn removes_every_occurrence_of_a_key() {
        let text = "---\na: 1\nb: 2\na: 3\n---\n";
        let edits = remove_frontmatter_key(text, "a").unwrap();
        assert_eq!(edits.len(), 2);
        assert_eq!(spliced(text, edits), "---\nb: 2\n---\n");
        assert!(remove_frontmatter_key(text, "zz").unwrap().is_empty());
    }

    #[test]
    fn section_line_splices_touch_only_changed_keys() {
        let text = "body\n\n%%% calendar\na: 1\nb: 2\n%%%\n";
        let edits = splice_section(
            text,
            "calendar",
            &[
                SectionLineEdit {
                    key: "b".into(),
                    value: Some(Value::Int(9)),
                },
                SectionLineEdit {
                    key: "c".into(),
                    value: Some(Value::Str("new".into())),
                },
                SectionLineEdit {
                    key: "a".into(),
                    value: None,
                },
            ],
        )
        .unwrap();
        assert_eq!(
            spliced(text, edits),
            "body\n\n%%% calendar\nb: 9\nc: new\n%%%\n"
        );
    }

    #[test]
    fn creates_the_section_and_the_run() {
        let text = "# Note\n";
        let edits = splice_section(
            text,
            "calendar",
            &[SectionLineEdit {
                key: "uid".into(),
                value: Some(Value::Str("abc".into())),
            }],
        )
        .unwrap();
        assert_eq!(
            spliced(text, edits),
            "# Note\n\n%%% calendar\nuid: abc\n%%%\n"
        );

        let no_newline = "# Note";
        let edits = splice_section(
            no_newline,
            "calendar",
            &[SectionLineEdit {
                key: "uid".into(),
                value: Some(Value::Str("abc".into())),
            }],
        )
        .unwrap();
        assert_eq!(
            spliced(no_newline, edits),
            "# Note\n\n%%% calendar\nuid: abc\n%%%\n"
        );
    }

    #[test]
    fn appends_a_second_section_to_the_existing_run() {
        let text = "body\n\n%%% a\nx: 1\n%%%\n";
        let edits = splice_section(
            text,
            "b",
            &[SectionLineEdit {
                key: "y".into(),
                value: Some(Value::Int(2)),
            }],
        )
        .unwrap();
        let out = spliced(text, edits);
        assert_eq!(out, "body\n\n%%% a\nx: 1\n%%%\n%%% b\ny: 2\n%%%\n");
        let parsed = parse_document(&out);
        assert_eq!(parsed.sections.len(), 2);
    }

    #[test]
    fn duplicate_key_lines_are_cleaned_up_by_the_next_write() {
        let text = "%%% a\nk: 1\nk: 2\n%%%\n";
        let edits = splice_section(
            text,
            "a",
            &[SectionLineEdit {
                key: "k".into(),
                value: Some(Value::Int(3)),
            }],
        )
        .unwrap();
        assert_eq!(spliced(text, edits), "%%% a\nk: 3\n%%%\n");
    }

    #[test]
    fn removing_a_section_removes_all_of_its_copies() {
        let text = "body\n\n%%% a\nx: 1\n%%%\n%%% b\ny: 2\n%%%\n%%% a\nz: 3\n%%%\n";
        let edits = remove_section(text, "a").unwrap();
        assert_eq!(edits.len(), 2);
        assert_eq!(spliced(text, edits), "body\n\n%%% b\ny: 2\n%%%\n");
        assert!(remove_section(text, "nope").unwrap().is_empty());
    }

    #[test]
    fn invalid_keys_are_rejected() {
        assert!(matches!(
            set_frontmatter_value("", "not a key", &Value::Null),
            Err(CoreError::SpliceTargetMissing(_))
        ));
        assert!(matches!(
            splice_section("", "bad id", &[]),
            Err(CoreError::SpliceTargetMissing(_))
        ));
    }

    #[test]
    fn oversized_text_is_refused() {
        let big = "x".repeat(MAX_DOCUMENT_BYTES + 1);
        assert!(matches!(
            set_frontmatter_value(&big, "a", &Value::Null),
            Err(CoreError::DocumentTooLarge { .. })
        ));
    }

    #[test]
    fn splices_round_trip_through_the_parser() {
        let text = "---\ntitle: A\n---\n\nbody\n";
        let edits = set_frontmatter_value(text, "date", &Value::Str("2026-09-23".into())).unwrap();
        let out = spliced(text, edits);
        let parsed = parse_document(&out);
        assert_eq!(
            parsed.fm.get("date"),
            Some(&Value::Str("2026-09-23".into()))
        );
        assert!(!parsed.fm_parse_error);
    }
}

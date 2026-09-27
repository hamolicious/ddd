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
use crate::value::Value;
use crate::{frontmatter, sections};

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
        let fenced = format!("%%% {plugin_id}\n{body}%%%\n");
        return Ok(match parsed.run_span {
            Some(run) => vec![TextEdit {
                range: Span::new(run.end, run.end),
                text: fenced,
            }],
            None => {
                let mut separator = String::new();
                if !text.is_empty() {
                    if !text.ends_with('\n') {
                        separator.push_str("\n\n");
                    } else if !text.ends_with("\n\n") {
                        separator.push('\n');
                    }
                }
                vec![TextEdit {
                    range: Span::new(text.len(), text.len()),
                    text: format!("{separator}{fenced}"),
                }]
            }
        });
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

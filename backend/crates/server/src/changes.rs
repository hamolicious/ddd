//! Change history: what each write did to a document's **text**, kept so it can be
//! read back and reverted (`docs/HISTORY.md`).
//!
//! The update log (`document_updates`) is a sync buffer: binary Yjs updates, trimmed to
//! a few hundred entries, and not invertible once compaction has dropped deleted content.
//! So every write that changes the text also records its effect as **hunks** — at byte
//! `pos` of the text before, `removed` was replaced by `inserted` — in
//! `document_changes`, and a full-text **checkpoint** is written every
//! `CHECKPOINT_EVERY_CHANGES` changes.
//!
//! Everything here is pure. What is built on it:
//!
//! - **Text at a point** ([`replay`]): the nearest checkpoint, then the changes after it,
//!   forward. Every step checks the text holds what the change says it removed, so a gap
//!   in the history is refused rather than guessed at.
//! - **Revert** ([`revert_edits`]): the text just before and just after a group, diffed by
//!   lines, each hunk carried forward through the later changes. A later change that
//!   touched a hunk's text is a [`Conflict`]: the revert is refused, and the caller says
//!   which change was in the way.
//! - **Groups** ([`group`]): consecutive changes by one author, split where the author
//!   changes or they paused for longer than [`GROUP_GAP_MS`].

use similar::{DiffOp, TextDiff};

use life_manager_core::splice::TextEdit;
use life_manager_core::Span;

/// A pause this long, or another author, starts a new group.
pub const GROUP_GAP_MS: i64 = 2 * 60 * 1000;

/// One contiguous replacement, against the text **before** the change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    /// Byte offset into the text before.
    pub pos: usize,
    pub removed: String,
    pub inserted: String,
}

/// What one write did: its hunks in ascending, non-overlapping order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub seq: i64,
    pub at_ms: i64,
    pub by: Option<String>,
    pub hunks: Vec<Hunk>,
}

/// The single hunk between two texts: common prefix and suffix trimmed. Exact for the
/// one-place edits typing produces; a whole-text replace comes out as one wide hunk.
pub fn diff_hunk(old: &str, new: &str) -> Option<Hunk> {
    if old == new {
        return None;
    }
    let mut prefix = old
        .as_bytes()
        .iter()
        .zip(new.as_bytes())
        .take_while(|(a, b)| a == b)
        .count();
    while !old.is_char_boundary(prefix) || !new.is_char_boundary(prefix) {
        prefix -= 1;
    }
    let (old_rest, new_rest) = (&old[prefix..], &new[prefix..]);
    let mut suffix = old_rest
        .as_bytes()
        .iter()
        .rev()
        .zip(new_rest.as_bytes().iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    while !old_rest.is_char_boundary(old_rest.len() - suffix)
        || !new_rest.is_char_boundary(new_rest.len() - suffix)
    {
        suffix -= 1;
    }
    Some(Hunk {
        pos: prefix,
        removed: old_rest[..old_rest.len() - suffix].to_string(),
        inserted: new_rest[..new_rest.len() - suffix].to_string(),
    })
}

/// Every separate place `old` and `new` differ, each trimmed to the characters that
/// changed. The common start and end go first, so the line diff only ever runs over the
/// part that changed: for typing, a few characters.
pub fn hunks_between(old: &str, new: &str) -> Vec<Hunk> {
    let Some(outer) = diff_hunk(old, new) else {
        return Vec::new();
    };
    // Widen the changed middle to whole lines (the text around it is common to both), so
    // the line diff compares complete lines on both sides.
    let start = old[..outer.pos].rfind('\n').map_or(0, |index| index + 1);
    let old_end = outer.pos + outer.removed.len();
    let suffix = old.len() - old_end;
    let tail = old[old_end..].find('\n').map_or(suffix, |index| index + 1);
    let old_region = &old[start..old_end + tail];
    let new_region = &new[start..new.len() - suffix + tail];
    line_hunks(old_region, new_region)
        .into_iter()
        .filter_map(|piece| {
            diff_hunk(&piece.removed, &piece.inserted).map(|trimmed| Hunk {
                pos: start + piece.pos + trimmed.pos,
                removed: trimmed.removed,
                inserted: trimmed.inserted,
            })
        })
        .collect()
}

/// Hunks from a splice's edits (byte spans against `old`, any order).
pub fn hunks_from_edits(old: &str, edits: &[TextEdit]) -> Vec<Hunk> {
    let mut hunks: Vec<Hunk> = edits
        .iter()
        .filter(|edit| edit.range.start <= edit.range.end && edit.range.end <= old.len())
        .map(|edit| Hunk {
            pos: edit.range.start,
            removed: old[edit.range.start..edit.range.end].to_string(),
            inserted: edit.text.clone(),
        })
        .filter(|hunk| hunk.removed != hunk.inserted)
        .collect();
    hunks.sort_by_key(|hunk| hunk.pos);
    hunks
}

/// Why history could not be rewound: the text does not hold what a change inserted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gap {
    pub seq: i64,
}

/// The text before `change`, given the text after it.
pub fn invert(after: &str, change: &Change) -> Result<String, Gap> {
    // Where each hunk sits in the text *after*: its `pos` shifted by every earlier hunk.
    let mut shift: isize = 0;
    let mut placed = Vec::with_capacity(change.hunks.len());
    for hunk in &change.hunks {
        let at = hunk.pos as isize + shift;
        if at < 0 {
            return Err(Gap { seq: change.seq });
        }
        placed.push((at as usize, hunk));
        shift += hunk.inserted.len() as isize - hunk.removed.len() as isize;
    }
    let mut text = after.to_string();
    for (at, hunk) in placed.into_iter().rev() {
        let end = at + hunk.inserted.len();
        if end > text.len()
            || !text.is_char_boundary(at)
            || !text.is_char_boundary(end)
            || text[at..end] != hunk.inserted
        {
            return Err(Gap { seq: change.seq });
        }
        text.replace_range(at..end, &hunk.removed);
    }
    Ok(text)
}

/// The text after `change`, given the text before it. Each hunk must find what it
/// says it removed; anything else is a [`Gap`].
pub fn apply_forward(before: &str, change: &Change) -> Result<String, Gap> {
    let mut text = before.to_string();
    for hunk in change.hunks.iter().rev() {
        let end = hunk.pos + hunk.removed.len();
        if end > text.len()
            || !text.is_char_boundary(hunk.pos)
            || !text.is_char_boundary(end)
            || text[hunk.pos..end] != hunk.removed
        {
            return Err(Gap { seq: change.seq });
        }
        text.replace_range(hunk.pos..end, &hunk.inserted);
    }
    Ok(text)
}

/// Replay `changes` (ascending by seq) forward from `text`.
pub fn replay(text: &str, changes: &[Change]) -> Result<String, Gap> {
    changes.iter().try_fold(text.to_string(), |text, change| apply_forward(&text, change))
}

/// Rewind `current` through `changes` (ascending by seq), newest first.
pub fn rewind(current: &str, changes: &[Change]) -> Result<String, Gap> {
    changes
        .iter()
        .rev()
        .try_fold(current.to_string(), |text, change| invert(&text, change))
}

/// A group: consecutive changes by one author with no long pause between them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub from_seq: i64,
    pub to_seq: i64,
    pub started_ms: i64,
    pub ended_ms: i64,
    pub by: Option<String>,
    pub changes: usize,
    pub inserted_chars: usize,
    pub removed_chars: usize,
}

/// Group changes given **newest first**; groups come back newest first too.
pub fn group(newest_first: &[Change], gap_ms: i64) -> Vec<Group> {
    let mut groups: Vec<Group> = Vec::new();
    for change in newest_first {
        let inserted: usize = change.hunks.iter().map(|hunk| hunk.inserted.chars().count()).sum();
        let removed: usize = change.hunks.iter().map(|hunk| hunk.removed.chars().count()).sum();
        match groups.last_mut() {
            Some(open) if open.by == change.by && open.started_ms - change.at_ms <= gap_ms => {
                open.from_seq = change.seq;
                open.started_ms = change.at_ms;
                open.changes += 1;
                open.inserted_chars += inserted;
                open.removed_chars += removed;
            }
            _ => groups.push(Group {
                from_seq: change.seq,
                to_seq: change.seq,
                started_ms: change.at_ms,
                ended_ms: change.at_ms,
                by: change.by.clone(),
                changes: 1,
                inserted_chars: inserted,
                removed_chars: removed,
            }),
        }
    }
    groups
}

/// The net difference `before` → `after` as line-aligned hunks (against `before`).
pub fn line_hunks(before: &str, after: &str) -> Vec<Hunk> {
    let diff = TextDiff::from_lines(before, after);
    let old: Vec<&str> = diff.iter_old_slices().collect();
    let new: Vec<&str> = diff.iter_new_slices().collect();
    let offset = |slices: &[&str], index: usize| -> usize { slices[..index].iter().map(|s| s.len()).sum() };

    let mut hunks: Vec<Hunk> = Vec::new();
    for op in diff.ops() {
        let (old_range, new_range) = match *op {
            DiffOp::Equal { .. } => continue,
            DiffOp::Delete { old_index, old_len, new_index } => (old_index..old_index + old_len, new_index..new_index),
            DiffOp::Insert { old_index, new_index, new_len } => (old_index..old_index, new_index..new_index + new_len),
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                (old_index..old_index + old_len, new_index..new_index + new_len)
            }
        };
        let hunk = Hunk {
            pos: offset(&old, old_range.start),
            removed: old[old_range].concat(),
            inserted: new[new_range].concat(),
        };
        // Adjacent ops (a delete right before an insert) are one hunk to a person.
        match hunks.last_mut() {
            Some(last) if last.pos + last.removed.len() == hunk.pos => {
                last.removed.push_str(&hunk.removed);
                last.inserted.push_str(&hunk.inserted);
            }
            _ => hunks.push(hunk),
        }
    }
    hunks
}

/// A later change touched text a revert needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub seq: i64,
    pub by: Option<String>,
    pub at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevertError {
    /// History cannot be rewound to this group (a write it does not know about).
    Gap(Gap),
    /// A later change overlaps the group's text.
    Conflict(Conflict),
    /// The group changed nothing that is still there to undo.
    Nothing,
}

/// The edits (byte spans against `current`) that undo a group of changes while keeping
/// everything after it. `before` and `after` are the text just before and just after the
/// group (rebuilt from a checkpoint); `later` is every change after it, ascending.
pub fn revert_edits(current: &str, before: &str, after: &str, later: &[Change]) -> Result<Vec<TextEdit>, RevertError> {
    let hunks = line_hunks(before, after);
    if hunks.is_empty() {
        return Err(RevertError::Nothing);
    }

    // Each hunk as a region of `after`: [start, end) holds what the group left there.
    let mut regions: Vec<(usize, usize, String)> = Vec::new();
    let mut shift: isize = 0;
    for hunk in &hunks {
        let start = (hunk.pos as isize + shift) as usize;
        regions.push((start, start + hunk.inserted.len(), hunk.removed.clone()));
        shift += hunk.inserted.len() as isize - hunk.removed.len() as isize;
    }

    // Carry every region forward through the later changes.
    for change in later {
        for region in regions.iter_mut() {
            let (start, end) = (region.0, region.1);
            let mut delta_before: isize = 0;
            for hunk in &change.hunks {
                let (h_start, h_end) = (hunk.pos, hunk.pos + hunk.removed.len());
                let touches = if start == end {
                    // Deleted text goes back here: only a removal spanning the spot is in the way.
                    h_start < start && h_end > start
                } else if h_start == h_end {
                    // An insertion strictly inside the region lands in its text.
                    h_start > start && h_start < end
                } else {
                    h_start < end && h_end > start
                };
                if touches {
                    return Err(RevertError::Conflict(Conflict {
                        seq: change.seq,
                        by: change.by.clone(),
                        at_ms: change.at_ms,
                    }));
                }
                if h_end <= start {
                    delta_before += hunk.inserted.len() as isize - hunk.removed.len() as isize;
                }
            }
            region.0 = (start as isize + delta_before) as usize;
            region.1 = (end as isize + delta_before) as usize;
        }
    }

    // Every region must still hold what the group left there; if not, the history the
    // regions were carried through was not the whole story.
    let last_seq = later.last().map_or(0, |change| change.seq);
    let mut edits = Vec::with_capacity(regions.len());
    for ((start, end, text), hunk) in regions.into_iter().zip(&hunks) {
        if end > current.len()
            || !current.is_char_boundary(start)
            || !current.is_char_boundary(end)
            || current[start..end] != hunk.inserted
        {
            return Err(RevertError::Gap(Gap { seq: last_seq }));
        }
        edits.push(TextEdit { range: Span { start, end }, text });
    }
    Ok(edits)
}

/// One hunk of a group's diff, with a little unchanged text on each side for reading.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShownHunk {
    pub before: String,
    pub removed: String,
    pub inserted: String,
    pub after: String,
}

/// Lines of context kept on each side of a shown hunk.
pub const CONTEXT_LINES: usize = 2;

/// `line_hunks(before, after)` with context lines from `before`.
pub fn shown_hunks(before: &str, after: &str) -> Vec<ShownHunk> {
    line_hunks(before, after)
        .into_iter()
        .map(|hunk| {
            let head = &before[..hunk.pos];
            let tail = &before[hunk.pos + hunk.removed.len()..];
            ShownHunk {
                before: last_lines(head, CONTEXT_LINES).to_string(),
                removed: hunk.removed,
                inserted: hunk.inserted,
                after: first_lines(tail, CONTEXT_LINES).to_string(),
            }
        })
        .collect()
}

fn last_lines(text: &str, count: usize) -> &str {
    let trimmed = text.strip_suffix('\n').unwrap_or(text);
    let mut start = trimmed.len();
    for _ in 0..count {
        match trimmed[..start].rfind('\n') {
            Some(index) => start = index,
            None => return text,
        }
    }
    &text[start + 1..]
}

fn first_lines(text: &str, count: usize) -> &str {
    let mut end = 0;
    for _ in 0..count {
        match text[end..].find('\n') {
            Some(index) => end += index + 1,
            None => return text,
        }
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(seq: i64, at_ms: i64, by: &str, before: &str, after: &str) -> Change {
        Change { seq, at_ms, by: Some(by.to_string()), hunks: diff_hunk(before, after).into_iter().collect() }
    }

    #[test]
    fn a_diff_hunk_is_the_middle_that_changed() {
        let hunk = diff_hunk("hello world", "hello brave world").unwrap();
        assert_eq!(hunk, Hunk { pos: 6, removed: String::new(), inserted: "brave ".to_string() });
        assert!(diff_hunk("same", "same").is_none());
        // Never splits a character.
        let hunk = diff_hunk("aé", "aè").unwrap();
        assert_eq!((hunk.removed.as_str(), hunk.inserted.as_str()), ("é", "è"));
    }

    #[test]
    fn separate_edits_are_separate_hunks() {
        let old = "- [ ] book train\n- [ ] pack\n\nNotes.\n";
        let new = "- [x] book train\n- [ ] pack\n- [ ] passport\n\nNotes.\n";
        let hunks = hunks_between(old, new);
        assert_eq!(
            hunks,
            vec![
                Hunk { pos: 3, removed: " ".into(), inserted: "x".into() },
                Hunk { pos: 28, removed: String::new(), inserted: "- [ ] passport\n".into() },
            ]
        );
        let change = Change { seq: 1, at_ms: 0, by: None, hunks };
        assert_eq!(invert(new, &change).unwrap(), old);
    }

    #[test]
    fn recorded_hunks_always_invert_exactly() {
        // A small deterministic generator: random edits, multi-byte characters included.
        let mut seed: u64 = 0x5eed;
        let mut next = move |bound: usize| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as usize) % bound.max(1)
        };
        let pieces = ["a", "é", "\n", "line\n", "- [ ] x\n", "🙂", " ", "zz"];
        let mut text = String::from("start\n");
        for round in 0..400 {
            let mut edited = text.clone();
            for _ in 0..1 + next(3) {
                let len = edited.chars().count();
                let at = next(len + 1);
                let cut = next(4).min(len - at);
                let byte = |n: usize| edited.char_indices().nth(n).map_or(edited.len(), |(i, _)| i);
                let (from, to) = (byte(at), byte(at + cut));
                let insert: String = (0..next(3)).map(|_| pieces[next(pieces.len())]).collect();
                edited.replace_range(from..to, &insert);
            }
            let change = Change { seq: round, at_ms: 0, by: None, hunks: hunks_between(&text, &edited) };
            assert_eq!(invert(&edited, &change).as_deref(), Ok(text.as_str()), "round {round}: {text:?} -> {edited:?}");
            text = edited;
        }
    }

    #[test]
    fn rewinding_undoes_changes_newest_first() {
        let texts = ["one\n", "one\ntwo\n", "zero\none\ntwo\n", "zero\nONE\ntwo\n"];
        let changes: Vec<Change> =
            (0..3).map(|i| change(i as i64 + 1, i as i64, "u", texts[i], texts[i + 1])).collect();
        assert_eq!(rewind(texts[3], &changes).unwrap(), texts[0]);
        assert_eq!(rewind(texts[3], &changes[2..]).unwrap(), texts[2]);
    }

    #[test]
    fn replaying_forward_matches_the_texts() {
        let texts = ["one\n", "one\ntwo\n", "zero\none\ntwo\n", "zero\nONE\ntwo\n"];
        let changes: Vec<Change> =
            (0..3).map(|i| change(i as i64 + 1, i as i64, "u", texts[i], texts[i + 1])).collect();
        assert_eq!(replay(texts[0], &changes).unwrap(), texts[3]);
        assert_eq!(replay(texts[1], &changes[1..2]).unwrap(), texts[2]);
        // Replaying onto the wrong text is a gap, not a guess: change 2 only inserts at
        // the start, so it is change 3 that finds "one" missing.
        assert_eq!(replay("other\n", &changes[1..]), Err(Gap { seq: 3 }));
    }

    #[test]
    fn a_gap_in_history_is_refused_not_guessed() {
        let recorded = change(1, 0, "u", "a\n", "a\nb\n");
        // Someone rewrote the text without a record: "b" is no longer where it was put.
        assert_eq!(rewind("a\nc\n", &[recorded]), Err(Gap { seq: 1 }));
    }

    #[test]
    fn multi_hunk_changes_invert() {
        let old = "alpha beta gamma";
        let edits = vec![
            TextEdit { range: Span { start: 11, end: 16 }, text: "GAMMA".into() },
            TextEdit { range: Span { start: 0, end: 5 }, text: "A".into() },
        ];
        let new = life_manager_core::splice::apply(old, &edits);
        let change = Change { seq: 1, at_ms: 0, by: None, hunks: hunks_from_edits(old, &edits) };
        assert_eq!(invert(&new, &change).unwrap(), old);
    }

    #[test]
    fn groups_split_on_author_and_pause() {
        let newest_first = vec![
            change(5, 10 * 60_000, "b", "x", "xy"),
            change(4, 9 * 60_000, "a", "x", "xy"),
            change(3, 8 * 60_000 + 30_000, "a", "x", "xy"),
            change(2, 60_000, "a", "x", "xy"),
            change(1, 0, "a", "x", "xy"),
        ];
        let groups = group(&newest_first, GROUP_GAP_MS);
        let spans: Vec<(i64, i64, usize)> = groups.iter().map(|g| (g.from_seq, g.to_seq, g.changes)).collect();
        assert_eq!(spans, vec![(5, 5, 1), (3, 4, 2), (1, 2, 2)]);
    }

    #[test]
    fn reverting_a_group_keeps_later_edits_elsewhere() {
        let t0 = "title\n\npara one\n\npara two\n";
        let t1 = "title\n\npara one, edited\n\npara two\n"; // the group
        let t2 = "title\n\npara one, edited\n\npara two\n\npara three\n"; // later, elsewhere
        let later = vec![change(2, 1, "b", t1, t2)];
        let edits = revert_edits(t2, t0, t1, &later).unwrap();
        let reverted = life_manager_core::splice::apply(t2, &edits);
        assert_eq!(reverted, "title\n\npara one\n\npara two\n\npara three\n");
    }

    #[test]
    fn reverting_is_refused_when_a_later_change_touched_the_same_text() {
        let t0 = "a\nb\nc\n";
        let t1 = "a\nB\nc\n";
        let t2 = "a\nBB\nc\n"; // later, same line
        let err = revert_edits(t2, t0, t1, &[change(2, 5, "b", t1, t2)]).unwrap_err();
        assert_eq!(err, RevertError::Conflict(Conflict { seq: 2, by: Some("b".into()), at_ms: 5 }));
    }

    #[test]
    fn reverting_a_deletion_puts_the_text_back() {
        let t0 = "keep\ngone\nkeep too\n";
        let t1 = "keep\nkeep too\n";
        let t2 = "new first\nkeep\nkeep too\n";
        let edits = revert_edits(t2, t0, t1, &[change(2, 1, "b", t1, t2)]).unwrap();
        assert_eq!(life_manager_core::splice::apply(t2, &edits), "new first\nkeep\ngone\nkeep too\n");
    }

    #[test]
    fn shown_hunks_carry_context() {
        let before = "1\n2\n3\n4\n5\n6\n";
        let after = "1\n2\n3\nfour\n5\n6\n";
        let shown = shown_hunks(before, after);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].before, "2\n3\n");
        assert_eq!(shown[0].removed, "4\n");
        assert_eq!(shown[0].inserted, "four\n");
        assert_eq!(shown[0].after, "5\n6\n");
    }
}

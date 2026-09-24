//! Reconciliation: what the feed says, minus what the workspace already holds.
//!
//! **A pure function over two lists**, and deliberately so. Reconciliation is where a sync
//! plugin either writes nothing on an unchanged feed or churns the CRDT history of every
//! connected client, and that is a decision worth asserting over fixtures rather than
//! discovering in production. Every host call stays in the plugin crate; this module
//! decides, that one obeys.
//!
//! # The four outcomes, and why each is what it is
//!
//! | Situation | Outcome | Why not the other thing |
//! |---|---|---|
//! | no document for this `UID` | [`Action::Create`] | — |
//! | the document's text differs from the rendered text | [`Action::Rewrite`] | it is machine-owned, so the feed is its author (SPEC §3.3) |
//! | the text is byte-identical | nothing at all | a no-op `rewrite_document` is still a CRDT transaction and a feed row on every client |
//! | the `UID` is gone from the feed | [`Action::Cancel`] — `status: cancelled` | there is no `delete_document` host function, and removing someone's meeting because a feed hiccuped is the wrong default even if there were (`backend/HOST-ABI.md` §8) |
//!
//! # Three refusals, each protecting something specific
//!
//! - **A user's delete is respected.** A tombstoned match is *not* re-created; its uid is
//!   reported in [`Plan::newly_suppressed`] so the plugin can remember it past the 30-day
//!   purge (SPEC §3.5), after which the row is gone and nothing would stop the next run
//!   from importing it again. Without this, trashing an imported event would look like the
//!   Trash being broken.
//! - **A document this plugin did not create is never touched.** `rewrite_document` would
//!   refuse it anyway (`forbidden`), but counting it as [`Plan::foreign`] says *why*
//!   nothing happened — a human wrote `source-uid` into their own note.
//! - **Cancellation is scoped to one feed.** Matching is by uid across everything, so two
//!   feeds carrying one event share a document instead of duplicating it; cancelling is
//!   restricted to documents whose section names *this* feed, so two feeds in one workspace
//!   cannot cancel each other's events.

use serde::Serialize;

use crate::render::document_text;
use crate::{Event, STATUS_CANCELLED};

/// One document the workspace already holds, as much of it as reconciliation needs.
///
/// Built by the plugin crate from a `query_documents` row; a plain struct here so the
/// decision table above is testable without a host.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Existing {
    pub id: String,
    /// `fm.source-uid` — the match key.
    pub source_uid: Option<String>,
    /// `plugins.calendar.feed`, the feed label this document belongs to.
    pub feed: Option<String>,
    /// The materialized text. `None` ⇒ it was read `metadata_only`, and every match is
    /// then treated as changed (the honest answer: nothing was compared).
    pub content: Option<String>,
    /// `plugins.calendar.status`.
    pub status: Option<String>,
    /// Tombstoned (in Trash).
    pub deleted: bool,
    /// `created_by == "plugin:calendar"` — the machine-ownership record (SPEC §3.3).
    pub owned: bool,
}

/// What [`plan`] is given.
#[derive(Debug, Clone, Copy)]
pub struct Inputs<'a> {
    /// The feed label from plugin config, recorded in every document's section.
    pub feed_id: &'a str,
    /// `fm.path` for this feed's documents ([`crate::render::folder_path`]).
    pub path: &'a str,
    /// The feed's events, as parsed.
    pub events: &'a [Event],
    /// The documents already in the workspace, trash included.
    pub existing: &'a [Existing],
    /// Uids a user has deleted, from the plugin's KV suppression list.
    pub suppressed: &'a [String],
}

/// One write to perform. Nothing here is executed; the plugin crate turns each into exactly
/// one host call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Action {
    /// `create_document(text)`.
    Create { uid: String, text: String },
    /// `rewrite_document(id, text)` — legal because the document is machine-owned.
    Rewrite {
        id: String,
        uid: String,
        text: String,
    },
    /// `splice_section(id, [status: cancelled])` — one line, not a rewrite.
    Cancel { id: String, uid: String },
}

impl Action {
    /// The document id this action writes to, when it already has one.
    pub fn id(&self) -> Option<&str> {
        match self {
            Action::Create { .. } => None,
            Action::Rewrite { id, .. } | Action::Cancel { id, .. } => Some(id),
        }
    }

    /// The feed uid this action is about.
    pub fn uid(&self) -> &str {
        match self {
            Action::Create { uid, .. }
            | Action::Rewrite { uid, .. }
            | Action::Cancel { uid, .. } => uid,
        }
    }
}

/// The reconciliation result: the writes, and an account of everything that produced none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Plan {
    /// In feed order, then the cancellations in document-id order — deterministic, so two
    /// runs over one state produce the same sequence of writes.
    pub actions: Vec<Action>,
    /// Events whose document is already byte-identical.
    pub unchanged: u32,
    /// Events skipped because a user deleted them.
    pub suppressed: u32,
    /// Events whose matching document belongs to a human, not to this plugin.
    pub foreign: u32,
    /// Extra documents sharing one uid. The first by id wins; the rest are left alone —
    /// deleting one is not this plugin's call, and rewriting both would fight forever.
    pub duplicates: u32,
    /// Uids that were found tombstoned in this run and should join the KV suppression list.
    pub newly_suppressed: Vec<String>,
}

impl Plan {
    pub fn created(&self) -> u32 {
        self.count(|action| matches!(action, Action::Create { .. }))
    }

    pub fn updated(&self) -> u32 {
        self.count(|action| matches!(action, Action::Rewrite { .. }))
    }

    pub fn cancelled(&self) -> u32 {
        self.count(|action| matches!(action, Action::Cancel { .. }))
    }

    fn count(&self, predicate: impl Fn(&Action) -> bool) -> u32 {
        self.actions
            .iter()
            .filter(|action| predicate(action))
            .count() as u32
    }
}

/// Diff a parsed feed against the workspace.
///
/// Total and order-independent: `existing` is indexed by uid in document-id order, so the
/// page order a query happened to return cannot change the outcome.
pub fn plan(inputs: Inputs<'_>) -> Plan {
    let mut plan = Plan::default();

    // Index by uid, lowest document id first. Two documents for one uid is a race or a
    // hand-copied note; picking the lowest id is stable across runs where "whatever the
    // query returned first" would flip.
    let mut ordered: Vec<&Existing> = inputs.existing.iter().collect();
    ordered.sort_by(|left, right| left.id.cmp(&right.id));

    let mut index: Vec<(&str, &Existing)> = Vec::with_capacity(ordered.len());
    for row in ordered {
        let Some(uid) = row.source_uid.as_deref() else {
            // No uid: nothing can match it and nothing can cancel it. Left alone rather
            // than guessed at.
            continue;
        };
        if index.iter().any(|(seen, _)| *seen == uid) {
            plan.duplicates += 1;
            continue;
        }
        index.push((uid, row));
    }

    let mut matched: Vec<&str> = Vec::with_capacity(inputs.events.len());

    for event in inputs.events {
        let uid = event.uid.as_str();
        let found = index
            .iter()
            .find(|(seen, _)| *seen == uid)
            .map(|(_, row)| *row);
        if found.is_some() {
            matched.push(uid);
        }

        if inputs.suppressed.iter().any(|seen| seen == uid) {
            plan.suppressed += 1;
            continue;
        }

        match found {
            None => plan.actions.push(Action::Create {
                uid: uid.to_string(),
                text: document_text(inputs.feed_id, inputs.path, event),
            }),
            Some(row) if row.deleted => {
                // The user trashed it. Remember the uid, because in 30 days the row purges
                // and there would be nothing left to recognise it by.
                plan.suppressed += 1;
                if !plan.newly_suppressed.iter().any(|seen| seen == uid) {
                    plan.newly_suppressed.push(uid.to_string());
                }
            }
            Some(row) if !row.owned => plan.foreign += 1,
            Some(row) => {
                let text = document_text(inputs.feed_id, inputs.path, event);
                if row.content.as_deref() == Some(text.as_str()) {
                    plan.unchanged += 1;
                } else {
                    plan.actions.push(Action::Rewrite {
                        id: row.id.clone(),
                        uid: uid.to_string(),
                        text,
                    });
                }
            }
        }
    }

    // Anything of this feed's that the feed no longer mentions.
    for (uid, row) in &index {
        if matched.iter().any(|seen| seen == uid)
            || row.deleted
            || !row.owned
            || row.feed.as_deref() != Some(inputs.feed_id)
            || row.status.as_deref() == Some(STATUS_CANCELLED)
        {
            continue;
        }
        plan.actions.push(Action::Cancel {
            id: row.id.clone(),
            uid: (*uid).to_string(),
        });
    }

    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &str = "work";
    const PATH: &str = "calendar/work";

    fn event(uid: &str, summary: &str) -> Event {
        Event {
            uid: uid.to_string(),
            summary: summary.to_string(),
            start: "2026-09-24T09:00:00Z".to_string(),
            end: None,
            all_day: false,
            location: None,
            description: None,
            sequence: 0,
            status: None,
            rrule: None,
            tzid: None,
        }
    }

    /// A document in exactly the state this plugin's own writer would have left it.
    fn synced(id: &str, event: &Event) -> Existing {
        Existing {
            id: id.to_string(),
            source_uid: Some(event.uid.clone()),
            feed: Some(FEED.to_string()),
            content: Some(document_text(FEED, PATH, event)),
            status: Some("confirmed".to_string()),
            deleted: false,
            owned: true,
        }
    }

    fn run(events: &[Event], existing: &[Existing], suppressed: &[String]) -> Plan {
        plan(Inputs {
            feed_id: FEED,
            path: PATH,
            events,
            existing,
            suppressed,
        })
    }

    #[test]
    fn an_empty_workspace_creates_every_event() {
        let events = [event("a@x", "A"), event("b@x", "B")];
        let plan = run(&events, &[], &[]);
        assert_eq!(plan.created(), 2);
        assert_eq!(plan.actions.len(), 2);
        // Feed order, so two runs write in the same order.
        assert_eq!(plan.actions[0].uid(), "a@x");
        assert_eq!(plan.actions[1].uid(), "b@x");
    }

    #[test]
    fn an_unchanged_feed_writes_nothing_at_all() {
        let events = [event("a@x", "A"), event("b@x", "B")];
        let existing = [synced("01A", &events[0]), synced("01B", &events[1])];
        let plan = run(&events, &existing, &[]);
        assert_eq!(plan.actions, Vec::new(), "an idempotent sync is a no-op");
        assert_eq!(plan.unchanged, 2);
    }

    #[test]
    fn a_changed_event_is_rewritten_once() {
        let before = event("a@x", "A");
        let existing = [synced("01A", &before)];
        let mut after = before.clone();
        after.summary = "A, moved".to_string();
        after.sequence = 1;

        let plan = run(&[after.clone()], &existing, &[]);
        assert_eq!(plan.updated(), 1);
        assert_eq!(
            plan.actions[0],
            Action::Rewrite {
                id: "01A".to_string(),
                uid: "a@x".to_string(),
                text: document_text(FEED, PATH, &after),
            }
        );
    }

    #[test]
    fn a_vanished_event_is_cancelled_never_deleted() {
        let gone = event("a@x", "A");
        let existing = [synced("01A", &gone)];
        let plan = run(&[], &existing, &[]);
        assert_eq!(
            plan.actions,
            vec![Action::Cancel {
                id: "01A".to_string(),
                uid: "a@x".to_string()
            }]
        );
        assert_eq!(plan.cancelled(), 1);
    }

    #[test]
    fn a_cancelled_document_is_not_cancelled_again() {
        let gone = event("a@x", "A");
        let mut existing = synced("01A", &gone);
        existing.status = Some(STATUS_CANCELLED.to_string());
        let plan = run(&[], &[existing], &[]);
        assert_eq!(
            plan.actions,
            Vec::new(),
            "cancelling twice is a pointless write"
        );
    }

    #[test]
    fn an_event_that_comes_back_is_rewritten_clean() {
        // A cancelled document's text carries `status: cancelled`; the rendered text does
        // not, so the comparison sees a difference and the rewrite restores it. No special
        // case, no "was it cancelled" flag — the text is the state.
        let back = event("a@x", "A");
        let mut existing = synced("01A", &back);
        existing.content = Some(
            existing
                .content
                .unwrap()
                .replace("status: confirmed", "status: cancelled"),
        );
        existing.status = Some(STATUS_CANCELLED.to_string());
        let plan = run(&[back], &[existing], &[]);
        assert_eq!(plan.updated(), 1);
        assert!(
            matches!(&plan.actions[0], Action::Rewrite { text, .. } if text.contains("status: confirmed"))
        );
    }

    #[test]
    fn a_trashed_event_is_not_resurrected_and_is_remembered() {
        let deleted_event = event("a@x", "A");
        let mut existing = synced("01A", &deleted_event);
        existing.deleted = true;
        let plan = run(&[deleted_event], &[existing], &[]);
        assert_eq!(plan.actions, Vec::new());
        assert_eq!(plan.suppressed, 1);
        assert_eq!(plan.newly_suppressed, vec!["a@x".to_string()]);
    }

    #[test]
    fn a_suppressed_uid_is_never_created_again_after_the_purge() {
        // The row is gone (purged), so only the KV list knows.
        let plan = run(&[event("a@x", "A")], &[], &["a@x".to_string()]);
        assert_eq!(plan.actions, Vec::new());
        assert_eq!(plan.suppressed, 1);
        assert!(plan.newly_suppressed.is_empty(), "already on the list");
    }

    #[test]
    fn a_humans_own_note_carrying_a_source_uid_is_left_alone() {
        let mine = event("a@x", "A");
        let theirs = Existing {
            id: "01H".to_string(),
            source_uid: Some("a@x".to_string()),
            feed: Some(FEED.to_string()),
            content: Some("---\ntitle: My own note\n---\n".to_string()),
            status: None,
            deleted: false,
            owned: false,
        };
        let plan = run(&[mine], &[theirs], &[]);
        assert_eq!(plan.actions, Vec::new(), "not ours to rewrite");
        assert_eq!(plan.foreign, 1);

        // And it is not cancelled when the event goes away either.
        let plan = run(&[], &[theirs_again()], &[]);
        assert_eq!(plan.actions, Vec::new());
    }

    fn theirs_again() -> Existing {
        Existing {
            id: "01H".to_string(),
            source_uid: Some("a@x".to_string()),
            feed: Some(FEED.to_string()),
            content: None,
            status: None,
            deleted: false,
            owned: false,
        }
    }

    #[test]
    fn another_feeds_documents_are_never_cancelled() {
        let mut other = synced("01A", &event("a@x", "A"));
        other.feed = Some("home".to_string());
        let plan = run(&[], &[other], &[]);
        assert_eq!(plan.actions, Vec::new(), "not this feed's event to cancel");
    }

    #[test]
    fn two_feeds_carrying_one_uid_share_the_document_instead_of_duplicating_it() {
        let shared = event("a@x", "A");
        // The document as the *other* feed's sync wrote it, section and all.
        let other = Existing {
            id: "01A".to_string(),
            source_uid: Some(shared.uid.clone()),
            feed: Some("home".to_string()),
            content: Some(document_text("home", "calendar/home", &shared)),
            status: Some("confirmed".to_string()),
            deleted: false,
            owned: true,
        };
        let plan = run(&[shared], &[other], &[]);
        // A rewrite (the section's `feed` changes), never a second document: a uid is
        // globally unique in RFC 5545, so this is one event seen twice.
        assert_eq!(plan.created(), 0);
        assert_eq!(plan.updated(), 1);
    }

    #[test]
    fn duplicate_documents_are_reported_and_the_lowest_id_wins() {
        let event = event("a@x", "A");
        let first = synced("01A", &event);
        let second = synced("01B", &event);
        // Given in the "wrong" order on purpose: the outcome may not depend on page order.
        let plan = run(&[event], &[second, first], &[]);
        assert_eq!(plan.duplicates, 1);
        assert_eq!(plan.unchanged, 1);
        assert_eq!(plan.actions, Vec::new());
    }

    #[test]
    fn a_metadata_only_read_treats_every_match_as_changed() {
        let event = event("a@x", "A");
        let mut existing = synced("01A", &event);
        existing.content = None;
        let plan = run(&[event], &[existing], &[]);
        assert_eq!(
            plan.updated(),
            1,
            "nothing was compared, so nothing is unchanged"
        );
    }

    #[test]
    fn a_document_without_a_uid_is_neither_matched_nor_cancelled() {
        let orphan = Existing {
            id: "01A".to_string(),
            source_uid: None,
            feed: Some(FEED.to_string()),
            content: None,
            status: None,
            deleted: false,
            owned: true,
        };
        let plan = run(&[event("a@x", "A")], &[orphan], &[]);
        assert_eq!(plan.created(), 1, "the event still imports");
        assert_eq!(plan.cancelled(), 0, "the orphan is left alone");
    }
}

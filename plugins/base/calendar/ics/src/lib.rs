//! iCalendar parsing, reduced to what a calendar view needs (SPEC §9 M4 proof).
//!
//! **Scope, deliberately small.** One `VEVENT` becomes one document, and a document's
//! date lives in `fm.date` — so this parser needs `UID`, `SUMMARY`, `DTSTART`, `DTEND`,
//! `LOCATION`, `DESCRIPTION`, `SEQUENCE`, `STATUS`, `RRULE` (carried, not expanded) and
//! nothing else. Timezone databases, recurrence expansion and attendee handling are not
//! in M4; the fields are preserved in the machine section so a later version can expand
//! them without re-fetching.
//!
//! **Everything here is pure and total.** A malformed line is skipped and recorded, never
//! a panic — the same per-line tolerance the shared core applies to frontmatter (SPEC
//! §3.4), for the same reason: one bad event must not cost the other three hundred.
//!
//! # Why the crate holds more than a parser
//!
//! A Wasm plugin crate cannot be unit-tested on the host target (it links the Extism host
//! imports), so **every pure decision the plugin makes lives here** and the plugin crate
//! beside it is glue (`backend/HOST-ABI.md` §9). That is three things, not one:
//!
//! | Module | What it decides |
//! |---|---|
//! | [`parse`](parse()) / [`normalize_datetime`] | what a feed says |
//! | [`render`] | the exact text of one event's document |
//! | [`plan`] | which documents to create, rewrite, cancel or leave alone |
//!
//! `plan` is the interesting one: reconciliation is where a sync plugin either writes
//! nothing on an unchanged feed or churns the CRDT history of every client, and that is a
//! decision worth asserting over fixtures rather than discovering in production.
//!
//! Owner: the **calendar** builder (`backend/CONTRACTS.md`).

#![forbid(unsafe_code)]

use serde::Serialize;

mod datetime;
mod parser;
pub mod plan;
pub mod render;
mod yaml;

pub use datetime::normalize_datetime;
pub use parser::{parse, unescape_text};
pub use plan::{Existing, Plan, plan};
pub use render::{document_text, folder_path};

/// The `%%%` section id this plugin owns, and the plugin id the host checks ownership
/// against. One constant, because the two are the same string by design (SPEC §3.3: one
/// fenced section per plugin id).
pub const SECTION: &str = "calendar";

/// Frontmatter keys of an imported event's document — **the portable half**.
///
/// These are ordinary human-readable frontmatter, deliberately: `date` is the field the
/// frontend half, `agenda`, `properties`' date picker and the filter DSL's date type
/// already understand (SPEC §3.4), and `source`/`source-uid` record where the event came
/// from in text that survives an export to plain markdown. The document is machine-*owned*
/// (SPEC §3.3), so this plugin authors the whole block — that is the one case where writing
/// frontmatter wholesale is correct.
///
/// Spelling note: hyphens, matching SPEC §3.3's own `source-uid` example and every fixture
/// in the repo. `is_valid_key` admits both, and one house style is worth more than a
/// preference.
pub mod fm_keys {
    /// `SUMMARY`.
    pub const TITLE: &str = "title";
    /// `DTSTART`, canonical ISO-8601 — the field every dated view queries.
    pub const DATE: &str = "date";
    /// `DTEND`, **inclusive** (see [`crate::Event::end`]). Absent for a point event.
    pub const DATE_END: &str = "date-end";
    /// The folder ([`crate::folder_path`]).
    pub const PATH: &str = "path";
    /// Always [`crate::SOURCE_ICAL`] — "this document was imported, not written".
    pub const SOURCE: &str = "source";
    /// `UID` from the feed. **The reconciliation match key** (`fm.source-uid`).
    pub const SOURCE_UID: &str = "source-uid";
    /// `LOCATION`, when the feed has one.
    pub const LOCATION: &str = "location";
}

/// `fm.source` for an event that came from an ICS feed.
pub const SOURCE_ICAL: &str = "ical";

/// Keys of the `%%% calendar` section — **this plugin's bookkeeping**, and nothing a human
/// needs. `FEED` is what keeps two feeds in one workspace from cancelling each other's
/// events, and `STATUS` is how a vanished event is marked without deleting anything.
///
/// The last-sync timestamp is deliberately **not** here: it would change on every run, and
/// high-frequency machine state belongs in plugin KV (SPEC §3.3), not in a CRDT's history.
pub mod keys {
    /// The feed label from plugin config.
    pub const FEED: &str = "feed";
    /// `true` for a date-precision (all-day) event.
    pub const ALL_DAY: &str = "all-day";
    /// `SEQUENCE`, the feed's own revision counter.
    pub const SEQUENCE: &str = "sequence";
    /// `confirmed` / `tentative` / `cancelled`.
    pub const STATUS: &str = "status";
    /// `TZID`, verbatim and uninterpreted (M4 ships no timezone database).
    pub const TZID: &str = "tzid";
    /// `RRULE`, verbatim and unexpanded.
    pub const RRULE: &str = "rrule";
}

/// `STATUS` for an event that has vanished from the feed. Not a deletion — there is no
/// `delete_document` host function, and removing a meeting because a feed hiccuped is the
/// wrong default even if there were (`backend/HOST-ABI.md` §8).
pub const STATUS_CANCELLED: &str = "cancelled";

/// The `STATUS` an event has when the feed does not say. RFC 5545's own default.
pub const STATUS_CONFIRMED: &str = "confirmed";

/// One parsed `VEVENT`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Event {
    /// `UID` — the stable identity across syncs. An event without one is dropped: there
    /// would be no way to update it next time without creating a duplicate.
    pub uid: String,
    pub summary: String,
    /// `DTSTART`, normalized to the canonical ISO-8601 form `fm.date` sorts by
    /// (SPEC §3.4). All-day events keep date precision (`2026-09-24`).
    pub start: String,
    /// `DTEND` (or `DTSTART` + `DURATION` when that is what the feed gave), converted to
    /// an **inclusive** end — RFC 5545's `DTEND` is exclusive, so a one-day all-day event
    /// arrives as `DTEND` the *next* day and would otherwise show as spanning two. `None`
    /// when the feed gave neither, or when the end adds nothing to the start.
    pub end: Option<String>,
    pub all_day: bool,
    pub location: Option<String>,
    pub description: Option<String>,
    /// `SEQUENCE`, the feed's own revision counter.
    pub sequence: i64,
    /// `STATUS`: `confirmed` / `tentative` / `cancelled`.
    pub status: Option<String>,
    /// `RRULE`, verbatim and unexpanded.
    pub rrule: Option<String>,
    /// `TZID` from `DTSTART`, verbatim.
    ///
    /// **Added to the scaffold's shape deliberately** (the plugin's README already
    /// promised it): M4 keeps a floating or zoned time's wall-clock value rather than
    /// inventing an offset, so the zone it was written in is the one piece of information
    /// a later version needs to refine `fm.date` without re-fetching the feed.
    pub tzid: Option<String>,
}

/// A line the parser could not use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    pub line: u32,
    pub message: String,
}

/// The result of parsing one feed.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Calendar {
    /// `X-WR-CALNAME`, when the feed names itself — a sensible folder name.
    pub name: Option<String>,
    pub events: Vec<Event>,
    pub problems: Vec<Problem>,
}

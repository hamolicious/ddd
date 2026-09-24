//! One event → one document's exact text.
//!
//! **Pure and deterministic, and that is load-bearing.** Reconciliation decides "unchanged"
//! by comparing this text against what the workspace already holds ([`crate::plan`]), so a
//! clock read, a hash-map iteration order or a random id anywhere in here would make every
//! sync rewrite every document — a CRDT transaction and a change-feed row per event per
//! run, on every connected client. Nothing in this module may observe anything but its
//! arguments.
//!
//! That is also why the last-sync timestamp is **not** in the text: it lives in plugin KV
//! (`feed.last_sync`), where high-frequency machine state belongs (SPEC §3.3).
//!
//! # The shape
//!
//! ```markdown
//! ---
//! title: Standup
//! date: 2026-09-24T09:00:00Z
//! date-end: 2026-09-24T09:15:00Z
//! path: calendar/work
//! source: ical
//! source-uid: 2f1c@google.com
//! ---
//!
//! # Standup
//!
//! Daily standup, 15 minutes.
//!
//! %%% calendar
//! feed: work
//! status: confirmed
//! sequence: 3
//! all-day: false
//! %%%
//! ```
//!
//! Two regions, two owners, one document (SPEC §3.3):
//!
//! - **Frontmatter is the portable, human-readable half.** `date` is what every other
//!   plugin already understands — the frontend half, `agenda`, `properties`' date picker,
//!   the filter DSL's date type — and `source`/`source-uid` say where the event came from
//!   in plain markdown that survives an export. The document is machine-*owned*, so this
//!   plugin authors the block wholesale; that is exactly the case SPEC §3.3 allows it in.
//! - **The `%%%` section is this plugin's bookkeeping**, and nothing a human needs. It is
//!   also the only region a *later* write touches: a vanished event is marked by splicing
//!   `status: cancelled` into it, which is a one-line edit rather than a rewrite.

use crate::yaml;
use crate::{Event, SECTION, SOURCE_ICAL, STATUS_CONFIRMED, fm_keys, keys};

/// How much description text one event's body may carry.
///
/// A document is capped at 1 MB (SPEC §3.5) and a feed can contain a 200 KB HTML
/// "description" pasted by a meeting tool. Truncating with a visible marker keeps the
/// event — its date, title and identity are the useful part — where letting the write fail
/// would drop it silently.
pub const MAX_BODY_BYTES: usize = 32 * 1024;

/// The marker a truncated body ends with.
pub const TRUNCATION_NOTE: &str = "…\n\n*(description truncated by the calendar plugin)*";

/// `fm.path` for a feed: the configured folder plus the feed's own name, normalized the way
/// `folders` normalizes a path (SPEC §6.5: `/` segments, `.`/`..`/empty stripped).
///
/// The feed name is treated as **one** segment — a feed called `Work / Ops` is a folder
/// called `Work - Ops`, not two nested ones. A feed does not get to invent a folder
/// hierarchy in someone's workspace.
pub fn folder_path(folder: &str, feed_name: &str) -> String {
    let mut segments: Vec<String> = Vec::new();
    for raw in folder.split('/') {
        push_segment(&mut segments, raw);
    }
    push_segment(&mut segments, &collapse(&feed_name.replace('/', "-")));
    if segments.is_empty() {
        segments.push("calendar".to_string());
    }
    segments.join("/")
}

fn push_segment(segments: &mut Vec<String>, raw: &str) {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return;
    }
    segments.push(trimmed.to_string());
}

/// The whole text of one event's document.
///
/// `feed_id` is the short label recorded in the machine section, so two feeds can share one
/// workspace without cancelling each other's events; `path` is `fm.path` (see
/// [`folder_path`]).
pub fn document_text(feed_id: &str, path: &str, event: &Event) -> String {
    let title = display_title(event);

    let mut front: Vec<String> = Vec::with_capacity(7);
    front.push(yaml::line(fm_keys::TITLE, &title));
    front.push(yaml::line(fm_keys::DATE, &event.start));
    if let Some(end) = event.end.as_deref() {
        front.push(yaml::line(fm_keys::DATE_END, end));
    }
    front.push(yaml::line(fm_keys::PATH, path));
    if let Some(location) = event.location.as_deref() {
        front.push(yaml::line(fm_keys::LOCATION, &collapse(location)));
    }
    front.push(yaml::line(fm_keys::SOURCE, SOURCE_ICAL));
    front.push(yaml::line(fm_keys::SOURCE_UID, &event.uid));

    // Fixed order, because the text is compared byte-for-byte to decide "unchanged", and
    // because `splice_section` replaces a key's line in place — so this order is also the
    // order a reader sees after a `status: cancelled` splice.
    let mut section: Vec<String> = Vec::with_capacity(6);
    section.push(yaml::line(keys::FEED, feed_id));
    section.push(yaml::line(
        keys::STATUS,
        event.status.as_deref().unwrap_or(STATUS_CONFIRMED),
    ));
    section.push(yaml::int_line(keys::SEQUENCE, event.sequence));
    section.push(yaml::bool_line(keys::ALL_DAY, event.all_day));
    if let Some(tzid) = event.tzid.as_deref() {
        section.push(yaml::line(keys::TZID, tzid));
    }
    if let Some(rrule) = event.rrule.as_deref() {
        section.push(yaml::line(keys::RRULE, rrule));
    }

    let mut text = String::with_capacity(512);
    text.push_str("---\n");
    for line in &front {
        text.push_str(line);
        text.push('\n');
    }
    text.push_str("---\n\n# ");
    text.push_str(&title);
    text.push('\n');
    if let Some(body) = body_text(event) {
        text.push('\n');
        text.push_str(&body);
        text.push('\n');
    }
    text.push_str("\n%%% ");
    text.push_str(SECTION);
    text.push('\n');
    for line in &section {
        text.push_str(line);
        text.push('\n');
    }
    text.push_str("%%%\n");
    text
}

/// `SUMMARY`, or a name for an event that has none. An empty `fm.title` would leave the
/// kernel's title resolver (SPEC §3.4) falling through to the first body line, which for an
/// imported event is whatever the feed put in `DESCRIPTION`.
fn display_title(event: &Event) -> String {
    let summary = collapse(&event.summary);
    if summary.is_empty() {
        "Untitled event".to_string()
    } else {
        summary
    }
}

/// The body: the description, made safe to place in a document.
///
/// Two hazards, both real in feeds:
///
/// 1. **A line that starts with `%%%`.** Machine sections are the last contiguous run of
///    `%%%` fences at the end of a document (SPEC §3.4), so a description ending in such a
///    line would join this plugin's own section and change what the document *means*. The
///    line is indented by one space, which is enough — the fence rule is byte-exact about
///    the line start — and leaves the text readable.
/// 2. **An unbounded length.** Capped at [`MAX_BODY_BYTES`] on a character boundary.
fn body_text(event: &Event) -> Option<String> {
    let description = event.description.as_deref()?.replace('\r', "\n");
    let mut body = String::with_capacity(description.len());
    for (index, line) in description.split('\n').enumerate() {
        if index > 0 {
            body.push('\n');
        }
        if line.starts_with("%%%") {
            body.push(' ');
        }
        body.push_str(line.trim_end());
    }
    let body = body.trim_matches('\n').to_string();
    if body.is_empty() {
        return None;
    }
    Some(truncate(body))
}

fn truncate(body: String) -> String {
    if body.len() <= MAX_BODY_BYTES {
        return body;
    }
    let mut cut = MAX_BODY_BYTES;
    while cut > 0 && !body.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{TRUNCATION_NOTE}", &body[..cut])
}

/// Collapse the whitespace in a one-line value. `SUMMARY` and `LOCATION` are single-line
/// properties, but a folded line with an escaped `\n` in it arrives as two — and a
/// frontmatter value has no way to be two lines (SPEC §3.4).
fn collapse(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> Event {
        Event {
            uid: "2f1c@google.com".to_string(),
            summary: "Standup".to_string(),
            start: "2026-09-24T09:00:00Z".to_string(),
            end: Some("2026-09-24T09:15:00Z".to_string()),
            all_day: false,
            location: None,
            description: Some("Daily standup, 15 minutes.".to_string()),
            sequence: 3,
            status: None,
            rrule: None,
            tzid: None,
        }
    }

    #[test]
    fn the_whole_document_is_one_exact_string() {
        assert_eq!(
            document_text("work", "calendar/work", &event()),
            concat!(
                "---\n",
                "title: Standup\n",
                "date: 2026-09-24T09:00:00Z\n",
                "date-end: 2026-09-24T09:15:00Z\n",
                "path: calendar/work\n",
                "source: ical\n",
                "source-uid: 2f1c@google.com\n",
                "---\n",
                "\n",
                "# Standup\n",
                "\n",
                "Daily standup, 15 minutes.\n",
                "\n",
                "%%% calendar\n",
                "feed: work\n",
                "status: confirmed\n",
                "sequence: 3\n",
                "all-day: false\n",
                "%%%\n",
            )
        );
    }

    #[test]
    fn rendering_is_deterministic() {
        let event = event();
        assert_eq!(
            document_text("work", "calendar/work", &event),
            document_text("work", "calendar/work", &event),
        );
    }

    #[test]
    fn an_all_day_event_keeps_date_precision_and_says_so() {
        let mut all_day = event();
        all_day.start = "2026-09-24".to_string();
        all_day.end = None;
        all_day.all_day = true;
        let text = document_text("home", "calendar/home", &all_day);
        assert!(text.contains("date: 2026-09-24\n"), "{text}");
        assert!(!text.contains("date-end"), "{text}");
        assert!(text.contains("all-day: true\n"), "{text}");
    }

    #[test]
    fn optional_properties_appear_only_when_the_feed_has_them() {
        let mut rich = event();
        rich.location = Some("Room 3".to_string());
        rich.tzid = Some("Europe/Riga".to_string());
        rich.rrule = Some("FREQ=WEEKLY;BYDAY=MO".to_string());
        rich.status = Some("tentative".to_string());
        let text = document_text("work", "calendar/work", &rich);
        assert!(text.contains("location: Room 3\n"), "{text}");
        assert!(text.contains("tzid: Europe/Riga\n"), "{text}");
        assert!(text.contains("rrule: FREQ=WEEKLY;BYDAY=MO\n"), "{text}");
        assert!(text.contains("status: tentative\n"), "{text}");
    }

    #[test]
    fn a_summary_that_would_break_the_frontmatter_is_quoted() {
        let mut awkward = event();
        awkward.summary = "Review: budget #3".to_string();
        let text = document_text("work", "calendar/work", &awkward);
        assert!(text.contains("title: \"Review: budget #3\"\n"), "{text}");
        // The heading is markdown, not YAML — it carries the text as written.
        assert!(text.contains("# Review: budget #3\n"), "{text}");
    }

    #[test]
    fn an_event_without_a_summary_still_has_a_title() {
        let mut nameless = event();
        nameless.summary = "  ".to_string();
        let text = document_text("work", "calendar/work", &nameless);
        assert!(text.contains("title: Untitled event\n"), "{text}");
    }

    #[test]
    fn a_description_cannot_grow_this_plugins_own_section() {
        let mut hostile = event();
        hostile.description = Some("see below\n%%% calendar\nfeed: evil\n%%%".to_string());
        let text = document_text("work", "calendar/work", &hostile);
        // Indented by one space: the fence rule is byte-exact about the line start, so this
        // is prose again — and the document still has exactly one `%%% calendar` fence.
        assert!(text.contains("\n %%% calendar\n"), "{text}");
        assert_eq!(text.matches("\n%%% calendar\n").count(), 1, "{text}");
        assert!(!text.contains("feed: evil\n%%%\n"), "{text}");
    }

    #[test]
    fn a_multiline_description_stays_multiline_and_a_folded_summary_does_not() {
        let mut event = event();
        event.summary = "Long\nsummary".to_string();
        event.description = Some("first\n\nsecond".to_string());
        let text = document_text("work", "calendar/work", &event);
        assert!(text.contains("title: Long summary\n"), "{text}");
        assert!(text.contains("\nfirst\n\nsecond\n"), "{text}");
    }

    #[test]
    fn an_enormous_description_is_truncated_rather_than_dropping_the_event() {
        let mut huge = event();
        huge.description = Some("x".repeat(MAX_BODY_BYTES * 2));
        let text = document_text("work", "calendar/work", &huge);
        assert!(text.len() < MAX_BODY_BYTES + 1024, "{}", text.len());
        assert!(text.contains(TRUNCATION_NOTE), "the truncation is visible");
    }

    #[test]
    fn an_empty_description_leaves_no_stray_blank_body() {
        let mut empty = event();
        empty.description = Some("   \n\n".to_string());
        let text = document_text("work", "calendar/work", &empty);
        assert!(text.contains("# Standup\n\n%%% calendar\n"), "{text}");
    }

    #[test]
    fn a_feed_never_invents_a_folder_hierarchy() {
        assert_eq!(folder_path("calendar", "work"), "calendar/work");
        assert_eq!(folder_path("calendar", "Work / Ops"), "calendar/Work - Ops");
        assert_eq!(folder_path("calendar", "work/ops"), "calendar/work-ops");
        assert_eq!(folder_path("a//b/", "work"), "a/b/work");
        assert_eq!(folder_path("../etc", "work"), "etc/work");
        assert_eq!(folder_path("  ", "  "), "calendar");
        assert_eq!(folder_path(".", "."), "calendar");
    }
}

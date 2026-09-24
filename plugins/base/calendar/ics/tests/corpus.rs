//! The parser corpus: feeds as they actually arrive, not as RFC 5545 describes them.
//!
//! Every case here is something a real publisher does. Google folds long `DESCRIPTION`s at
//! 75 octets and escapes commas; Nextcloud emits `VALARM` sub-components with their own
//! `SUMMARY`; Outlook publishes `TZID`-qualified local times with no `VTIMEZONE` a client
//! could resolve; hand-maintained feeds contain a `VEVENT` with no `UID` and a `SEQUENCE`
//! that is not a number. The parser's contract is that **one bad event costs one event** —
//! the same per-line tolerance the shared core applies to frontmatter (SPEC §3.4) — so each
//! test asserts both what survived and what was recorded as a problem.
//!
//! This file is an *integration* test on purpose: it may use only the crate's public API,
//! which is the same surface the plugin crate uses.

use calendar_ics::{
    Calendar, SOURCE_ICAL, document_text, folder_path, normalize_datetime, parse, unescape_text,
};

/// A feed wrapper, so each case reads as the body of a calendar.
fn feed(body: &str) -> Calendar {
    parse(&format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//corpus//EN\r\n{body}END:VCALENDAR\r\n"
    ))
}

fn one(body: &str) -> Calendar {
    feed(&format!("BEGIN:VEVENT\r\n{body}END:VEVENT\r\n"))
}

// ---------------------------------------------------------------------------
// Folding — the step naive parsers skip and long descriptions punish
// ---------------------------------------------------------------------------

#[test]
fn folded_lines_are_unfolded_before_properties_are_split() {
    let calendar = one(concat!(
        "UID:fold@example.com\r\n",
        "SUMMARY:Quarterly planning\r\n",
        "DESCRIPTION:Bring the roadmap\\, the budget\r\n",
        "  and a list of open questions.\r\n",
        "DTSTART:20260924T090000Z\r\n",
    ));
    assert!(calendar.problems.is_empty(), "{:?}", calendar.problems);
    let event = &calendar.events[0];
    // The continuation was joined minus exactly one leading space/tab — not read as a
    // property called `and a list of open questions.`.
    assert_eq!(
        event.description.as_deref(),
        Some("Bring the roadmap, the budget and a list of open questions.")
    );
}

#[test]
fn a_tab_continues_a_line_just_like_a_space() {
    let calendar = one(concat!(
        "UID:tab@example.com\r\n",
        "SUMMARY:Split\r\n\tsummary\r\n",
        "DTSTART:20260924T090000Z\r\n",
    ));
    assert_eq!(calendar.events[0].summary, "Splitsummary");
}

#[test]
fn bare_lf_and_bare_cr_feeds_parse_the_same_as_crlf() {
    // RFC 5545 says CRLF. A feed that went through the wrong tool arrives with either half
    // of it, and a parser that only knows CRLF reads such a file as one enormous line.
    let crlf = one("UID:x@e\r\nSUMMARY:X\r\nDTSTART:20260924T090000Z\r\n");
    let body = "BEGIN:VCALENDAR{0}BEGIN:VEVENT{0}UID:x@e{0}SUMMARY:X{0}DTSTART:20260924T090000Z{0}END:VEVENT{0}END:VCALENDAR{0}";
    for ending in ["\n", "\r"] {
        let parsed = parse(&body.replace("{0}", ending));
        assert_eq!(crlf.events, parsed.events, "line ending {ending:?}");
    }
}

// ---------------------------------------------------------------------------
// Escapes
// ---------------------------------------------------------------------------

#[test]
fn text_escapes_are_undone() {
    assert_eq!(unescape_text(r"a\,b\;c"), "a,b;c");
    assert_eq!(unescape_text(r"line\none"), "line\none");
    assert_eq!(unescape_text(r"LINE\NTWO"), "LINE\nTWO");
    assert_eq!(unescape_text(r"back\\slash"), r"back\slash");
    // Escapes no RFC defines, which feeds emit anyway: the character survives.
    assert_eq!(unescape_text(r#"quote\"x\:y"#), "quote\"x:y");
    // A truncated escape at the end of a folded value is kept as written.
    assert_eq!(unescape_text(r"trailing\"), r"trailing\");
}

#[test]
fn an_escaped_newline_in_a_description_becomes_a_real_body_line() {
    let calendar = one(concat!(
        "UID:esc@example.com\r\n",
        "SUMMARY:Retro\r\n",
        "DESCRIPTION:What went well\\nWhat did not\r\n",
        "DTSTART:20260924T090000Z\r\n",
    ));
    assert_eq!(
        calendar.events[0].description.as_deref(),
        Some("What went well\nWhat did not")
    );
    let text = document_text("work", "calendar/work", &calendar.events[0]);
    assert!(text.contains("What went well\nWhat did not\n"), "{text}");
}

// ---------------------------------------------------------------------------
// Dates: date-only, tz-naive, zoned, and the ends
// ---------------------------------------------------------------------------

#[test]
fn a_date_only_event_is_all_day_and_keeps_date_precision() {
    let calendar = one(concat!(
        "UID:allday@example.com\r\n",
        "SUMMARY:Public holiday\r\n",
        "DTSTART;VALUE=DATE:20260624\r\n",
        "DTEND;VALUE=DATE:20260625\r\n",
    ));
    let event = &calendar.events[0];
    assert!(event.all_day);
    assert_eq!(event.start, "2026-06-24");
    // RFC 5545's DTEND is exclusive; a one-day event must not look like two.
    assert_eq!(event.end, None);
}

#[test]
fn a_multi_day_all_day_event_ends_on_its_last_day() {
    let calendar = one(concat!(
        "UID:trip@example.com\r\n",
        "SUMMARY:Conference\r\n",
        "DTSTART;VALUE=DATE:20260901\r\n",
        "DTEND;VALUE=DATE:20260904\r\n",
    ));
    let event = &calendar.events[0];
    assert_eq!(event.start, "2026-09-01");
    assert_eq!(event.end.as_deref(), Some("2026-09-03"));
}

#[test]
fn a_tz_naive_time_keeps_its_wall_clock_and_records_the_zone() {
    let calendar = one(concat!(
        "UID:zoned@example.com\r\n",
        "SUMMARY:Standup\r\n",
        "DTSTART;TZID=Europe/Riga:20260924T090000\r\n",
        "DTEND;TZID=Europe/Riga:20260924T091500\r\n",
    ));
    let event = &calendar.events[0];
    // No timezone database in M4: the wall-clock value is carried honestly and the zone
    // travels to the document instead of being turned into an invented offset.
    assert_eq!(event.start, "2026-09-24T09:00:00");
    assert_eq!(event.end.as_deref(), Some("2026-09-24T09:15:00"));
    assert_eq!(event.tzid.as_deref(), Some("Europe/Riga"));
}

#[test]
fn a_floating_time_is_zoneless_and_says_nothing_it_does_not_know() {
    let calendar = one(concat!(
        "UID:floating@example.com\r\n",
        "SUMMARY:Lunch\r\n",
        "DTSTART:20260924T120000\r\n",
    ));
    assert_eq!(calendar.events[0].start, "2026-09-24T12:00:00");
    assert_eq!(calendar.events[0].tzid, None);
}

#[test]
fn a_quoted_tzid_parameter_survives_its_own_colons() {
    let calendar = one(concat!(
        "UID:quoted@example.com\r\n",
        "SUMMARY:Call\r\n",
        "DTSTART;TZID=\"GMT+01:00\":20260924T090000\r\n",
    ));
    assert_eq!(calendar.events[0].tzid.as_deref(), Some("GMT+01:00"));
    assert_eq!(calendar.events[0].start, "2026-09-24T09:00:00");
}

#[test]
fn a_duration_becomes_an_end() {
    let calendar = one(concat!(
        "UID:dur@example.com\r\n",
        "SUMMARY:Workshop\r\n",
        "DTSTART:20260924T090000Z\r\n",
        "DURATION:PT1H30M\r\n",
    ));
    assert_eq!(
        calendar.events[0].end.as_deref(),
        Some("2026-09-24T10:30:00Z")
    );
}

#[test]
fn an_all_day_duration_stays_whole_days() {
    let calendar = one(concat!(
        "UID:week@example.com\r\n",
        "SUMMARY:Sprint\r\n",
        "DTSTART;VALUE=DATE:20260901\r\n",
        "DURATION:P1W\r\n",
    ));
    let event = &calendar.events[0];
    assert!(event.all_day);
    assert_eq!(event.end.as_deref(), Some("2026-09-07"));
}

#[test]
fn normalization_is_total_and_refuses_what_it_cannot_read() {
    assert_eq!(
        normalize_datetime("20260924", "").as_deref(),
        Some("2026-09-24")
    );
    assert_eq!(
        normalize_datetime("20260924T060000Z", "").as_deref(),
        Some("2026-09-24T06:00:00Z")
    );
    // `HHMM` is not RFC 5545 and feeds emit it; seconds default to zero.
    assert_eq!(
        normalize_datetime("20260924T0600", "").as_deref(),
        Some("2026-09-24T06:00:00")
    );
    // `VALUE=DATE` wins over a value that carries a clock: the feed declared the type.
    assert_eq!(
        normalize_datetime("20260924T060000Z", "VALUE=DATE").as_deref(),
        Some("2026-09-24")
    );
    // A leap day that exists, and one that does not.
    assert_eq!(
        normalize_datetime("20240229", "").as_deref(),
        Some("2024-02-29")
    );
    for impossible in [
        "20260230T120000Z",
        "20261301",
        "20260900",
        "2026092",
        "20260924T256000Z",
        "20260924X060000",
        "not-a-date",
        "",
    ] {
        assert_eq!(normalize_datetime(impossible, ""), None, "{impossible}");
    }
}

// ---------------------------------------------------------------------------
// Sub-components, and the events that must be dropped
// ---------------------------------------------------------------------------

#[test]
fn an_alarms_own_text_never_overwrites_the_meetings() {
    let calendar = one(concat!(
        "UID:alarm@example.com\r\n",
        "SUMMARY:Board meeting\r\n",
        "DESCRIPTION:Quarterly review\r\n",
        "DTSTART:20260924T090000Z\r\n",
        "BEGIN:VALARM\r\n",
        "ACTION:DISPLAY\r\n",
        "SUMMARY:Reminder\r\n",
        "DESCRIPTION:In 10 minutes\r\n",
        "TRIGGER:-PT10M\r\n",
        "END:VALARM\r\n",
    ));
    let event = &calendar.events[0];
    assert_eq!(event.summary, "Board meeting");
    assert_eq!(event.description.as_deref(), Some("Quarterly review"));
}

#[test]
fn a_vtimezone_block_contributes_nothing_and_breaks_nothing() {
    let calendar = feed(concat!(
        "BEGIN:VTIMEZONE\r\n",
        "TZID:Europe/Riga\r\n",
        "BEGIN:DAYLIGHT\r\n",
        "DTSTART:19700329T030000\r\n",
        "TZOFFSETFROM:+0200\r\n",
        "TZOFFSETTO:+0300\r\n",
        "END:DAYLIGHT\r\n",
        "END:VTIMEZONE\r\n",
        "BEGIN:VEVENT\r\n",
        "UID:after-tz@example.com\r\n",
        "SUMMARY:Standup\r\n",
        "DTSTART;TZID=Europe/Riga:20260924T090000\r\n",
        "END:VEVENT\r\n",
    ));
    assert_eq!(calendar.events.len(), 1);
    assert_eq!(calendar.events[0].uid, "after-tz@example.com");
    assert!(calendar.problems.is_empty(), "{:?}", calendar.problems);
}

#[test]
fn an_event_without_a_uid_is_dropped_with_a_reason() {
    let calendar = one("SUMMARY:Anonymous\r\nDTSTART:20260924T090000Z\r\n");
    assert!(calendar.events.is_empty());
    assert_eq!(calendar.problems.len(), 1);
    assert!(calendar.problems[0].message.contains("no UID"));
}

#[test]
fn an_event_without_a_usable_dtstart_is_dropped_with_a_reason() {
    let calendar = one("UID:nodate@example.com\r\nSUMMARY:Someday\r\n");
    assert!(calendar.events.is_empty());
    assert_eq!(calendar.problems.len(), 1);
    assert!(calendar.problems[0].message.contains("DTSTART"));
}

#[test]
fn one_bad_property_costs_one_property_and_the_event_still_imports() {
    let calendar = one(concat!(
        "UID:seq@example.com\r\n",
        "SUMMARY:Review\r\n",
        "SEQUENCE:later\r\n",
        "DURATION:P\r\n",
        "DTSTART:20260924T090000Z\r\n",
    ));
    let event = &calendar.events[0];
    assert_eq!(event.sequence, 0, "the unreadable SEQUENCE is ignored");
    assert_eq!(event.end, None, "the unreadable DURATION is ignored");
    assert_eq!(calendar.problems.len(), 2, "{:?}", calendar.problems);
    assert!(
        calendar
            .problems
            .iter()
            .any(|p| p.message.contains("SEQUENCE"))
    );
    assert!(
        calendar
            .problems
            .iter()
            .any(|p| p.message.contains("DURATION"))
    );
}

#[test]
fn one_broken_event_does_not_cost_the_others() {
    let calendar = feed(concat!(
        "BEGIN:VEVENT\r\nUID:good-1@e\r\nSUMMARY:One\r\nDTSTART:20260924T090000Z\r\nEND:VEVENT\r\n",
        "BEGIN:VEVENT\r\nSUMMARY:No uid\r\nDTSTART:20260924T100000Z\r\nEND:VEVENT\r\n",
        "BEGIN:VEVENT\r\nUID:good-2@e\r\nSUMMARY:Two\r\nDTSTART:20260924T110000Z\r\nEND:VEVENT\r\n",
    ));
    let uids: Vec<&str> = calendar.events.iter().map(|e| e.uid.as_str()).collect();
    assert_eq!(uids, vec!["good-1@e", "good-2@e"]);
    assert_eq!(calendar.problems.len(), 1);
}

#[test]
fn an_unterminated_event_is_imported_and_flagged() {
    let calendar = parse(concat!(
        "BEGIN:VCALENDAR\r\n",
        "BEGIN:VEVENT\r\n",
        "UID:truncated@e\r\n",
        "SUMMARY:Cut off\r\n",
        "DTSTART:20260924T090000Z\r\n",
    ));
    assert_eq!(calendar.events.len(), 1);
    assert!(
        calendar
            .problems
            .iter()
            .any(|p| p.message.contains("never closed"))
    );
}

#[test]
fn a_repeated_uid_keeps_the_first_occurrence() {
    let calendar = feed(concat!(
        "BEGIN:VEVENT\r\nUID:series@e\r\nSUMMARY:Weekly\r\nDTSTART:20260907T090000Z\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\n",
        "BEGIN:VEVENT\r\nUID:series@e\r\nRECURRENCE-ID:20260914T090000Z\r\nSUMMARY:Weekly (moved)\r\nDTSTART:20260914T100000Z\r\nEND:VEVENT\r\n",
    ));
    assert_eq!(calendar.events.len(), 1);
    assert_eq!(calendar.events[0].summary, "Weekly");
    // RRULE is carried, not expanded — the document records it so a later version can.
    assert_eq!(calendar.events[0].rrule.as_deref(), Some("FREQ=WEEKLY"));
    assert!(
        calendar
            .problems
            .iter()
            .any(|p| p.message.contains("RECURRENCE-ID"))
    );
}

#[test]
fn an_end_before_its_start_is_dropped_rather_than_believed() {
    let calendar = one(concat!(
        "UID:backwards@e\r\n",
        "SUMMARY:Impossible\r\n",
        "DTSTART:20260924T090000Z\r\n",
        "DTEND:20260924T080000Z\r\n",
    ));
    assert_eq!(calendar.events[0].end, None);
    assert!(
        calendar
            .problems
            .iter()
            .any(|p| p.message.contains("ends before"))
    );
}

#[test]
fn a_cancelled_event_in_the_feed_keeps_its_status() {
    let calendar = one(concat!(
        "UID:off@e\r\n",
        "SUMMARY:Cancelled call\r\n",
        "STATUS:CANCELLED\r\n",
        "DTSTART:20260924T090000Z\r\n",
    ));
    assert_eq!(calendar.events[0].status.as_deref(), Some("cancelled"));
    let text = document_text("work", "calendar/work", &calendar.events[0]);
    assert!(text.contains("status: cancelled\n"), "{text}");
}

#[test]
fn property_names_are_case_insensitive_and_junk_lines_are_recorded() {
    let calendar = one(concat!(
        "uid:lower@e\r\n",
        "Summary:Mixed case\r\n",
        "this line has no colon\r\n",
        "dtstart:20260924T090000Z\r\n",
    ));
    assert_eq!(calendar.events[0].summary, "Mixed case");
    assert!(
        calendar
            .problems
            .iter()
            .any(|p| p.message.contains("not a property"))
    );
}

// ---------------------------------------------------------------------------
// The feed's own name, and what it becomes
// ---------------------------------------------------------------------------

#[test]
fn a_feed_that_names_itself_names_the_folder() {
    let calendar = feed(concat!(
        "X-WR-CALNAME:Work / Ops\r\n",
        "BEGIN:VEVENT\r\nUID:named@e\r\nSUMMARY:Standup\r\nDTSTART:20260924T090000Z\r\nEND:VEVENT\r\n",
    ));
    assert_eq!(calendar.name.as_deref(), Some("Work / Ops"));
    assert_eq!(
        folder_path("calendar", calendar.name.as_deref().unwrap()),
        "calendar/Work - Ops"
    );
}

// ---------------------------------------------------------------------------
// End to end: a realistic feed becomes documents
// ---------------------------------------------------------------------------

#[test]
fn a_realistic_feed_becomes_documents_a_dated_view_can_read() {
    let calendar = feed(concat!(
        "X-WR-CALNAME:Work\r\n",
        "BEGIN:VEVENT\r\n",
        "UID:2f1c@google.com\r\n",
        "SUMMARY:Standup\r\n",
        "DESCRIPTION:Daily standup\\, 15 minutes.\r\n",
        "LOCATION:Room 3\r\n",
        "SEQUENCE:3\r\n",
        "DTSTART:20260924T090000Z\r\n",
        "DTEND:20260924T091500Z\r\n",
        "END:VEVENT\r\n",
        "BEGIN:VEVENT\r\n",
        "UID:holiday@example.com\r\n",
        "SUMMARY:Midsummer\r\n",
        "DTSTART;VALUE=DATE:20260623\r\n",
        "DTEND;VALUE=DATE:20260625\r\n",
        "END:VEVENT\r\n",
    ));
    assert_eq!(calendar.events.len(), 2);
    assert!(calendar.problems.is_empty(), "{:?}", calendar.problems);

    let path = folder_path("calendar", calendar.name.as_deref().unwrap());
    let standup = document_text("work", &path, &calendar.events[0]);
    assert_eq!(
        standup,
        concat!(
            "---\n",
            "title: Standup\n",
            "date: 2026-09-24T09:00:00Z\n",
            "date-end: 2026-09-24T09:15:00Z\n",
            "path: calendar/Work\n",
            "location: Room 3\n",
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

    let holiday = document_text("work", &path, &calendar.events[1]);
    assert!(
        holiday.contains(&format!("source: {SOURCE_ICAL}\n")),
        "{holiday}"
    );
    assert!(holiday.contains("date: 2026-06-23\n"), "{holiday}");
    assert!(holiday.contains("date-end: 2026-06-24\n"), "{holiday}");
    assert!(holiday.contains("all-day: true\n"), "{holiday}");
}

#[test]
fn an_empty_or_junk_feed_is_a_calendar_with_nothing_in_it() {
    for junk in [
        "",
        "\r\n\r\n",
        "<html><body>404</body></html>",
        "BEGIN:VCALENDAR\r\n",
    ] {
        let calendar = parse(junk);
        assert!(calendar.events.is_empty(), "{junk}");
    }
}

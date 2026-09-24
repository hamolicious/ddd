//! Reading a feed: unfolding, property splitting, and the `VEVENT` walk.
//!
//! Three tolerances, each of them a real feed's fault rather than a hypothetical:
//!
//! 1. **Folding is undone first.** RFC 5545 breaks long lines and continues them with a
//!    leading space or tab; Google folds `DESCRIPTION` at 75 octets, Nextcloud at 73, and
//!    a parser that splits properties before unfolding reads the continuation as a
//!    property called `Daily standup` and drops the rest of the description.
//! 2. **Sub-components are skipped, not merged.** A `VALARM` inside a `VEVENT` has its own
//!    `DESCRIPTION` and often its own `SUMMARY`; a flat walk lets the alarm's text
//!    overwrite the meeting's.
//! 3. **One bad property costs one property.** A `SEQUENCE: later` is recorded and
//!    ignored; the event still imports. Same rule as the shared core's per-line tolerance
//!    (SPEC §3.4) and the same reason.

use crate::datetime::{self, Shape, Stamp};
use crate::{Calendar, Event, Problem};

/// One unfolded (logical) line, with the physical line number it started on — so a
/// problem points at what the operator sees in the feed.
struct Logical {
    line: u32,
    text: String,
}

/// One property: `NAME;PARAM=value:VALUE`.
struct Property<'a> {
    /// Upper-cased: property names are case-insensitive in RFC 5545.
    name: String,
    /// The raw parameter text between the name and the colon (no leading `;`).
    params: &'a str,
    value: &'a str,
}

/// Parse an iCalendar document.
///
/// Total: any input yields a `Calendar`. Unfolds RFC 5545 continuation lines (a leading
/// space or tab continues the previous one) **before** splitting properties, which is the
/// step naive parsers skip and long `DESCRIPTION`s punish.
pub fn parse(input: &str) -> Calendar {
    let mut calendar = Calendar::default();
    // Component nesting: `["VCALENDAR", "VEVENT", "VALARM"]`. Properties are read only
    // when the innermost component is the one they belong to.
    let mut stack: Vec<String> = Vec::new();
    let mut builder: Option<Builder> = None;
    let mut seen_uids: Vec<String> = Vec::new();

    for logical in unfold(input) {
        let Some(property) = split_property(&logical.text) else {
            if !logical.text.trim().is_empty() {
                calendar.problems.push(Problem {
                    line: logical.line,
                    message: format!("line is not a property: `{}`", clip(&logical.text)),
                });
            }
            continue;
        };

        match property.name.as_str() {
            "BEGIN" => {
                let component = property.value.trim().to_ascii_uppercase();
                if component == "VEVENT" {
                    if builder.is_some() {
                        calendar.problems.push(Problem {
                            line: logical.line,
                            message: "BEGIN:VEVENT inside a VEVENT; the outer one is dropped"
                                .to_string(),
                        });
                    }
                    builder = Some(Builder::new(logical.line));
                }
                stack.push(component);
            }
            "END" => {
                let component = property.value.trim().to_ascii_uppercase();
                if stack.last().map(String::as_str) == Some(component.as_str()) {
                    stack.pop();
                } else {
                    calendar.problems.push(Problem {
                        line: logical.line,
                        message: format!(
                            "END:{component} does not close the open component; ignored"
                        ),
                    });
                }
                if component == "VEVENT"
                    && let Some(open) = builder.take()
                {
                    open.finish(&mut calendar, &mut seen_uids);
                }
            }
            _ => match stack.last().map(String::as_str) {
                Some("VEVENT") => {
                    if let Some(open) = builder.as_mut() {
                        open.property(&property, logical.line, &mut calendar.problems);
                    }
                }
                // Feeds that name themselves save the operator inventing a folder name.
                Some("VCALENDAR") if property.name == "X-WR-CALNAME" => {
                    let name = unescape_text(property.value);
                    if !name.trim().is_empty() {
                        calendar.name = Some(name.trim().to_string());
                    }
                }
                // Everything else — VTIMEZONE, VALARM, VTODO, calendar-level PRODID — is
                // out of scope for M4 and silently not our business.
                _ => {}
            },
        }
    }

    if let Some(open) = builder {
        calendar.problems.push(Problem {
            line: open.line,
            message: "VEVENT is never closed; imported anyway".to_string(),
        });
        open.finish(&mut calendar, &mut seen_uids);
    }
    calendar
}

/// Unescape an iCalendar text value (`\\n`, `\\,`, `\\;`, `\\\\`).
pub fn unescape_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            // A trailing backslash is a truncated escape: keep it, it is what the feed
            // said.
            None => out.push('\\'),
            Some('n') | Some('N') => out.push('\n'),
            // An unknown escape keeps its character (RFC 5545 defines `\\`, `\;`, `\,`
            // and `\N`; feeds also emit `\:` and `\"`).
            Some(other) => out.push(other),
        }
    }
    out
}

/// Undo RFC 5545 line folding.
///
/// CRLF, CR and LF all end a line (feeds served through the wrong tool arrive with any of
/// them); a following line whose first character is a space or a tab continues the
/// previous one, minus exactly that one character.
fn unfold(input: &str) -> Vec<Logical> {
    let mut out: Vec<Logical> = Vec::new();
    for (index, line) in split_lines(input).into_iter().enumerate() {
        let number = index as u32 + 1;
        match line.strip_prefix([' ', '\t']) {
            Some(continuation) if !out.is_empty() => {
                // `out` is non-empty by the guard.
                if let Some(last) = out.last_mut() {
                    last.text.push_str(continuation);
                }
            }
            _ => out.push(Logical {
                line: number,
                text: line.to_string(),
            }),
        }
    }
    out
}

/// Physical lines, ending at `\r\n`, `\n` or a lone `\r`.
///
/// Borrowed slices, not an allocated copy of the feed: a 10 MB response is within the host's
/// cap and duplicating it to normalize line endings would be 10 MB of the instance's 128 MB
/// spent on something a two-byte look-ahead does for free.
fn split_lines(input: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    let bytes = input.as_bytes();
    let mut start = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\n' => {
                out.push(&input[start..index]);
                index += 1;
                start = index;
            }
            b'\r' => {
                out.push(&input[start..index]);
                index += if bytes.get(index + 1) == Some(&b'\n') {
                    2
                } else {
                    1
                };
                start = index;
            }
            _ => index += 1,
        }
    }
    if start < bytes.len() {
        out.push(&input[start..]);
    }
    out
}

/// Split `NAME;PARAM="a:b":VALUE` on the first **unquoted** colon.
fn split_property(line: &str) -> Option<Property<'_>> {
    if line.trim().is_empty() {
        return None;
    }
    let mut quoted = false;
    let mut colon = None;
    for (index, ch) in line.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            ':' if !quoted => {
                colon = Some(index);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);

    // The name ends at the first unquoted `;`.
    let mut quoted = false;
    let mut semicolon = None;
    for (index, ch) in head.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            ';' if !quoted => {
                semicolon = Some(index);
                break;
            }
            _ => {}
        }
    }
    let (name, params) = match semicolon {
        Some(index) => (&head[..index], &head[index + 1..]),
        None => (head, ""),
    };
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some(Property {
        name: name.to_ascii_uppercase(),
        params,
        value,
    })
}

/// Accumulates one `VEVENT`. Raw values are kept as parsed strings and only turned into
/// an [`Event`] in [`Builder::finish`], because `DTEND`/`DURATION` cannot be resolved
/// until `DTSTART` is known and the two may arrive in either order.
struct Builder {
    line: u32,
    uid: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    location: Option<String>,
    start: Option<Stamp>,
    tzid: Option<String>,
    end: Option<Stamp>,
    duration: Option<i64>,
    sequence: i64,
    status: Option<String>,
    rrule: Option<String>,
    recurrence_id: bool,
}

impl Builder {
    fn new(line: u32) -> Self {
        Self {
            line,
            uid: None,
            summary: None,
            description: None,
            location: None,
            start: None,
            tzid: None,
            end: None,
            duration: None,
            sequence: 0,
            status: None,
            rrule: None,
            recurrence_id: false,
        }
    }

    fn property(&mut self, property: &Property<'_>, line: u32, problems: &mut Vec<Problem>) {
        match property.name.as_str() {
            "UID" => self.uid = Some(unescape_text(property.value).trim().to_string()),
            "SUMMARY" => self.summary = Some(unescape_text(property.value)),
            "DESCRIPTION" => self.description = Some(unescape_text(property.value)),
            "LOCATION" => self.location = Some(unescape_text(property.value)),
            "DTSTART" => {
                self.tzid = datetime::param(property.params, "TZID").map(str::to_string);
                match datetime::parse_stamp(property.value, property.params) {
                    Some(stamp) => self.start = Some(stamp),
                    None => problems.push(Problem {
                        line,
                        message: format!(
                            "DTSTART `{}` is not a date I can read",
                            clip(property.value)
                        ),
                    }),
                }
            }
            "DTEND" => match datetime::parse_stamp(property.value, property.params) {
                Some(stamp) => self.end = Some(stamp),
                None => problems.push(Problem {
                    line,
                    message: format!("DTEND `{}` is not a date I can read", clip(property.value)),
                }),
            },
            "DURATION" => match datetime::parse_duration(property.value) {
                Some(seconds) => self.duration = Some(seconds),
                None => problems.push(Problem {
                    line,
                    message: format!(
                        "DURATION `{}` is not a duration I can read",
                        clip(property.value)
                    ),
                }),
            },
            "SEQUENCE" => match property.value.trim().parse::<i64>() {
                Ok(sequence) => self.sequence = sequence,
                Err(_) => problems.push(Problem {
                    line,
                    message: format!("SEQUENCE `{}` is not a number", clip(property.value)),
                }),
            },
            "STATUS" => self.status = Some(property.value.trim().to_ascii_lowercase()),
            "RRULE" => self.rrule = Some(property.value.trim().to_string()),
            "RECURRENCE-ID" => self.recurrence_id = true,
            _ => {}
        }
    }

    /// Turn the accumulated properties into an event, or explain why not.
    ///
    /// Two drops, both deliberate:
    ///
    /// - **No `UID`** — there would be no way to update the event next sync without
    ///   creating a second copy of it, which is worse than not importing it.
    /// - **No usable `DTSTART`** — a calendar's whole job is putting an event on a day.
    ///
    /// And one dedupe: a repeated `UID` (a `RECURRENCE-ID` override of a recurring event,
    /// which M4 does not expand) keeps the **first** occurrence. Two documents matching
    /// one uid would make the next reconciliation ambiguous, and picking the first is
    /// stable across runs where "the last one wins" would flip on feed reordering.
    fn finish(self, calendar: &mut Calendar, seen_uids: &mut Vec<String>) {
        let uid = match self.uid.as_deref().map(str::trim) {
            Some(uid) if !uid.is_empty() => uid.to_string(),
            _ => {
                calendar.problems.push(Problem {
                    line: self.line,
                    message: "VEVENT has no UID; dropped (nothing could match it next sync)"
                        .to_string(),
                });
                return;
            }
        };
        let Some(start) = self.start else {
            calendar.problems.push(Problem {
                line: self.line,
                message: format!("VEVENT `{}` has no usable DTSTART; dropped", clip(&uid)),
            });
            return;
        };
        if seen_uids.iter().any(|seen| seen == &uid) {
            calendar.problems.push(Problem {
                line: self.line,
                message: if self.recurrence_id {
                    format!(
                        "VEVENT `{}` is a RECURRENCE-ID override; M4 does not expand recurrence, so the first occurrence is kept",
                        clip(&uid)
                    )
                } else {
                    format!("VEVENT `{}` repeats a UID; the first one is kept", clip(&uid))
                },
            });
            return;
        }

        let all_day = start.shape == Shape::Date;
        let end = self.resolve_end(start, all_day, &uid, &mut calendar.problems);

        seen_uids.push(uid.clone());
        calendar.events.push(Event {
            uid,
            summary: self.summary.unwrap_or_default().trim().to_string(),
            start: datetime::format_stamp(start),
            end: end.map(datetime::format_stamp),
            all_day,
            location: non_empty(self.location),
            description: non_empty(self.description),
            sequence: self.sequence,
            status: non_empty(self.status),
            rrule: non_empty(self.rrule),
            tzid: non_empty(self.tzid),
        });
    }

    /// `DTEND`, or `DTSTART` + `DURATION`, converted to an **inclusive** end.
    ///
    /// RFC 5545's `DTEND` is exclusive, which for an all-day event means a one-day meeting
    /// is written `DTSTART;VALUE=DATE:20260924` / `DTEND;VALUE=DATE:20260925`. Storing
    /// that verbatim in `fm.date-end` would show every single-day event as spanning two
    /// days, so the last day is what goes in the document — and a single-day event gets no
    /// `date-end` at all, because the start already says everything.
    fn resolve_end(
        &self,
        start: Stamp,
        all_day: bool,
        uid: &str,
        problems: &mut Vec<Problem>,
    ) -> Option<Stamp> {
        let exclusive = match (self.end, self.duration) {
            (Some(end), _) => end,
            (None, Some(seconds)) => datetime::shift(start, seconds),
            (None, None) => return None,
        };
        let end = if all_day {
            datetime::shift(exclusive, -86_400)
        } else {
            exclusive
        };
        if (end.days, end.secs) <= (start.days, start.secs) {
            if (end.days, end.secs) < (start.days, start.secs) && !all_day {
                problems.push(Problem {
                    line: self.line,
                    message: format!("VEVENT `{}` ends before it starts; end dropped", clip(uid)),
                });
            }
            return None;
        }
        Some(end)
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.trim().is_empty())
}

/// Problems are logged by the server and read by a person; a 40 KB folded `DESCRIPTION`
/// in a log line is not.
fn clip(text: &str) -> String {
    const MAX: usize = 60;
    let trimmed = text.trim();
    if trimmed.chars().count() <= MAX {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(MAX).collect();
    format!("{head}…")
}

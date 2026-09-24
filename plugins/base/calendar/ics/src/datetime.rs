//! iCalendar date/date-time values, and the arithmetic `DURATION` needs.
//!
//! **Hand-rolled on purpose**, like the shared core's `date.rs` and the host's cron
//! parser: this workspace refuses a second date library, and the two shapes a feed uses
//! (`YYYYMMDD` and `YYYYMMDDTHHMMSS[Z]`) plus "add N seconds" is about forty lines of
//! civil-calendar arithmetic. A dependency would be larger than the thing it replaces and
//! would have opinions about timezones this milestone has decided not to have.
//!
//! **No timezone database.** A `TZID=`-qualified or floating time keeps its **wall-clock
//! value** and is emitted without an offset; the shared core reads an offsetless stamp as
//! UTC (`core::date::Date::parse`), so `fm.date` for such an event is the local time as
//! written. Inventing an offset from a zone name we cannot resolve would be worse: it
//! would be wrong by a whole hour twice a year and there would be nothing in the document
//! to say so. The zone travels to the document as `%%% calendar → tzid` instead.

/// What shape a normalized stamp has. The distinction is load-bearing: a date-precision
/// value is an all-day event and must stay date-precision through `DURATION` arithmetic,
/// or a one-day event silently becomes a midnight-to-midnight appointment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Shape {
    /// `YYYY-MM-DD`
    Date,
    /// `YYYY-MM-DDTHH:MM:SS` — wall clock, zone unknown (floating or `TZID=`).
    Local,
    /// `YYYY-MM-DDTHH:MM:SSZ`
    Utc,
}

/// A normalized stamp, decomposed for arithmetic.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Stamp {
    /// Days since the civil epoch (1970-01-01).
    pub(crate) days: i64,
    /// Seconds within the day (always 0 for [`Shape::Date`]).
    pub(crate) secs: i64,
    pub(crate) shape: Shape,
}

/// Normalize an iCalendar date/date-time to the canonical ISO-8601 form.
///
/// `20260924` → `2026-09-24`; `20260924T060000Z` → `2026-09-24T06:00:00Z`; a
/// `TZID=`-qualified local time keeps its wall-clock value and is marked by the caller —
/// M4 does not ship a timezone database, and inventing an offset would be worse than
/// carrying the local time honestly.
///
/// `params` is the raw parameter text of the property (`VALUE=DATE`,
/// `TZID=Europe/Riga`, with or without a leading `;`). `VALUE=DATE` forces date
/// precision even when the value carries a time, because the feed said so.
///
/// Returns `None` for anything that is not one of the two shapes or is not a real
/// calendar instant (`20260230T120000Z` does not parse) — total, never a panic.
pub fn normalize_datetime(raw: &str, params: &str) -> Option<String> {
    let stamp = parse_stamp(raw, params)?;
    Some(format_stamp(stamp))
}

/// Parse into a [`Stamp`], the form `DURATION` arithmetic needs.
pub(crate) fn parse_stamp(raw: &str, params: &str) -> Option<Stamp> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let bytes = value.as_bytes();
    if !(bytes.len() >= 8 && bytes[..8].iter().all(u8::is_ascii_digit)) {
        return None;
    }

    let year: i64 = value[0..4].parse().ok()?;
    let month: u32 = value[4..6].parse().ok()?;
    let day: u32 = value[6..8].parse().ok()?;
    if month == 0 || month > 12 || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    let days = days_from_civil(year, month, day);

    let date_only = param_equals(params, "VALUE", "DATE");
    if bytes.len() == 8 {
        return Some(Stamp {
            days,
            secs: 0,
            shape: Shape::Date,
        });
    }

    // A time part must start with the designator; anything else is a shape we do not
    // pretend to understand.
    if !matches!(bytes[8], b'T' | b't') {
        return None;
    }
    let (time, utc) = match value.as_bytes().last() {
        Some(b'Z') | Some(b'z') => (&value[9..value.len() - 1], true),
        _ => (&value[9..], false),
    };
    let tb = time.as_bytes();
    // `HHMM` is not RFC 5545, and feeds emit it anyway; seconds default to zero.
    if !(matches!(tb.len(), 4 | 6) && tb.iter().all(u8::is_ascii_digit)) {
        return None;
    }
    let hour: i64 = time[0..2].parse().ok()?;
    let minute: i64 = time[2..4].parse().ok()?;
    let second: i64 = if tb.len() == 6 {
        time[4..6].parse().ok()?
    } else {
        0
    };
    // Leap seconds are accepted by RFC 5545's grammar (`60`) and normalized away rather
    // than dropping the whole event.
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let secs = hour * 3_600 + minute * 60 + second.min(59);

    if date_only {
        // `VALUE=DATE` with a time in it: the declared type wins, the clock is dropped.
        return Some(Stamp {
            days,
            secs: 0,
            shape: Shape::Date,
        });
    }
    Some(Stamp {
        days,
        secs,
        shape: if utc { Shape::Utc } else { Shape::Local },
    })
}

/// Render a stamp in the form the document text carries.
///
/// The two shapes are exactly what `core::date::Date::parse` accepts and normalizes to
/// its canonical form at materialization (SPEC §3.4), which is what makes `fm.date` sort
/// chronologically and compare correctly against a date literal in the filter DSL.
pub(crate) fn format_stamp(stamp: Stamp) -> String {
    let (year, month, day) = civil_from_days(stamp.days);
    match stamp.shape {
        Shape::Date => format!("{year:04}-{month:02}-{day:02}"),
        Shape::Local | Shape::Utc => {
            let hour = stamp.secs / 3_600;
            let minute = (stamp.secs % 3_600) / 60;
            let second = stamp.secs % 60;
            let suffix = if stamp.shape == Shape::Utc { "Z" } else { "" };
            format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}{suffix}")
        }
    }
}

/// Shift a stamp by whole seconds, keeping its shape.
pub(crate) fn shift(stamp: Stamp, seconds: i64) -> Stamp {
    let total = stamp.secs + seconds;
    let days = stamp.days + total.div_euclid(86_400);
    let secs = total.rem_euclid(86_400);
    match stamp.shape {
        // A date-precision stamp stays date-precision: a `P1D` on an all-day event is one
        // day, not "the same day at 00:00".
        Shape::Date => Stamp {
            days: stamp.days + seconds.div_euclid(86_400),
            secs: 0,
            shape: Shape::Date,
        },
        _ => Stamp {
            days,
            secs,
            ..stamp
        },
    }
}

/// Parse an RFC 5545 `DURATION` into seconds. `P1DT2H30M`, `PT15M`, `P2W`, `-PT5M`.
///
/// Returns `None` on anything outside that grammar rather than guessing — a duration we
/// misread would put an event's end in the wrong week, and no end at all is the more
/// honest answer.
pub(crate) fn parse_duration(raw: &str) -> Option<i64> {
    let mut text = raw.trim();
    let mut sign = 1i64;
    if let Some(rest) = text.strip_prefix('-') {
        sign = -1;
        text = rest;
    } else if let Some(rest) = text.strip_prefix('+') {
        text = rest;
    }
    let text = text.strip_prefix(['P', 'p'])?;

    let mut total = 0i64;
    let mut digits = String::new();
    let mut in_time = false;
    let mut saw_unit = false;
    for ch in text.chars() {
        match ch {
            '0'..='9' => digits.push(ch),
            'T' | 't' => {
                if !digits.is_empty() {
                    return None;
                }
                in_time = true;
            }
            unit => {
                if digits.is_empty() {
                    return None;
                }
                let count: i64 = digits.parse().ok()?;
                digits.clear();
                let seconds = match (in_time, unit.to_ascii_uppercase()) {
                    (false, 'W') => count.checked_mul(604_800)?,
                    (false, 'D') => count.checked_mul(86_400)?,
                    (true, 'H') => count.checked_mul(3_600)?,
                    (true, 'M') => count.checked_mul(60)?,
                    (true, 'S') => count,
                    _ => return None,
                };
                total = total.checked_add(seconds)?;
                saw_unit = true;
            }
        }
    }
    if !digits.is_empty() || !saw_unit {
        return None;
    }
    Some(sign * total)
}

/// One parameter's value, compared case-insensitively.
///
/// Lives here rather than in the property parser because `VALUE=DATE` is a *date*
/// question: it changes what a value means, not how a line splits.
pub(crate) fn param_equals(params: &str, name: &str, wanted: &str) -> bool {
    param(params, name).is_some_and(|value| value.eq_ignore_ascii_case(wanted))
}

/// One parameter's value, unquoted. Parameter values may be quoted precisely because they
/// may contain `;` and `:` (`TZID="GMT+01:00"`), so the scan honours the quotes.
pub(crate) fn param<'p>(params: &'p str, name: &str) -> Option<&'p str> {
    for part in split_params(params) {
        let (key, value) = part.split_once('=')?;
        if key.trim().eq_ignore_ascii_case(name) {
            let value = value.trim();
            return Some(
                value
                    .strip_prefix('"')
                    .and_then(|v| v.strip_suffix('"'))
                    .unwrap_or(value),
            );
        }
    }
    None
}

/// Split a raw parameter string on unquoted `;`.
fn split_params(params: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut quoted = false;
    let mut start = 0usize;
    for (index, ch) in params.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            ';' if !quoted => {
                if index > start {
                    out.push(&params[start..index]);
                }
                start = index + 1;
            }
            _ => {}
        }
    }
    if start < params.len() {
        out.push(&params[start..]);
    }
    out.into_iter().filter(|part| part.contains('=')).collect()
}

// ---------------------------------------------------------------------------
// Civil calendar arithmetic (Howard Hinnant's algorithms, as in `core::date`)
// ---------------------------------------------------------------------------

pub(crate) fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

pub(crate) fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if month <= 2 { y + 1 } else { y }, month, day)
}

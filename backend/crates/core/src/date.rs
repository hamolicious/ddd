use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatePrecision {
    Date,
    DateTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Date {
    canonical: String,
    precision: DatePrecision,
    epoch_millis: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DateError {
    #[error("not an ISO-8601 date or datetime")]
    Malformed,
    #[error("date out of supported range")]
    OutOfRange,
}

const MIN_EPOCH_MILLIS: i64 = -62_167_219_200_000;
const MAX_EPOCH_MILLIS: i64 = 253_402_300_799_999;

impl Date {
    pub fn parse(input: &str) -> Result<Date, DateError> {
        let s = input.trim();
        let bytes = s.as_bytes();
        if bytes.len() < 10 {
            return Err(DateError::Malformed);
        }
        if !(digits(&bytes[0..4])
            && bytes[4] == b'-'
            && digits(&bytes[5..7])
            && bytes[7] == b'-'
            && digits(&bytes[8..10]))
        {
            return Err(DateError::Malformed);
        }
        let year: i32 = s[0..4].parse().map_err(|_| DateError::Malformed)?;
        let month: u8 = s[5..7].parse().map_err(|_| DateError::Malformed)?;
        let day: u8 = s[8..10].parse().map_err(|_| DateError::Malformed)?;
        if month == 0 || month > 12 || day == 0 || day > days_in_month(year, month) {
            return Err(DateError::Malformed);
        }
        let day_millis = days_from_civil(year, month, day) * 86_400_000;

        if bytes.len() == 10 {
            let epoch_millis = day_millis;
            if !(MIN_EPOCH_MILLIS..=MAX_EPOCH_MILLIS).contains(&epoch_millis) {
                return Err(DateError::OutOfRange);
            }
            return Ok(Date {
                canonical: format!("{year:04}-{month:02}-{day:02}"),
                precision: DatePrecision::Date,
                epoch_millis,
            });
        }

        if !matches!(bytes[10], b'T' | b't' | b' ') {
            return Err(DateError::Malformed);
        }
        let rest = &s[11..];
        let rb = rest.as_bytes();
        if rb.len() < 5 || !digits(&rb[0..2]) || rb[2] != b':' || !digits(&rb[3..5]) {
            return Err(DateError::Malformed);
        }
        let hour: i64 = rest[0..2].parse().map_err(|_| DateError::Malformed)?;
        let minute: i64 = rest[3..5].parse().map_err(|_| DateError::Malformed)?;
        if hour > 23 || minute > 59 {
            return Err(DateError::Malformed);
        }
        let mut idx = 5usize;
        let mut second: i64 = 0;
        if rb.get(idx) == Some(&b':') {
            if rb.len() < idx + 3 || !digits(&rb[idx + 1..idx + 3]) {
                return Err(DateError::Malformed);
            }
            second = rest[idx + 1..idx + 3]
                .parse()
                .map_err(|_| DateError::Malformed)?;
            if second > 59 {
                return Err(DateError::Malformed);
            }
            idx += 3;
        }
        let mut millis: i64 = 0;
        if matches!(rb.get(idx), Some(&b'.') | Some(&b',')) {
            let start = idx + 1;
            let mut end = start;
            while end < rb.len() && rb[end].is_ascii_digit() {
                end += 1;
            }
            if end == start || end - start > 9 {
                return Err(DateError::Malformed);
            }
            let mut frac = rest[start..end].to_string();
            while frac.len() < 3 {
                frac.push('0');
            }
            millis = frac[0..3].parse().map_err(|_| DateError::Malformed)?;
            idx = end;
        }
        let offset_millis: i64 = match rb.get(idx) {
            None => 0,
            Some(&b'Z') | Some(&b'z') if idx + 1 == rb.len() => 0,
            Some(&sign) if sign == b'+' || sign == b'-' => {
                let tail = &rest[idx + 1..];
                let tb = tail.as_bytes();
                let (oh, om) = match tb.len() {
                    2 if digits(&tb[0..2]) => (&tail[0..2], "00"),
                    4 if digits(&tb[0..4]) => (&tail[0..2], &tail[2..4]),
                    5 if digits(&tb[0..2]) && tb[2] == b':' && digits(&tb[3..5]) => {
                        (&tail[0..2], &tail[3..5])
                    }
                    _ => return Err(DateError::Malformed),
                };
                let oh: i64 = oh.parse().map_err(|_| DateError::Malformed)?;
                let om: i64 = om.parse().map_err(|_| DateError::Malformed)?;
                if oh > 23 || om > 59 {
                    return Err(DateError::Malformed);
                }
                let magnitude = oh * 3_600_000 + om * 60_000;
                if sign == b'-' { -magnitude } else { magnitude }
            }
            Some(_) => return Err(DateError::Malformed),
        };

        let epoch_millis =
            day_millis + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis
                - offset_millis;
        Date::from_epoch_millis(epoch_millis)
    }

    pub fn from_epoch_millis(millis: i64) -> Result<Date, DateError> {
        if !(MIN_EPOCH_MILLIS..=MAX_EPOCH_MILLIS).contains(&millis) {
            return Err(DateError::OutOfRange);
        }
        let days = millis.div_euclid(86_400_000);
        let time_of_day = millis.rem_euclid(86_400_000);
        let (year, month, day) = civil_from_days(days);
        let hour = time_of_day / 3_600_000;
        let minute = (time_of_day % 3_600_000) / 60_000;
        let second = (time_of_day % 60_000) / 1_000;
        let sub = time_of_day % 1_000;
        Ok(Date {
            canonical: format!(
                "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{sub:03}Z"
            ),
            precision: DatePrecision::DateTime,
            epoch_millis: millis,
        })
    }

    pub fn canonical(&self) -> &str {
        &self.canonical
    }

    pub fn precision(&self) -> DatePrecision {
        self.precision
    }

    pub fn epoch_millis(&self) -> i64 {
        self.epoch_millis
    }

    pub fn looks_like_date(input: &str) -> bool {
        Date::parse(input).is_ok()
    }

    pub fn normalize_str(input: &str) -> String {
        match Date::parse(input) {
            Ok(date) => date.canonical,
            Err(_) => input.to_string(),
        }
    }
}

pub(crate) fn is_canonical_shape(s: &str) -> bool {
    let b = s.as_bytes();
    let date_part = b.len() >= 10
        && digits(&b[0..4])
        && b[4] == b'-'
        && digits(&b[5..7])
        && b[7] == b'-'
        && digits(&b[8..10]);
    if !date_part {
        return false;
    }
    match b.len() {
        10 => true,
        24 => {
            b[10] == b'T'
                && digits(&b[11..13])
                && b[13] == b':'
                && digits(&b[14..16])
                && b[16] == b':'
                && digits(&b[17..19])
                && b[19] == b'.'
                && digits(&b[20..23])
                && b[23] == b'Z'
        }
        _ => false,
    }
}

#[cfg(feature = "mongo")]
pub(crate) const CANONICAL_SHAPE_REGEX: &str =
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)?$";

fn digits(bytes: &[u8]) -> bool {
    bytes.iter().all(u8::is_ascii_digit)
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i32, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn days_from_civil(year: i32, month: u8, day: u8) -> i64 {
    let y = i64::from(year) - i64::from(month <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i32, u8, u8) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + i64::from(m <= 2);
    (year as i32, m as u8, d as u8)
}

impl PartialOrd for Date {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Date {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.epoch_millis
            .cmp(&other.epoch_millis)
            .then(self.precision.cmp(&other.precision))
    }
}

impl std::fmt::Display for Date {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.canonical)
    }
}

impl Serialize for Date {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.canonical)
    }
}

impl<'de> Deserialize<'de> for Date {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Date::parse(&raw).map_err(|e| D::Error::custom(format!("{raw:?}: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_only_canonicalizes() {
        let d = Date::parse("2026-09-23").unwrap();
        assert_eq!(d.canonical(), "2026-09-23");
        assert_eq!(d.precision(), DatePrecision::Date);
        assert_eq!(d.epoch_millis(), 1_790_121_600_000);
    }

    #[test]
    fn offsets_normalize_to_utc() {
        let a = Date::parse("2026-09-23T12:00:00+02:00").unwrap();
        assert_eq!(a.canonical(), "2026-09-23T10:00:00.000Z");
        let b = Date::parse("2026-09-23T10:00:00Z").unwrap();
        assert_eq!(a, b);
        let c = Date::parse("2026-09-23 10:00").unwrap();
        assert_eq!(c.canonical(), "2026-09-23T10:00:00.000Z");
    }

    #[test]
    fn invalid_calendar_dates_are_malformed() {
        for bad in [
            "2026-02-30",
            "2026-13-01",
            "2026-00-01",
            "2026-01-00",
            "2026-1-5",
            "26-01-05",
            "2026-01-05T25:00:00Z",
            "2026-01-05T10:61:00Z",
            "not a date",
            "",
        ] {
            assert!(Date::parse(bad).is_err(), "{bad:?} should not parse");
        }
        assert!(Date::parse("2024-02-29").is_ok());
        assert!(Date::parse("2100-02-29").is_err());
    }

    #[test]
    fn lexicographic_equals_chronological() {
        let mut dates: Vec<Date> = [
            "2026-09-23",
            "2026-09-23T00:00:00Z",
            "2026-09-22T23:00:00Z",
            "2026-09-23T10:00:00.500Z",
            "1970-01-01",
            "0001-01-01",
            "9999-12-31",
        ]
        .iter()
        .map(|s| Date::parse(s).unwrap())
        .collect();
        dates.sort();
        let by_canonical = {
            let mut copy = dates.clone();
            copy.sort_by(|a, b| a.canonical.cmp(&b.canonical));
            copy
        };
        assert_eq!(dates, by_canonical);
    }

    #[test]
    fn epoch_round_trip() {
        for s in ["2026-09-23T10:00:00.123Z", "1970-01-01T00:00:00.000Z"] {
            let d = Date::parse(s).unwrap();
            let back = Date::from_epoch_millis(d.epoch_millis()).unwrap();
            assert_eq!(back.canonical(), s);
        }
    }

    #[test]
    fn canonical_shape_matches_canonical_output() {
        for s in ["2026-09-23", "2026-09-23T10:00:00.000Z"] {
            assert!(is_canonical_shape(s));
        }
        for s in [
            "2026-09-23T10:00:00Z",
            "2026-09-23T10:00:00.00Z",
            "2026-09-23 10:00:00.000Z",
            "2026-09-2",
            "",
        ] {
            assert!(!is_canonical_shape(s), "{s:?}");
        }
    }
}

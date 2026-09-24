/**
 * Day arithmetic and bucketing: the pure half of the *dated* agenda.
 *
 * # Why no date library, and no `Date` arithmetic
 *
 * A bucket boundary is a **civil day**, not an instant. `new Date("2026-09-24")` is
 * midnight UTC, `new Date("2026-09-24T23:30")` is midnight *local*, and adding
 * `86_400_000` milliseconds to either crosses a DST boundary twice a year in the wrong
 * direction — which shows up as "Tomorrow" appearing twice, in March, for one user. So the
 * whole of this file works on `YYYY-MM-DD` strings and integer day counts, with the same
 * hand-rolled civil-date arithmetic the shared Rust core uses for exactly this reason
 * (SPEC §3.4: dates are ISO-8601 strings normalized to a canonical form so lexicographic
 * sort is correct).
 *
 * The one place a real clock is read is {@link todayKey}, which takes the local date from
 * the host and is the only impure function here. Everything else is a function of its
 * arguments, which is what makes the buckets testable without freezing time.
 *
 * # What counts as a date
 *
 * `fm.date` is whatever a human typed, materialized by the core. It may be a date
 * (`2026-09-24`), a datetime (`2026-09-24T09:30:00Z`), or nonsense. {@link dateKeyOf}
 * takes the leading `YYYY-MM-DD` when there is one and reports `undefined` otherwise — an
 * unparseable value drops the row from the agenda rather than guessing a day for it, and
 * {@link timeOfDay} keeps the `HH:MM` when the value carried one, which is the only reason
 * the agenda can order two things on the same day.
 */

/** A `YYYY-MM-DD` calendar day. The agenda's bucket key and its sort key. */
export type DayKey = string;

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/;

/** Days in `month` (1-based) of `year`, proleptic Gregorian. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Days since 1970-01-01 for a civil date — Howard Hinnant's `days_from_civil`, which is
 * the same algorithm the Rust core uses. Branch-free, correct before 1970, and it never
 * touches a time zone.
 */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The inverse of {@link daysFromCivil}. */
export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return { year: month <= 2 ? y + 1 : y, month, day };
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** `{2026, 9, 24}` → `"2026-09-24"`. */
export function formatDay(year: number, month: number, day: number): DayKey {
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

/** The leading calendar day of an `fm` value, or `undefined` when there is not one. */
export function dateKeyOf(value: unknown): DayKey | undefined {
  if (typeof value !== "string") return undefined;
  const match = DAY_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // A syntactically valid but impossible date (`2026-02-31`) is not a day. Accepting it
  // would put a row in a bucket whose heading is a date that does not exist.
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  return formatDay(year, month, day);
}

/** `"09:30"` when the value carried a time, else `undefined`. */
export function timeOfDay(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = TIME_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  return `${pad(hour)}:${pad(minute)}`;
}

/** `dayKey + offset` days. */
export function addDays(key: DayKey, offset: number): DayKey {
  const parsed = dateKeyOf(key);
  if (!parsed) return key;
  const [year, month, day] = parsed.split("-").map(Number) as [number, number, number];
  const shifted = civilFromDays(daysFromCivil(year, month, day) + offset);
  return formatDay(shifted.year, shifted.month, shifted.day);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function dayDifference(from: DayKey, to: DayKey): number {
  const a = dateKeyOf(from);
  const b = dateKeyOf(to);
  if (!a || !b) return 0;
  const [ay, am, ad] = a.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = b.split("-").map(Number) as [number, number, number];
  return daysFromCivil(by, bm, bd) - daysFromCivil(ay, am, ad);
}

/**
 * Today, in the viewer's own time zone.
 *
 * Local rather than UTC deliberately: "Today" is a word about the user's day, and a UTC
 * boundary would move somebody's agenda at 01:00 in Europe and at 19:00 in New York.
 * Impure by nature, which is why nothing else in this file reads a clock.
 */
export function todayKey(now: Date = new Date()): DayKey {
  return formatDay(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

const WEEKDAYS = ["Thursday", "Friday", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The weekday of a day key. 1970-01-01 was a Thursday, which is where the table starts. */
export function weekdayOf(key: DayKey): string {
  const parsed = dateKeyOf(key);
  if (!parsed) return "";
  const [year, month, day] = parsed.split("-").map(Number) as [number, number, number];
  const days = daysFromCivil(year, month, day);
  // `%` is remainder, not modulo: a negative day count (a date before 1970) would index
  // off the front of the table.
  const index = ((days % 7) + 7) % 7;
  return WEEKDAYS[index] ?? "";
}

/**
 * The heading one bucket gets, relative to `today`.
 *
 * `Today`/`Tomorrow`/`Yesterday` are named; anything else says the weekday and the date,
 * because "Thursday" alone is ambiguous past a week and a bare date takes a moment to read.
 */
export function labelForDay(key: DayKey, today: DayKey): string {
  const offset = dayDifference(today, key);
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset === -1) return "Yesterday";
  const parsed = dateKeyOf(key);
  if (!parsed) return key;
  const [year, month, day] = parsed.split("-").map(Number) as [number, number, number];
  const monthName = MONTHS[month - 1] ?? String(month);
  const sameYear = parsed.slice(0, 4) === today.slice(0, 4);
  const date = sameYear ? `${day} ${monthName}` : `${day} ${monthName} ${year}`;
  return `${weekdayOf(key)} ${date}`;
}

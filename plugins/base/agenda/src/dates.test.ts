/**
 * Civil-date arithmetic and the bucket labels.
 *
 * The cases that earn their place are the ones a `Date`-based implementation gets wrong:
 * a leap day, a century that is not a leap year, a month boundary, a year boundary, and a
 * date before 1970 (where `%` on a negative day count indexes off the front of the weekday
 * table). Everything here is a pure function of its arguments — only {@link todayKey} reads
 * a clock, and it is given one.
 */

import { describe, expect, it } from "vitest";

import {
  addDays,
  civilFromDays,
  dateKeyOf,
  dayDifference,
  daysFromCivil,
  daysInMonth,
  formatDay,
  isLeapYear,
  labelForDay,
  timeOfDay,
  todayKey,
  weekdayOf,
} from "./dates.js";

describe("civil-date arithmetic", () => {
  it("knows the epoch and round-trips through it", () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(civilFromDays(0)).toEqual({ year: 1970, month: 1, day: 1 });
    for (const days of [-100_000, -1, 0, 1, 19_000, 100_000]) {
      const { year, month, day } = civilFromDays(days);
      expect(daysFromCivil(year, month, day)).toBe(days);
    }
  });

  it("handles leap years the way the Gregorian calendar does", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2025-02-28", 1)).toBe("2025-03-01");
  });

  it("crosses month and year boundaries in both directions", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(dayDifference("2025-12-31", "2026-01-01")).toBe(1);
    expect(dayDifference("2026-01-01", "2025-12-31")).toBe(-1);
    expect(dayDifference("2026-09-24", "2026-09-24")).toBe(0);
  });

  it("formats with zero padding", () => {
    expect(formatDay(2026, 1, 2)).toBe("2026-01-02");
  });
});

describe("dateKeyOf", () => {
  it("takes the leading day of a date or a datetime", () => {
    expect(dateKeyOf("2026-09-24")).toBe("2026-09-24");
    expect(dateKeyOf("2026-09-24T09:30:00Z")).toBe("2026-09-24");
    expect(dateKeyOf(" 2026-09-24 09:30 ")).toBe("2026-09-24");
  });

  it("refuses anything that is not a calendar day", () => {
    expect(dateKeyOf("2026-02-31")).toBeUndefined();
    expect(dateKeyOf("2026-13-01")).toBeUndefined();
    expect(dateKeyOf("next tuesday")).toBeUndefined();
    expect(dateKeyOf("26-09-24")).toBeUndefined();
    expect(dateKeyOf(20_260_924)).toBeUndefined();
    expect(dateKeyOf(undefined)).toBeUndefined();
    expect(dateKeyOf(["2026-09-24"])).toBeUndefined();
  });
});

describe("timeOfDay", () => {
  it("keeps an HH:MM when the value carried one", () => {
    expect(timeOfDay("2026-09-24T09:30:00Z")).toBe("09:30");
    expect(timeOfDay("2026-09-24 23:05")).toBe("23:05");
  });

  it("reports none for a bare day or an impossible time", () => {
    expect(timeOfDay("2026-09-24")).toBeUndefined();
    expect(timeOfDay("2026-09-24T25:00")).toBeUndefined();
    expect(timeOfDay("2026-09-24T09:61")).toBeUndefined();
  });
});

describe("weekdayOf", () => {
  it("names the day, including before the epoch", () => {
    expect(weekdayOf("1970-01-01")).toBe("Thursday");
    expect(weekdayOf("2026-09-24")).toBe("Thursday");
    expect(weekdayOf("2026-09-25")).toBe("Friday");
    // A negative day count: the remainder has to be folded back into range.
    expect(weekdayOf("1969-12-31")).toBe("Wednesday");
  });
});

describe("labelForDay", () => {
  const today = "2026-09-24";

  it("names the three days worth naming", () => {
    expect(labelForDay(today, today)).toBe("Today");
    expect(labelForDay("2026-09-25", today)).toBe("Tomorrow");
    expect(labelForDay("2026-09-23", today)).toBe("Yesterday");
  });

  it("gives a weekday and a date for everything else, with the year only when it differs", () => {
    expect(labelForDay("2026-09-28", today)).toBe("Monday 28 September");
    expect(labelForDay("2027-01-04", today)).toBe("Monday 4 January 2027");
  });
});

describe("todayKey", () => {
  it("reads the local civil date, not the UTC one", () => {
    // 23:30 on the 24th in a zone ahead of UTC is still the 24th locally; taking the UTC
    // date here is how "Today" ends up empty for half the day.
    const local = new Date(2026, 8, 24, 23, 30, 0);
    expect(todayKey(local)).toBe("2026-09-24");
  });
});

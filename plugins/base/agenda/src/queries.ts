/**
 * The two projection queries the agenda runs, and the one non-obvious thing about them.
 *
 * # The task prefilter has to be *sound*, not clever
 *
 * Finding task lists means looking at document **text**, and the filter DSL has no regular
 * expressions (SPEC §4.2 — deliberately: the same JSON is evaluated by the Wasm core on the
 * client and compiled to Mongo on the server). So the query narrows and
 * {@link import("./tasks.js").scanTasks} decides.
 *
 * That makes one property load-bearing: the filter may return documents with no tasks (the
 * scanner drops them, costing a little work), but it must **never** miss a document that
 * has one — a false negative is a task that silently does not exist, and nothing on screen
 * says so.
 *
 * The chosen condition is the one part of GFM's task syntax that is fixed-width: a task's
 * `]` is always followed by a space or a tab (`markdown`'s `markerAt`, and `tasks.ts`'s
 * `taskOnLine`, both require it). Everything *before* the bracket is variable — `-`, `*`,
 * `+`, `12.`, `3)`, then one or more spaces or tabs — so `"- ["` would miss `"-   [ ] milk"`,
 * which is a real, common, valid task line. `"] "` cannot miss anything the scanner accepts,
 * which is why it is what the filter asks for, and {@link matchesTaskPrefilter} is the
 * predicate the soundness test compares against the scanner.
 */

import type { DocumentQuery, FilterJson } from "@kernel";

import { addDays, type DayKey } from "./dates.js";
import { scanTasks, type TaskStateLike } from "./tasks.js";

/** Rows one agenda query may return — a bound, not a page: this is a glance, not a browser. */
export const ROW_LIMIT = 500;

/** The two characters GFM allows after a task's closing bracket. */
export const AFTER_BRACKET = [" ", "\t"] as const;

/**
 * Documents that *might* contain a task list.
 *
 * `text.contains` is case-insensitive in both engines, which is irrelevant for punctuation
 * and is the reason this clause is stable across the client evaluator and the Mongo
 * compiler.
 */
export const TASK_PREFILTER: FilterJson = {
  or: AFTER_BRACKET.map((suffix) => ({
    text: { field: "content", mode: "contains", value: `]${suffix}` },
  })),
};

/**
 * Documents dated inside the rendered window, `[today, today + horizonDays]`.
 *
 * `lt` an exclusive day rather than `lte` the last day, for the same reason the calendar
 * plugin's `windowFilter` does it: `fm.date` is canonicalized at materialization (SPEC §3.4),
 * so a timed event is `2026-10-11T09:00:00.000Z`, which is *greater* than `"2026-10-11"` —
 * an `lte` bound would silently drop every timed row on the last day of the horizon.
 */
export function horizonFilter(today: DayKey, horizonDays: number): FilterJson {
  const days = Math.max(0, Math.trunc(horizonDays));
  return {
    and: [
      { cmp: { field: "fm.date", op: "gte", value: { date: today } } },
      { cmp: { field: "fm.date", op: "lt", value: { date: addDays(today, days + 1) } } },
    ],
  };
}

/** Documents dated before `today` — the Overdue bucket's input. */
export function overdueFilter(today: DayKey): FilterJson {
  return { cmp: { field: "fm.date", op: "lt", value: { date: today } } };
}

/**
 * The same condition {@link TASK_PREFILTER} expresses, in TypeScript.
 *
 * Exists for `queries.test.ts`, which asserts the implication that matters — every text the
 * scanner finds a task in also matches this — so a future narrowing of the filter cannot
 * quietly start hiding tasks.
 */
export function matchesTaskPrefilter(text: string): boolean {
  return AFTER_BRACKET.some((suffix) => text.toLowerCase().includes(`]${suffix}`));
}

/** True when the scanner finds at least one *registered* task in `text`. */
export function hasRegisteredTask(text: string, states: readonly TaskStateLike[]): boolean {
  return scanTasks(text, states).some((task) => task.registered);
}

/**
 * The task query. Sorted by title so the result is stable between runs; the grouping
 * re-sorts anyway, and `content` is not a sortable field in either engine.
 */
export function taskQuery(limit: number = ROW_LIMIT): DocumentQuery {
  return {
    filter: TASK_PREFILTER,
    sort: [{ field: "title", direction: "asc" }],
    limit,
  };
}

/**
 * The horizon query: everything dated from today to the end of the horizon, ascending.
 *
 * **Bounded by date, not only by row count.** An unbounded `exists fm.date` sorted ascending
 * asks for the *oldest* dated documents in the workspace, which is the exact opposite of what
 * a panel titled "what is coming up" needs. Past the row limit — and the calendar's ICS
 * import makes that the normal case, since it writes one document per VEVENT including a
 * year of history — every returned row fell before today, so Today and Tomorrow rendered
 * empty while Overdue held 500 rows and a footnote said "Showing 500 of 2500". A bigger limit
 * would not have fixed it; the query was asking the wrong question.
 *
 * With the bound, the window is *complete* rather than truncated at whatever the limit is:
 * `limit` becomes a sanity cap on a fortnight of documents instead of the thing that decides
 * what the user sees.
 */
export function horizonQuery(
  today: DayKey,
  horizonDays: number,
  limit: number = ROW_LIMIT,
): DocumentQuery {
  return {
    filter: horizonFilter(today, horizonDays),
    sort: [{ field: "fm.date", direction: "asc" }],
    limit,
  };
}

/**
 * The overdue query: everything dated before today, **descending**.
 *
 * Descending is the load-bearing half. Overdue has no lower bound — a thing missed three
 * months ago is still missed — so this query is the one that can genuinely exceed the row
 * limit, and when it does the rows worth keeping are the *most recent* ones. Ascending would
 * have handed back the oldest 500 and hidden yesterday behind them. `groupsOf` re-sorts the
 * bucket oldest-first for display; that is a presentation choice and independent of which 500
 * rows arrive.
 */
export function overdueQuery(today: DayKey, limit: number = ROW_LIMIT): DocumentQuery {
  return {
    filter: overdueFilter(today),
    sort: [{ field: "fm.date", direction: "desc" }],
    limit,
  };
}

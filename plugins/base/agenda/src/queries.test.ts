/**
 * The queries, and the one property the task view's correctness rests on.
 *
 * **Soundness, not selectivity.** The prefilter narrowing the task query may return
 * documents with no tasks — the scanner drops them — but a document it *misses* is a task
 * that silently does not exist anywhere in the UI. So the test that matters is the
 * implication: every text `scanTasks` finds a marker in also matches the filter. It is
 * asserted over the same fixture shapes `tasks.test.ts` uses, including the ones a naive
 * `"- ["` filter would lose.
 */

import { describe, expect, it } from "vitest";

import {
  TASK_PREFILTER,
  hasRegisteredTask,
  horizonFilter,
  horizonQuery,
  matchesTaskPrefilter,
  overdueFilter,
  overdueQuery,
  taskQuery,
  ROW_LIMIT,
} from "./queries.js";
import { scanTasks, type TaskStateLike } from "./tasks.js";

const STATES: readonly TaskStateLike[] = [
  { marker: " ", label: "To do", done: false },
  { marker: "x", label: "Done", done: true },
  { marker: "/", label: "In progress" },
];

const WITH_TASKS = [
  "- [ ] plain",
  "-   [x] several spaces before the checkbox",
  "-\t[ ] a tab before the checkbox",
  "* [x] star bullet",
  "+ [/] plus bullet",
  "12. [ ] ordered with a dot",
  "3) [x] ordered with a paren",
  "    - [ ] deeply indented sub-task",
  "prose above\n\n- [ ] and a task below\n",
  "- [?] unregistered, still a marker",
  "- [x]\ttab after the checkbox",
];

const WITHOUT_TASKS = [
  "",
  "just prose",
  "- [ ]",
  "- [] empty brackets",
  "-[x] no space after the bullet",
  "[ ] no bullet at all",
  "see [1] and [2]",
];

describe("the task prefilter is sound", () => {
  it("matches every text the scanner finds a marker in", () => {
    for (const text of WITH_TASKS) {
      expect(scanTasks(text, STATES).length, text).toBeGreaterThan(0);
      expect(matchesTaskPrefilter(text), text).toBe(true);
    }
  });

  it("would have been unsound as a bullet-plus-bracket match", () => {
    // The case the module docs name: a valid task line that `"- ["` does not contain. This
    // test exists so the filter is never "simplified" back to that.
    const roomy = "-   [ ] milk";
    expect(scanTasks(roomy, STATES)).toHaveLength(1);
    expect(roomy.includes("- [")).toBe(false);
    expect(matchesTaskPrefilter(roomy)).toBe(true);
  });

  it("is allowed to be imprecise in the harmless direction", () => {
    // `] ` appears in prose that is not a task. The scanner is what decides, so a false
    // positive costs one wasted scan and nothing else.
    expect(matchesTaskPrefilter("see [1] and nothing else")).toBe(true);
    expect(scanTasks("see [1] and nothing else", STATES)).toEqual([]);
  });

  it("does not match the non-task shapes that carry no bracket at all", () => {
    for (const text of WITHOUT_TASKS.filter((value) => !value.includes("] "))) {
      expect(matchesTaskPrefilter(text), text).toBe(false);
    }
  });

  it("hasRegisteredTask follows the registry, not the bracket", () => {
    expect(hasRegisteredTask("- [ ] milk", STATES)).toBe(true);
    expect(hasRegisteredTask("- [?] unknown", STATES)).toBe(false);
    expect(hasRegisteredTask("- [ ] milk", [])).toBe(false);
  });
});

describe("the emitted DSL", () => {
  it("asks about content with the two bracket suffixes GFM allows", () => {
    expect(TASK_PREFILTER).toEqual({
      or: [
        { text: { field: "content", mode: "contains", value: "] " } },
        { text: { field: "content", mode: "contains", value: "]\t" } },
      ],
    });
  });

  it("bounds every query and sorts on fields both engines can sort", () => {
    expect(taskQuery()).toEqual({
      filter: TASK_PREFILTER,
      sort: [{ field: "title", direction: "asc" }],
      limit: ROW_LIMIT,
    });
    expect(horizonQuery("2026-09-24", 14, 10)).toEqual({
      filter: horizonFilter("2026-09-24", 14),
      sort: [{ field: "fm.date", direction: "asc" }],
      limit: 10,
    });
    expect(overdueQuery("2026-09-24", 10)).toEqual({
      filter: overdueFilter("2026-09-24"),
      sort: [{ field: "fm.date", direction: "desc" }],
      limit: 10,
    });
  });

  /**
   * The bug this replaced: `{exists: fm.date}` ascending asks for the *oldest* dated
   * documents, so in a workspace with more than `ROW_LIMIT` of them — what the calendar's
   * first ICS import produces — every row came back before today and the panel whose job is
   * "what is coming up" showed nothing coming up.
   */
  it("bounds the horizon query by date, not just by row count", () => {
    const filter = horizonFilter("2026-09-24", 14) as {
      and: { cmp: { field: string; op: string; value: { date: string } } }[];
    };
    expect(filter.and).toHaveLength(2);
    expect(filter.and[0]?.cmp).toEqual({
      field: "fm.date",
      op: "gte",
      value: { date: "2026-09-24" },
    });
    // `lt` the day *after* the horizon: `2026-10-08T09:00:00.000Z` is greater than
    // `"2026-10-08"`, so an `lte` bound would drop every timed row on the last day.
    expect(filter.and[1]?.cmp).toEqual({
      field: "fm.date",
      op: "lt",
      value: { date: "2026-10-09" },
    });
  });

  it("asks the overdue query for the newest overdue rows, not the oldest", () => {
    expect(overdueFilter("2026-09-24")).toEqual({
      cmp: { field: "fm.date", op: "lt", value: { date: "2026-09-24" } },
    });
    // Descending is what makes the row limit cut off the distant past rather than yesterday.
    expect(overdueQuery("2026-09-24").sort).toEqual([{ field: "fm.date", direction: "desc" }]);
  });

  it("covers every day from today to the horizon between the two filters, with no gap or overlap", () => {
    const today = "2026-09-24";
    const horizon = horizonFilter(today, 14) as {
      and: { cmp: { op: string; value: { date: string } } }[];
    };
    const overdue = overdueFilter(today) as { cmp: { op: string; value: { date: string } } };
    // Overdue's exclusive upper bound is exactly the horizon's inclusive lower bound.
    expect(overdue.cmp.value.date).toBe(horizon.and[0]?.cmp.value.date);
    expect(overdue.cmp.op).toBe("lt");
    expect(horizon.and[0]?.cmp.op).toBe("gte");
  });
});

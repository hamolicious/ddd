/**
 * The dated buckets: what lands in `overdue`, what is dropped, and the order inside a day.
 *
 * `groupsOf` is the agenda's public API (`AgendaApi.groupsOf`), so these cases are also the
 * contract a dependent plugin can rely on.
 */

import { describe, expect, it } from "vitest";

import type { DocumentRow } from "@kernel";

import { groupsOf, OVERDUE_KEY, dayOf, timeOf } from "./upcoming.js";

const TODAY = "2026-09-24";

function row(id: string, title: string, date?: unknown): DocumentRow {
  return {
    id,
    title,
    content: "",
    fm: date === undefined ? {} : { date: date as never },
    plugins: {},
    fm_parse_error: false,
    materialized_version: "v",
    created_at: "2026-09-01T00:00:00Z",
    created_by: null,
    updated_at: "2026-09-01T00:00:00Z",
    updated_by: null,
    deleted: false,
    deleted_at: null,
    deleted_by: null,
    purged: false,
  };
}

describe("groupsOf", () => {
  it("puts everything before today in one overdue bucket, oldest first", () => {
    const groups = groupsOf(
      [row("a", "Late", "2026-09-20"), row("b", "Later", "2026-09-23"), row("c", "Now", TODAY)],
      TODAY,
      14,
    );
    expect(groups.map((group) => group.key)).toEqual([OVERDUE_KEY, TODAY]);
    expect(groups[0]!.label).toBe("Overdue");
    expect(groups[0]!.rows.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(groups[1]!.label).toBe("Today");
  });

  it("orders buckets forward in time and labels the near ones by name", () => {
    const groups = groupsOf(
      [row("c", "Third", "2026-09-28"), row("a", "First", TODAY), row("b", "Second", "2026-09-25")],
      TODAY,
      14,
    );
    expect(groups.map((group) => group.label)).toEqual(["Today", "Tomorrow", "Monday 28 September"]);
  });

  it("drops anything past the horizon, and produces no empty buckets", () => {
    const groups = groupsOf(
      [row("a", "Soon", "2026-09-26"), row("b", "Far", "2026-12-01")],
      TODAY,
      14,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("a zero horizon is today and the past, not everything", () => {
    const groups = groupsOf([row("a", "Today", TODAY), row("b", "Tomorrow", "2026-09-25")], TODAY, 0);
    expect(groups.map((group) => group.key)).toEqual([TODAY]);
  });

  it("drops rows with no usable fm.date rather than guessing a day", () => {
    const groups = groupsOf(
      [row("a", "No date"), row("b", "Nonsense", "soon"), row("c", "Impossible", "2026-02-31")],
      TODAY,
      14,
    );
    expect(groups).toEqual([]);
  });

  it("sorts timed items before untimed ones inside a day, then by title", () => {
    const groups = groupsOf(
      [
        row("a", "Whole day", TODAY),
        row("b", "Afternoon", `${TODAY}T14:00:00Z`),
        row("c", "Morning", `${TODAY}T09:30:00Z`),
        row("d", "Another whole day", TODAY),
      ],
      TODAY,
      14,
    );
    expect(groups[0]!.rows.map((entry) => entry.id)).toEqual(["c", "b", "d", "a"]);
  });

  it("is stable for two rows that are identical but for their id", () => {
    const pair = [row("b", "Same", TODAY), row("a", "Same", TODAY)];
    expect(groupsOf(pair, TODAY, 14)[0]!.rows.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(groupsOf([...pair].reverse(), TODAY, 14)[0]!.rows.map((entry) => entry.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("exposes the per-row day and time the list renders", () => {
    expect(dayOf(row("a", "x", `${TODAY}T09:30:00Z`))).toBe(TODAY);
    expect(timeOf(row("a", "x", `${TODAY}T09:30:00Z`))).toBe("09:30");
    expect(timeOf(row("a", "x", TODAY))).toBeUndefined();
  });
});

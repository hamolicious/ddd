import { describe, expect, it } from "vitest";

import type { DocumentRow } from "@kernel";

import { isoDay } from "../../_shared/dates.js";
import { layoutItems, timelineOptions, windowFor, withTimeline } from "./layout.js";

const note = (id: string, fm: DocumentRow["fm"]): DocumentRow =>
  ({ id, title: id, fm, created_at: "2026-09-10T12:00:00Z", updated_at: "2026-09-10T12:00:00Z" }) as DocumentRow;

const anchor = new Date(2026, 8, 30);

describe("the timeline", () => {
  it("defaults to points by created date, in weeks, and keeps defaults out of the options", () => {
    expect(timelineOptions({})).toEqual({ start: "created_at", end: "", group: "", scale: "week" });
    expect(timelineOptions({ scale: "fortnight" }).scale).toBe("week");
    expect(withTimeline(timelineOptions({}), { other: "x", start: "fm.date" })).toEqual({ other: "x" });
    expect(withTimeline({ start: "fm.from", end: "fm.to", group: "fm.status", scale: "month" }, {})).toEqual({
      start: "fm.from",
      end: "fm.to",
      group: "fm.status",
      scale: "month",
    });
  });

  it("starts each window on a boundary", () => {
    expect(isoDay(windowFor(anchor, "day").from)).toBe("2026-09-28");
    expect(windowFor(anchor, "day").units).toHaveLength(14);
    expect(isoDay(windowFor(anchor, "week").from)).toBe("2026-09-14");
    expect(isoDay(windowFor(anchor, "month").from)).toBe("2026-07-01");
  });

  it("draws a bar to the end field's day, inclusive, and a point without one", () => {
    const settings = timelineOptions({ start: "fm.from", end: "fm.to", scale: "day" });
    const [lane] = layoutItems(
      [note("bar", { from: "2026-09-28", to: "2026-09-28" }), note("dot", { from: "2026-09-30" })],
      settings,
      windowFor(anchor, "day"),
    );
    const items = lane?.rows.flat() ?? [];
    const bar = items.find((item) => item.row.id === "bar");
    expect(bar?.point).toBe(false);
    expect(bar && bar.right - bar.left).toBeCloseTo(1 / 14);
    expect(items.find((item) => item.row.id === "dot")?.point).toBe(true);
  });

  it("splits into lanes by the group field, list values in each, the ungrouped last", () => {
    const lanes = layoutItems(
      [note("a", { from: "2026-09-29", tags: ["x", "y"] }), note("b", { from: "2026-09-29", tags: "x" }), note("c", { from: "2026-09-29" })],
      timelineOptions({ start: "fm.from", group: "fm.tags", scale: "day" }),
      windowFor(anchor, "day"),
    );
    expect(lanes.map((lane) => lane.name)).toEqual(["x", "y", undefined]);
    expect(lanes[0]?.rows.flat().map((item) => item.row.id).sort()).toEqual(["a", "b"]);
  });

  it("packs overlapping notes into separate rows and leaves out what is outside", () => {
    const [lane] = layoutItems(
      [
        note("a", { from: "2026-09-28", to: "2026-10-02" }),
        note("b", { from: "2026-09-29", to: "2026-09-30" }),
        note("c", { from: "2026-10-05", to: "2026-10-06" }),
        note("old", { from: "2025-01-01", to: "2025-01-02" }),
      ],
      timelineOptions({ start: "fm.from", end: "fm.to", scale: "day" }),
      windowFor(anchor, "day"),
    );
    expect(lane?.rows.map((row) => row.map((item) => item.row.id))).toEqual([["a", "c"], ["b"]]);
  });
});

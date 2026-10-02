import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { deepEqual, ulidForIndex } from "./core.js";
import {
  applyOp,
  frontmatterEnd,
  markersIn,
  regions,
  safeDeleteSpan,
  safeInsertIndex,
  sectionsStartIndex,
  seedDocumentText,
  spliceFrontmatterValue,
  spliceSectionLine,
  TEXT_ROOT,
} from "./ops.js";
import { parseMetrics } from "./rest.js";
import { parseArgs, rng } from "./scenario.js";

function docWith(text: string): Y.Text {
  const doc = new Y.Doc();
  const ytext = doc.getText(TEXT_ROOT);
  ytext.insert(0, text);
  return ytext;
}

const SAMPLE = [
  "---",
  "title: Groceries",
  "path: home/lists",
  "date: 2026-09-23",
  "---",
  "",
  "# Groceries",
  "",
  "- [ ] milk",
  "",
  "%%% calendar",
  "source-uid: abc123",
  "revision: 1",
  "%%%",
  "",
].join("\n");

describe("regions", () => {
  it("locates frontmatter only when `---` is the literal first line", () => {
    expect(SAMPLE.slice(frontmatterEnd(SAMPLE))).toBe("\n# Groceries\n\n- [ ] milk\n\n%%% calendar\nsource-uid: abc123\nrevision: 1\n%%%\n");
    expect(frontmatterEnd("no frontmatter here")).toBe(0);
    expect(frontmatterEnd("---\ntitle: x\n")).toBe(0);
  });

  it("locates the trailing `%%%` run and nothing earlier", () => {
    expect(sectionsStartIndex(SAMPLE)).toBe(SAMPLE.indexOf("%%% calendar"));
    expect(sectionsStartIndex("body only\n")).toBe("body only\n".length);
    const notASection = "%%% calendar\nkey: 1\n%%%\n\nmore body\n";
    expect(sectionsStartIndex(notASection)).toBe(notASection.length);
  });

  it("puts the body between the two", () => {
    const { bodyStart, bodyEnd } = regions(SAMPLE);
    expect(SAMPLE.slice(bodyStart, bodyEnd)).toContain("# Groceries");
    expect(SAMPLE.slice(bodyStart, bodyEnd)).not.toContain("%%%");
    expect(SAMPLE.slice(bodyStart, bodyEnd)).not.toContain("title:");
  });
});

describe("frontmatter splices (SPEC §3.3)", () => {
  it("replaces only the value span, leaving the rest of the block byte-identical", () => {
    const text = docWith(SAMPLE);
    spliceFrontmatterValue(text, "path", "work/inbox");
    const after = text.toString();
    expect(after).toContain("path: work/inbox");
    expect(after.replace("work/inbox", "home/lists")).toBe(SAMPLE);
  });

  it("adds a missing key as one line before the closing `---`", () => {
    const text = docWith(SAMPLE);
    spliceFrontmatterValue(text, "status", "open");
    const after = text.toString();
    expect(after).toMatch(/status: open\n---\n/);
    expect(frontmatterEnd(after)).toBeGreaterThan(frontmatterEnd(SAMPLE));
  });

  it("refuses a document without a frontmatter block", () => {
    const text = docWith("# just a body\n");
    expect(spliceFrontmatterValue(text, "title", "x")).toBe(false);
    expect(text.toString()).toBe("# just a body\n");
  });
});

describe("`%%%` section line splices (SPEC §3.3)", () => {
  it("rewrites one line, not the section", () => {
    const text = docWith(SAMPLE);
    spliceSectionLine(text, "calendar", "revision", "2");
    const after = text.toString();
    expect(after).toContain("source-uid: abc123");
    expect(after).toContain("revision: 2");
    expect(after.split("revision:").length - 1).toBe(1);
  });

  it("adds a missing key before the closing fence", () => {
    const text = docWith(SAMPLE);
    spliceSectionLine(text, "calendar", "checked-at", "2026-09-24");
    expect(text.toString()).toMatch(/checked-at: 2026-09-24\n%%%\n/);
  });

  it("appends a whole section when the plugin has none", () => {
    const text = docWith(SAMPLE);
    spliceSectionLine(text, "harness", "revision", "1");
    const after = text.toString();
    expect(after).toContain("%%% harness\nrevision: 1\n%%%");
    expect(sectionsStartIndex(after)).toBe(after.indexOf("%%% calendar"));
  });
});

describe("marker safety (the update-loss invariant)", () => {
  it("never returns an index inside a marker", () => {
    const text = "a {{c1#1}} b";
    for (let index = 0; index <= text.length; index += 1) {
      const safe = safeInsertIndex(text, index);
      const inside = safe > text.indexOf("{{") && safe < text.indexOf("}}") + 2;
      expect(inside).toBe(false);
    }
  });

  it("never returns a delete span overlapping a marker", () => {
    const text = "aaa {{c1#1}} bbb";
    for (let index = 0; index < text.length; index += 1) {
      const span = safeDeleteSpan(text, index, 8, 0, text.length);
      if (!span) continue;
      const slice = text.slice(span.start, span.start + span.length);
      expect(slice).not.toMatch(/[{}]/);
    }
  });

  it("preserves every marker across a long randomized run", () => {
    const text = docWith(SAMPLE);
    const random = rng(42);
    const written: string[] = [];
    for (let index = 1; index <= 400; index += 1) {
      const record = applyOp(text, "01J8ZQ0M3M4YQV0X0PTN9R2G7C", "c1", index, random);
      if (record.marker && record.applied) written.push(record.marker);
    }
    const present = markersIn(text.toString());
    expect(written.length).toBeGreaterThan(50);
    for (const marker of written) {
      expect(present.filter((candidate) => candidate === marker)).toHaveLength(1);
    }
  });

  it("concurrent replicas converge byte-identically and keep both sets of markers", () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    left.getText(TEXT_ROOT).insert(0, SAMPLE);
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));

    const leftRandom = rng(7);
    const rightRandom = rng(9);
    const leftMarkers: string[] = [];
    const rightMarkers: string[] = [];
    for (let index = 1; index <= 60; index += 1) {
      const a = applyOp(left.getText(TEXT_ROOT), "d", "c1", index, leftRandom);
      const b = applyOp(right.getText(TEXT_ROOT), "d", "c2", index, rightRandom);
      if (a.marker && a.applied) leftMarkers.push(a.marker);
      if (b.marker && b.applied) rightMarkers.push(b.marker);
    }

    Y.applyUpdate(left, Y.encodeStateAsUpdate(right, Y.encodeStateVector(left)));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left, Y.encodeStateVector(right)));

    const merged = left.getText(TEXT_ROOT).toString();
    expect(merged).toBe(right.getText(TEXT_ROOT).toString());
    const present = markersIn(merged);
    for (const marker of [...leftMarkers, ...rightMarkers]) {
      expect(present).toContain(marker);
    }
  });
});

describe("determinism", () => {
  it("rng is reproducible and seed-sensitive", () => {
    const first = Array.from({ length: 5 }, rng(3));
    const second = Array.from({ length: 5 }, rng(3));
    const other = Array.from({ length: 5 }, rng(4));
    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
  });

  it("mints the same valid ULID for the same index", () => {
    expect(ulidForIndex(17)).toBe(ulidForIndex(17));
    expect(ulidForIndex(17)).not.toBe(ulidForIndex(18));
    expect(ulidForIndex(17, 5)).not.toBe(ulidForIndex(17, 6));
    expect(ulidForIndex(0)).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it("seed documents carry all three regions", () => {
    const text = seedDocumentText(3, rng(3));
    expect(frontmatterEnd(text)).toBeGreaterThan(0);
    expect(sectionsStartIndex(text)).toBeLessThan(text.length);
    expect(text).toContain("- [ ]");
  });

  it("parses flags over the defaults", () => {
    const config = parseArgs(["--clients=7", "--seed=99", "--journal=/tmp/x.json"]);
    expect(config.clients).toBe(7);
    expect(config.seed).toBe(99);
    expect(config.documents).toBe(25);
  });
});

describe("support code", () => {
  it("sums prometheus samples by metric name and skips buckets", () => {
    const metrics = parseMetrics(
      [
        "# HELP ddd_http_requests_total requests",
        "# TYPE ddd_http_requests_total counter",
        'ddd_http_requests_total{route="/api/documents",status="200"} 12',
        'ddd_http_requests_total{route="/api/sync",status="101"} 3',
        'ddd_materialize_duration_seconds_bucket{le="0.1"} 99',
        "ddd_materialize_duration_seconds_count 7",
        "ddd_rooms 2",
      ].join("\n"),
    );
    expect(metrics["ddd_http_requests_total"]).toBe(15);
    expect(metrics["ddd_materialize_duration_seconds_count"]).toBe(7);
    expect(metrics["ddd_rooms"]).toBe(2);
    expect(metrics["ddd_materialize_duration_seconds_bucket"]).toBeUndefined();
  });

  it("deep-equals the shared-core value model", () => {
    expect(deepEqual({ a: [1, "x", null] }, { a: [1, "x", null] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: { b: [1] } }, { a: { b: [2] } })).toBe(false);
    expect(deepEqual(1, "1")).toBe(false);
  });
});

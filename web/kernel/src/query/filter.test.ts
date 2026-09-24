/**
 * `compareRows` against `core::filter::evaluator::compare_rows`.
 *
 * Sorting is the one piece of query semantics the client implements itself
 * (web/CONTRACTS.md), so it is the one piece that can silently disagree with the
 * server. The corpus's `sorts` block is the same fixture
 * `backend/crates/core/tests/conformance.rs` checks the Rust side against, read
 * from the same file — so "the orders are identical" is a test, not a hope.
 */

import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import type { CoreMap, ProjectionRow } from "../protocol.js";
import { compareRows, compareStrings, parseSortKey, resolvePath } from "./filter.js";

interface CorpusRow {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly fm: CoreMap;
  readonly plugins: CoreMap;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted: boolean;
}

interface SortCase {
  readonly name: string;
  readonly keys: readonly string[];
  readonly order: readonly string[];
}

/** Fill the projection fields the corpus rows do not carry. */
function projection(row: CorpusRow): ProjectionRow {
  return {
    ...row,
    fm_parse_error: false,
    materialized_version: "0",
    created_by: null,
    updated_by: null,
    deleted_at: row.deleted ? row.updated_at : null,
    deleted_by: null,
    purged: false,
  };
}

const row = (id: string, fields: Partial<ProjectionRow> = {}): ProjectionRow => ({
  id,
  title: "",
  content: "",
  fm: {},
  plugins: {},
  fm_parse_error: false,
  materialized_version: "0",
  created_at: "2026-01-01T00:00:00.000Z",
  created_by: null,
  updated_at: "2026-01-01T00:00:00.000Z",
  updated_by: null,
  deleted: false,
  deleted_at: null,
  deleted_by: null,
  purged: false,
  ...fields,
});

describe("compareRows against the shared-core corpus", () => {
  let rows: ProjectionRow[];
  let sorts: readonly SortCase[];

  beforeAll(async () => {
    const corpus = JSON.parse(
      await readFile(
        new URL("../../../../backend/crates/core/corpus/filters.json", import.meta.url),
        "utf8",
      ),
    ) as { rows: CorpusRow[]; sorts: SortCase[] };
    rows = corpus.rows.map(projection);
    sorts = corpus.sorts;
  });

  it("covers every sort case the corpus declares", () => {
    expect(sorts.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const testCase of sorts) {
      const keys = testCase.keys.map(parseSortKey);
      // Shuffled first: a comparator that happens to agree with input order
      // proves nothing.
      const shuffled = [...rows].reverse();
      const sorted = shuffled.sort((a, b) => compareRows(a, b, keys)).map((r) => r.id);
      if (sorted.join(",") !== [...testCase.order].join(",")) {
        failures.push(`${testCase.name}: got [${sorted}], want [${testCase.order}]`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("is a total order: antisymmetric and transitive over the corpus", () => {
    const keys = [parseSortKey("fm.n"), parseSortKey("-title")];
    for (const a of rows) {
      for (const b of rows) {
        expect(Math.sign(compareRows(a, b, keys)) + Math.sign(compareRows(b, a, keys))).toBe(0);
      }
    }
    for (const a of rows) {
      for (const b of rows) {
        for (const c of rows) {
          if (compareRows(a, b, keys) <= 0 && compareRows(b, c, keys) <= 0) {
            expect(compareRows(a, c, keys)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });
});

describe("compareRows", () => {
  it("falls back to id ascending with no sort keys", () => {
    const sorted = [row("c"), row("a"), row("b")].sort((a, b) => compareRows(a, b, [])).map((r) => r.id);
    expect(sorted).toEqual(["a", "b", "c"]);
  });

  it("sorts missing last in both directions", () => {
    const keys = parseSortKey("fm.k");
    const present = row("a", { fm: { k: "v" } });
    const missing = row("b");
    expect(compareRows(present, missing, [keys])).toBeLessThan(0);
    expect(compareRows(present, missing, [parseSortKey("-fm.k")])).toBeLessThan(0);
  });

  it("ranks by value type: null < bool < number < string < list < map", () => {
    const ordered = [
      row("1", { fm: { k: null } }),
      row("2", { fm: { k: false } }),
      row("3", { fm: { k: 7 } }),
      row("4", { fm: { k: "s" } }),
      row("5", { fm: { k: ["s"] } }),
      row("6", { fm: { k: { s: 1 } } }),
    ];
    const keys = [parseSortKey("fm.k")];
    const shuffled = [ordered[3], ordered[0], ordered[5], ordered[1], ordered[4], ordered[2]] as ProjectionRow[];
    expect(shuffled.sort((a, b) => compareRows(a, b, keys)).map((r) => r.id)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
  });

  it("orders lists elementwise, then by length", () => {
    const keys = [parseSortKey("fm.k")];
    expect(compareRows(row("a", { fm: { k: [1, 2] } }), row("b", { fm: { k: [1, 3] } }), keys)).toBeLessThan(0);
    expect(compareRows(row("a", { fm: { k: [1] } }), row("b", { fm: { k: [1, 0] } }), keys)).toBeLessThan(0);
  });

  it("orders maps by key, then value, then size — BTreeMap order, not insertion order", () => {
    const keys = [parseSortKey("fm.k")];
    const inserted = row("a", { fm: { k: { b: 1, a: 1 } } });
    const sorted = row("b", { fm: { k: { a: 1, b: 2 } } });
    // Both maps start at key "a" with value 1; "b" decides, and 1 < 2.
    expect(compareRows(inserted, sorted, keys)).toBeLessThan(0);
  });

  it("orders timestamps chronologically without parsing them", () => {
    const keys = [parseSortKey("-updated_at")];
    const older = row("a", { updated_at: "2026-01-01T00:00:00.000Z" });
    const newer = row("b", { updated_at: "2026-03-01T00:00:00.000Z" });
    expect(compareRows(newer, older, keys)).toBeLessThan(0);
  });

  it("treats roots the shared core does not know as missing", () => {
    // `resolve_field` knows id/title/content/deleted/created_at/updated_at/fm/plugins
    // and nothing else, so neither side can order by these — and the client must
    // not invent an order the server cannot reproduce.
    const keys = [parseSortKey("deleted_at")];
    const a = row("a", { deleted: true, deleted_at: "2026-05-05T00:00:00.000Z" });
    const b = row("b", { deleted: true, deleted_at: "2026-01-01T00:00:00.000Z" });
    // By date, "a" would sort last; by the id tiebreaker it sorts first.
    expect(compareRows(a, b, keys)).toBeLessThan(0);
    expect(compareRows(b, a, keys)).toBeGreaterThan(0);
  });
});

describe("compareStrings", () => {
  it("orders by UTF-8 bytes, not UTF-16 code units", () => {
    // U+FF5E is one UTF-16 unit (0xFF5E); U+1F600 is a surrogate pair (0xD83D…).
    // Naive `<` puts the emoji first; Rust's `str::cmp` does not.
    expect(compareStrings("～", "\u{1f600}")).toBeLessThan(0);
    expect("～" < "\u{1f600}").toBe(false);
  });

  it("is a prefix order for equal prefixes", () => {
    expect(compareStrings("abc", "abcd")).toBeLessThan(0);
    expect(compareStrings("abc", "abc")).toBe(0);
  });
});

describe("resolvePath", () => {
  it("distinguishes missing from null", () => {
    const subject = row("a", { fm: { present: null } });
    expect(resolvePath(subject, "fm.present")).toBeNull();
    expect(resolvePath(subject, "fm.absent")).toBeUndefined();
  });

  it("walks into nested maps only", () => {
    const subject = row("a", { fm: { nested: { deep: "v" } }, plugins: { list: [1] } });
    expect(resolvePath(subject, "fm.nested.deep")).toBe("v");
    expect(resolvePath(subject, "plugins.list.0")).toBeUndefined();
  });
});

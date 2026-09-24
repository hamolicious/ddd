/**
 * Provider merging and snippet extraction.
 *
 * The property under test is the one `merge.ts` argues for at length: a provider's
 * *ranking* is trusted, its absolute scores are not. A test that asserted "the higher
 * raw score wins" would lock in exactly the bug.
 */

import { describe, expect, it } from "vitest";

import { mergeHits, snippetFor, splitHighlights, type ProviderResult } from "./merge.js";

const provider = (
  providerId: string,
  order: number,
  ids: readonly string[],
  extra: Partial<ProviderResult> = {},
): ProviderResult => ({
  providerId,
  label: providerId,
  order,
  hits: ids.map((id, index) => ({ id, score: 100 - index, terms: ["milk"] })),
  ...extra,
});

describe("mergeHits", () => {
  it("de-duplicates by id and records every provider that found the document", () => {
    const merged = mergeHits([provider("local", 0, ["a", "b"]), provider("server", 10, ["b", "c"])]);
    expect(merged.map((hit) => hit.id)).toEqual(["a", "b", "c"]);
    // Best rank first: `server` put "b" at rank 0, `local` at rank 1.
    expect(merged.find((hit) => hit.id === "b")?.providers).toEqual(["server", "local"]);
  });

  it("ranks by position, not by the providers' incomparable raw scores", () => {
    // `weird` returns huge raw scores but ranks `z` second; `local` ranks it first.
    const weird: ProviderResult = {
      providerId: "weird",
      label: "weird",
      order: 5,
      hits: [
        { id: "y", score: 10_000, terms: [] },
        { id: "z", score: 9_999, terms: [] },
      ],
    };
    const merged = mergeHits([provider("local", 0, ["z"]), weird]);
    expect(merged[0]?.id).toBe("z");
  });

  it("breaks ties on provider order, so the local index wins", () => {
    const merged = mergeHits([provider("local", 0, ["local-first"]), provider("server", 10, ["server-first"])]);
    expect(merged[0]?.id).toBe("local-first");
  });

  it("is deterministic for identical ranks and orders", () => {
    const one = mergeHits([provider("p", 0, ["b"]), provider("q", 0, ["a"])]);
    const two = mergeHits([provider("q", 0, ["a"]), provider("p", 0, ["b"])]);
    expect(one.map((hit) => hit.id)).toEqual(two.map((hit) => hit.id));
  });

  it("ignores a failed provider's (empty) results without losing the others", () => {
    const merged = mergeHits([
      provider("local", 0, ["a"]),
      provider("server", 10, [], { error: "offline" }),
    ]);
    expect(merged).toHaveLength(1);
  });

  it("honours a limit", () => {
    expect(mergeHits([provider("local", 0, ["a", "b", "c"])], 2)).toHaveLength(2);
  });
});

describe("snippetFor", () => {
  const content = "---\ntitle: Groceries\n---\n\n# Groceries\n\n- [ ] buy milk and MILK again\n";

  it("picks the first line containing a term and locates every occurrence", () => {
    const snippet = snippetFor(content, ["milk"]);
    expect(snippet?.text).toBe("- [ ] buy milk and MILK again");
    expect(snippet?.ranges).toEqual([
      { start: 10, end: 14 },
      { start: 19, end: 23 },
    ]);
  });

  it("falls back to the first non-empty line when nothing matched", () => {
    expect(snippetFor(content, ["absent"])?.text).toBe("---");
  });

  it("returns nothing without content, which is the offline metadata-only case", () => {
    expect(snippetFor(undefined, ["milk"])).toBeUndefined();
    expect(snippetFor("", ["milk"])).toBeUndefined();
  });

  it("truncates long lines", () => {
    const long = `x${"y".repeat(400)}`;
    const snippet = snippetFor(long, [], { maxLength: 20 });
    expect(snippet?.text).toHaveLength(20);
    expect(snippet?.text.endsWith("…")).toBe(true);
  });

  it("merges overlapping term ranges", () => {
    const snippet = snippetFor("abcabc", ["abca", "cab"]);
    expect(snippet?.ranges).toEqual([{ start: 0, end: 5 }]);
  });
});

describe("splitHighlights", () => {
  it("alternates plain and highlighted pieces covering the whole string", () => {
    const pieces = splitHighlights({ text: "buy milk now", ranges: [{ start: 4, end: 8 }] });
    expect(pieces).toEqual([
      { text: "buy ", hit: false },
      { text: "milk", hit: true },
      { text: " now", hit: false },
    ]);
    expect(pieces.map((piece) => piece.text).join("")).toBe("buy milk now");
  });
});

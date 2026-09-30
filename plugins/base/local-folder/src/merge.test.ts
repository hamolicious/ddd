import { describe, expect, it } from "vitest";

import { applyEdits, merge3, textEdits } from "./merge.js";

describe("textEdits", () => {
  it("turns one text into the other", () => {
    const from = "# A\n\none\ntwo\nthree\n";
    const to = "# A\n\none\n2\nthree\nfour\n";
    expect(applyEdits(from, textEdits(from, to))).toBe(to);
  });

  it("touches only the changed lines", () => {
    const edits = textEdits("a\nb\nc\n", "a\nB\nc\n");
    expect(edits).toEqual([{ range: { start: 2, end: 4 }, text: "B\n" }]);
  });

  it("handles a missing final newline and empty texts", () => {
    for (const [from, to] of [
      ["", "x"],
      ["x", ""],
      ["a\nb", "a\nb\n"],
      ["same", "same"],
    ] as const) {
      expect(applyEdits(from, textEdits(from, to))).toBe(to);
    }
  });
});

describe("merge3", () => {
  const base = "title\n\none\ntwo\nthree\nfour\n";

  it("keeps changes to different lines from both sides", () => {
    const ours = "title\n\nONE\ntwo\nthree\nfour\n";
    const theirs = "title\n\none\ntwo\nthree\nFOUR\n";
    expect(merge3(base, ours, theirs)).toEqual({ clean: true, text: "title\n\nONE\ntwo\nthree\nFOUR\n" });
  });

  it("takes the same change once", () => {
    const both = "title\n\none\n2\nthree\nfour\n";
    expect(merge3(base, both, both)).toEqual({ clean: true, text: both });
  });

  it("calls different changes to one line a conflict", () => {
    expect(merge3(base, "title\n\none\nX\nthree\nfour\n", "title\n\none\nY\nthree\nfour\n")).toEqual({ clean: false });
  });

  it("takes the only side that changed", () => {
    expect(merge3(base, base, "new\n")).toEqual({ clean: true, text: "new\n" });
    expect(merge3(base, "new\n", base)).toEqual({ clean: true, text: "new\n" });
  });
});

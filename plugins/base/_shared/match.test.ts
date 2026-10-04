import { describe, expect, it } from "vitest";

import { matchSnippet } from "./match.js";

const note = ["---", "title: Groceries", "tags: [milk]", "---", "", "Buy oat milk and bread.", "Then call Mum."].join("\n");

describe("the matched text of a fuzzy hit", () => {
  it("is the body line with the first matched word, marked, with its line number", () => {
    expect(matchSnippet(note, ["milk"])).toEqual({
      text: "Buy oat milk and bread.",
      ranges: [{ start: 8, end: 12 }],
      line: 6,
    });
  });

  it("marks every matched word on that line, whatever the case", () => {
    expect(matchSnippet(note, ["Bread", "OAT"])?.ranges).toEqual([
      { start: 4, end: 7 },
      { start: 17, end: 22 },
    ]);
  });

  it("is nothing when the words only match the frontmatter", () => {
    expect(matchSnippet(note, ["groceries"])).toBeUndefined();
  });

  it("is nothing without terms", () => {
    expect(matchSnippet(note, [])).toBeUndefined();
  });

  it("trims a long line around the match", () => {
    const long = `${"a".repeat(200)} needle ${"b".repeat(200)}`;
    const snippet = matchSnippet(long, ["needle"]);
    expect(snippet?.text.startsWith("…")).toBe(true);
    expect(snippet?.text.endsWith("…")).toBe(true);
    const range = snippet?.ranges[0];
    expect(snippet?.text.slice(range?.start, range?.end)).toBe("needle");
  });
});

import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { fencesOf } from "./editor-extension.js";

const doc = (...lines: string[]): Text => Text.of(lines);
const bodies = (text: Text): Array<[string, string]> =>
  fencesOf(text).map((fence) => [fence.info, text.sliceString(fence.from, fence.to)]);

describe("fencesOf", () => {
  it("finds each fenced body and its info string", () => {
    expect(bodies(doc("# t", "```rust", "fn a() {}", "```", "", "~~~ py x", "x = 1", "y = 2", "~~~"))).toEqual([
      ["rust", "fn a() {}"],
      ["py x", "x = 1\ny = 2"],
    ]);
  });

  it("closes only on the same character, at least as long", () => {
    expect(bodies(doc("````md", "```", "inner", "```", "````"))).toEqual([["md", "```\ninner\n```"]]);
    expect(bodies(doc("~~~", "```", "~~~"))).toEqual([["", "```"]]);
  });

  it("runs an unclosed fence to the end", () => {
    expect(bodies(doc("```js", "a", "b"))).toEqual([["js", "a\nb"]]);
  });

  it("skips empty blocks, backtick info strings with backticks, and the frontmatter", () => {
    expect(bodies(doc("```ts", "```"))).toEqual([]);
    expect(bodies(doc("``` a`b", "x", "```"))).toEqual([]);
    expect(bodies(doc("---", "k: ```", "---", "```sh", "ls", "```"))).toEqual([["sh", "ls"]]);
  });
});

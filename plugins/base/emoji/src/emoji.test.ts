import { describe, expect, it } from "vitest";

import { unpack, type PackedEmoji } from "./emojis.js";
import { replaceShortcodes } from "./shortcodes.js";
import { suggest } from "./suggest.js";

const SET = unpack([
  ["🎉", "tada", "hooray party celebration"],
  ["🌮", "taco", "food taco"],
  ["👍", "+1 thumbsup", "approve ok thumbs up"],
  ["❤️", "heart", "love red heart"],
  ["🐱", "cat", "pet cat face"],
  ["😺", "smiley_cat", "grinning cat"],
] satisfies PackedEmoji[]);

const offered = (line: string, document = line) => suggest(line, document, SET)?.items.map((item) => item.name);

describe("replaceShortcodes", () => {
  it("replaces known shortcodes at the start of a word", () => {
    expect(replaceShortcodes("party :tada: time", SET)).toBe("party 🎉 time");
    expect(replaceShortcodes(":+1::heart:", SET)).toBe("👍❤️");
    expect(replaceShortcodes("(:cat:)", SET)).toBe("(🐱)");
  });

  it("leaves unknown names, glued names and times alone", () => {
    expect(replaceShortcodes(":nope:", SET)).toBe(":nope:");
    expect(replaceShortcodes("a:tada:", SET)).toBe("a:tada:");
    expect(replaceShortcodes("18:00 - 20:30", SET)).toBe("18:00 - 20:30");
  });
});

describe("suggest", () => {
  it("offers prefix matches first, then contains, then words", () => {
    expect(offered("so :ta")).toEqual(["tada", "taco"]);
    expect(offered(":cat")).toEqual(["cat", "smiley_cat"]);
    expect(offered(":love")).toEqual(["heart"]);
  });

  it("replaces the typed colon and name with the whole shortcode", () => {
    expect(suggest("so :ta", "so :ta", SET)).toMatchObject({ replace: 3, items: [{ insert: ":tada:" }, { insert: ":taco:" }] });
  });

  it("needs two characters and the start of a word", () => {
    expect(offered(":t")).toBeUndefined();
    expect(offered("a:ta")).toBeUndefined();
    expect(offered("at 18:00")).toBeUndefined();
    expect(offered("see http://ta")).toBeUndefined();
    expect(offered(":tada:")).toBeUndefined();
  });

  it("stays shut in frontmatter and code", () => {
    expect(offered(":ta", "---\ntitle: x\n:ta")).toBeUndefined();
    expect(offered(":ta", "---\ntitle: x\n---\n:ta")).toEqual(["tada", "taco"]);
    expect(offered("`x :ta")).toBeUndefined();
    expect(offered(":ta", "```js\n:ta")).toBeUndefined();
    expect(offered(":ta", "```js\nx\n```\n:ta")).toEqual(["tada", "taco"]);
  });
});

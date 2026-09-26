import { describe, expect, it } from "vitest";

import { embedReplace, embedToggle } from "./embed-toggle.js";

const ID = "01JBQ2X4Y5Z6A7B8C9D0E1F2G3";
const PREVIEW = `![a.png](attachment://${ID})`;
const LINK = `[a.png](attachment://${ID})`;

describe("embedToggle", () => {
  it("removes the ! from a preview", () => {
    const text = `intro\n\n${PREVIEW}\n`;
    expect(embedToggle(text, 0, { at: 7, source: PREVIEW })).toEqual({ range: { start: 7, end: 8 }, text: "" });
  });

  it("adds a ! to a link", () => {
    const text = `see ${LINK}`;
    expect(embedToggle(text, 0, { at: 4, source: LINK })).toEqual({ range: { start: 4, end: 4 }, text: "!" });
  });

  it("measures from the body's start", () => {
    const text = `---\ntitle: x\n---\n${LINK}`;
    expect(embedToggle(text, 17, { at: 0, source: LINK })?.range.start).toBe(17);
  });

  it("finds an embed that moved, when it is there once", () => {
    const text = `new line\n${LINK}`;
    expect(embedToggle(text, 0, { at: 0, source: LINK })?.range.start).toBe(9);
  });

  it("writes nothing when it is gone or ambiguous", () => {
    expect(embedToggle("nothing here", 0, { at: 0, source: LINK })).toBeNull();
    expect(embedToggle(`x ${LINK} ${LINK}`, 0, { at: 0, source: LINK })).toBeNull();
  });
});

describe("embedReplace", () => {
  it("swaps the whole embed", () => {
    const text = `a ${PREVIEW} b`;
    expect(embedReplace(text, 0, { at: 2, source: PREVIEW }, "[a.png](doc://X)")).toEqual({
      range: { start: 2, end: 2 + PREVIEW.length },
      text: "[a.png](doc://X)",
    });
  });

  it("writes nothing when it is gone", () => {
    expect(embedReplace("a b", 0, { at: 2, source: PREVIEW }, "x")).toBeNull();
  });
});

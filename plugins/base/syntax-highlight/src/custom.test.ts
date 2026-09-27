import { describe, expect, it } from "vitest";

import { aliasesFrom, attachmentId, parseCustom } from "./custom.js";

const A = "attachment://01JATTACHMENT0000000000000";
const B = "attachment://01JATTACHMENT0000000000001";

describe("parseCustom", () => {
  it("reads the languages the setting holds", () => {
    const zig = { id: "zig", name: "Zig", aliases: ["zg"], wasm: A, highlights: B, size: 10 };
    expect(parseCustom([JSON.stringify(zig)])).toEqual([zig]);
  });

  it("skips what is not one of ours, keeping the rest", () => {
    const ok = JSON.stringify({ id: "zig", name: "Zig", wasm: A, highlights: B });
    expect(
      parseCustom([
        "not json",
        JSON.stringify({ id: "Bad Id", name: "x", wasm: A, highlights: B }),
        JSON.stringify({ id: "zig", name: "Zig", wasm: "https://example.com/x.wasm", highlights: B }),
        3,
        ok,
      ]).map((language) => [language.id, language.aliases, language.size]),
    ).toEqual([["zig", [], 0]]);
  });

  it("reads an unset or scalar setting as none", () => {
    expect(parseCustom(undefined)).toEqual([]);
    expect(parseCustom("zig")).toEqual([]);
  });
});

describe("helpers", () => {
  it("takes the id out of an attachment reference, and nothing else", () => {
    expect(attachmentId(A)).toBe("01JATTACHMENT0000000000000");
    expect(attachmentId("languages/zig/grammar.wasm")).toBeUndefined();
  });

  it("normalises typed aliases", () => {
    expect(aliasesFrom(" ZG, zig-lang  zg ,")).toEqual(["zg", "zig-lang"]);
  });
});

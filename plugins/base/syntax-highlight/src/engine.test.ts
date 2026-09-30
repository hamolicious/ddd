import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createEngine, spansOf } from "./engine.js";

describe("spansOf", () => {
  it("lets the innermost capture colour a character", () => {
    // "a\nb" — a string with an escape inside it.
    expect(
      spansOf(6, [
        { name: "string", from: 0, to: 6, pattern: 0 },
        { name: "escape", from: 2, to: 4, pattern: 1 },
      ]),
    ).toEqual([
      { from: 0, to: 2, className: "lmsh-string" },
      { from: 2, to: 4, className: "lmsh-escape" },
      { from: 4, to: 6, className: "lmsh-string" },
    ]);
  });

  it("gives a node captured twice to the earlier pattern", () => {
    expect(
      spansOf(4, [
        { name: "variable.builtin", from: 0, to: 4, pattern: 3 },
        { name: "keyword", from: 0, to: 4, pattern: 7 },
      ]),
    ).toEqual([{ from: 0, to: 4, className: "lmsh-variable-builtin" }]);
  });

  it("drops captures it does not colour, and empty ones", () => {
    expect(
      spansOf(5, [
        { name: "variable", from: 0, to: 5, pattern: 0 },
        { name: "keyword", from: 2, to: 2, pattern: 0 },
      ]),
    ).toEqual([]);
  });
});

const built = fileURLToPath(new URL("../../dist/syntax-highlight/2.0.0/frontend/", import.meta.url));

describe.skipIf(!existsSync(`${built}languages/rust/grammar.wasm`))("engine, with the built grammars", () => {
  const engine = createEngine({
    base: pathToFileURL(built).href,
    fetchBytes: async (url) => new Uint8Array(readFileSync(fileURLToPath(url))),
  });
  const rust = {
    id: "rust",
    name: "Rust",
    wasmUrl: "languages/rust/grammar.wasm",
    highlightsUrl: "languages/rust/highlights.scm",
  };

  it("is not ready before it is loaded", () => {
    expect(engine.highlight("fn main() {}", "rust")).toBeUndefined();
  });

  it("highlights once loaded", async () => {
    await engine.load(rust);
    expect(engine.state("rust")).toBe("ready");
    const code = 'fn main() { let s = "hi"; }';
    const spans = engine.highlight(code, "rust") ?? [];
    const text = (className: string): string[] =>
      spans.filter((span) => span.className === className).map((span) => code.slice(span.from, span.to));
    expect(text("lmsh-keyword")).toEqual(expect.arrayContaining(["fn", "let"]));
    expect(text("lmsh-function")).toContain("main");
    expect(text("lmsh-string")).toContain('"hi"');
  });

  it("answers the same text from its cache", async () => {
    await engine.load(rust);
    expect(engine.highlight("let x = 1;", "rust")).toBe(engine.highlight("let x = 1;", "rust"));
  });
});

import { describe, expect, it } from "vitest";

import type { SyntaxLanguage } from "./api.js";

import { indexLanguages } from "./registry.js";

const language = (id: string, aliases?: string[]): SyntaxLanguage => ({
  id,
  name: id,
  aliases,
  wasmUrl: `${id}.wasm`,
  highlightsUrl: `${id}.scm`,
});

describe("indexLanguages", () => {
  const index = indexLanguages([language("typescript", ["ts"]), language("tsx"), language("other", ["tsx", "TS"])]);

  it("resolves an id or an alias, whatever the case", () => {
    expect(index.resolve("typescript")?.id).toBe("typescript");
    expect(index.resolve("TS")?.id).toBe("typescript");
  });

  it("reads only the info string's first word", () => {
    expect(index.resolve("  ts {1,3} title=x ")?.id).toBe("typescript");
  });

  it("prefers an id to another language's alias, and the first alias to a later one", () => {
    expect(index.resolve("tsx")?.id).toBe("tsx");
    expect(index.resolve("ts")?.id).toBe("typescript");
  });

  it("resolves nothing for no info string or an unknown one", () => {
    expect(index.resolve(undefined)).toBeUndefined();
    expect(index.resolve("")).toBeUndefined();
    expect(index.resolve("cobol")).toBeUndefined();
  });
});

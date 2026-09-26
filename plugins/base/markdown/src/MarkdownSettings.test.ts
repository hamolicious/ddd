import { describe, expect, it } from "vitest";

import { mayEmbed } from "./doc-embed.js";
import { clampEmbedDepth, DEFAULT_EMBED_DEPTH, MAX_EMBED_DEPTH } from "./MarkdownSettings.js";

describe("clampEmbedDepth", () => {
  it("keeps whole numbers in range and defaults the rest", () => {
    expect(clampEmbedDepth(2)).toBe(2);
    expect(clampEmbedDepth(2.6)).toBe(3);
    expect(clampEmbedDepth(-1)).toBe(0);
    expect(clampEmbedDepth(99)).toBe(MAX_EMBED_DEPTH);
    expect(clampEmbedDepth(undefined)).toBe(DEFAULT_EMBED_DEPTH);
    expect(clampEmbedDepth("3")).toBe(DEFAULT_EMBED_DEPTH);
  });
});

describe("mayEmbed", () => {
  it("stops at the depth, and at a document already shown", () => {
    expect(mayEmbed({ depth: 0, ancestors: ["a"] }, "b", 4)).toBe(true);
    expect(mayEmbed({ depth: 4, ancestors: [] }, "b", 4)).toBe(false);
    expect(mayEmbed({ depth: 1, ancestors: ["a", "b"] }, "a", 4)).toBe(false);
    expect(mayEmbed({ depth: 0, ancestors: [] }, "b", 0)).toBe(false);
  });
});

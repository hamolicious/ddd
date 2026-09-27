import { describe, expect, it } from "vitest";

import { labelZoomAlpha } from "./renderer.js";

describe("labelZoomAlpha", () => {
  it("makes more-connected nodes opaque sooner while zooming in", () => {
    const zoom = 0.7;

    expect(labelZoomAlpha(zoom, 0, 12)).toBeGreaterThan(labelZoomAlpha(zoom, 0, 3));
    expect(labelZoomAlpha(zoom, 0, 3)).toBeGreaterThan(labelZoomAlpha(zoom, 0, 0));
  });

  it("keeps opacity in range", () => {
    expect(labelZoomAlpha(0, 0, 4)).toBe(0);
    expect(labelZoomAlpha(10, 0, 4)).toBe(1);
  });

  it("preserves the text fade setting", () => {
    expect(labelZoomAlpha(0.8, -1, 4)).toBeGreaterThan(labelZoomAlpha(0.8, 1, 4));
  });
});

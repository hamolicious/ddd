import { describe, expect, it } from "vitest";

import { contentEnd, fitHeight, layoutRows, rowAt, rowSpan, scrollDelta, visibleBand, visibleHeight } from "./virtual-list.js";

const even = layoutRows(1000, () => 40);

describe("layoutRows", () => {
  it("adds up the heights", () => {
    expect(Array.from(layoutRows(3, (index) => [10, 20, 30][index] as number))).toEqual([0, 10, 30, 60]);
  });

  it("is a lone zero for an empty list", () => {
    expect(Array.from(layoutRows(0, () => 40))).toEqual([0]);
  });
});

describe("rowAt", () => {
  it("finds the row whose box holds a point", () => {
    expect(rowAt(even, 0)).toBe(0);
    expect(rowAt(even, 39)).toBe(0);
    expect(rowAt(even, 40)).toBe(1);
    expect(rowAt(even, 39_999)).toBe(999);
  });

  it("clamps to the list", () => {
    expect(rowAt(even, -100)).toBe(0);
    expect(rowAt(even, 1e9)).toBe(999);
  });
});

describe("rowSpan", () => {
  it("draws the rows in view and the overscan either side", () => {
    expect(rowSpan(even, 400, 800, 2)).toEqual({ first: 8, end: 22 });
  });

  it("counts a partly visible row, and not one that only touches the edge", () => {
    expect(rowSpan(even, 20, 120, 0)).toEqual({ first: 0, end: 3 });
    expect(rowSpan(even, 0, 80, 0)).toEqual({ first: 0, end: 2 });
  });

  it("stops at the top and the bottom", () => {
    expect(rowSpan(even, -300, 400, 3)).toEqual({ first: 0, end: 13 });
    expect(rowSpan(even, 39_600, 40_300, 3)).toEqual({ first: 987, end: 1000 });
  });

  it("draws nothing when the list is out of view", () => {
    expect(rowSpan(even, -900, -100, 3)).toEqual({ first: 0, end: 0 });
    expect(rowSpan(even, 50_000, 50_400, 3)).toEqual({ first: 1000, end: 1000 });
    expect(rowSpan(layoutRows(0, () => 40), 0, 400, 3)).toEqual({ first: 0, end: 0 });
  });

  it("follows rows of different heights", () => {
    const mixed = layoutRows(100, (index) => (index < 10 ? 100 : 40));
    expect(rowSpan(mixed, 950, 1100, 0)).toEqual({ first: 9, end: 13 });
  });
});

describe("scrollDelta", () => {
  it("does nothing for a row already in view", () => {
    expect(scrollDelta(100, 140, 0, 400)).toBe(0);
  });

  it("scrolls up to a row above, and down to a row below, as little as it can", () => {
    expect(scrollDelta(100, 140, 120, 520)).toBe(-20);
    expect(scrollDelta(500, 540, 0, 400)).toBe(140);
  });

  it("lines up the top of a row taller than the viewport", () => {
    expect(scrollDelta(500, 1500, 0, 400)).toBe(500);
  });
});

describe("fitHeight", () => {
  it("fills what the rest of the ancestor leaves", () => {
    expect(fitHeight(800, 1300, 1000, 100)).toBe(500);
  });

  it("is the same once the box has shrunk to it", () => {
    expect(fitHeight(800, 800, 500, 100)).toBe(500);
  });

  it("never goes below the minimum", () => {
    expect(fitHeight(400, 1000, 200, 150)).toBe(150);
  });
});

describe("contentEnd", () => {
  it("is where the box ends when nothing else is in the way", () => {
    expect(contentEnd(500, [])).toBe(500);
  });

  it("adds each ancestor's padding and its child's margin on the way up", () => {
    expect(
      contentEnd(500, [
        { margin: 4, others: [], after: 8 },
        { margin: 0, others: [], after: 80 },
      ]),
    ).toBe(592);
  });

  it("ends after a sibling that ends below the box", () => {
    expect(contentEnd(500, [{ margin: 0, others: [100, 540], after: 0 }])).toBe(540);
  });

  it("follows content out of an ancestor shrunk below it", () => {
    const boardEnd = 4156;
    const end = contentEnd(boardEnd, [
      { margin: 0, others: [], after: 0 },
      { margin: 0, others: [140], after: 8 },
      { margin: 0, others: [], after: 80 },
    ]);
    expect(end).toBe(4244);
    expect(fitHeight(692, end - 90, 4058, 320)).toBe(692 - (end - 90 - 4058));
    expect(692 - (end - 90 - 4058)).toBeLessThan(692);
  });
});

describe("visibleBand", () => {
  it("is the layout viewport without a visual viewport", () => {
    expect(visibleBand({ innerHeight: 844 })).toEqual({ top: 0, bottom: 844 });
    expect(visibleBand({ innerHeight: 844, visualViewport: null })).toEqual({ top: 0, bottom: 844 });
  });

  it("is the visual viewport when the keyboard shrinks it", () => {
    const source = { innerHeight: 844, visualViewport: { height: 500, offsetTop: 0, scale: 1 } };
    expect(visibleBand(source)).toEqual({ top: 0, bottom: 500 });
    expect(visibleHeight(source)).toBe(500);
  });

  it("follows the visual viewport when it is scrolled within the layout one", () => {
    expect(visibleBand({ innerHeight: 844, visualViewport: { height: 500, offsetTop: 200, scale: 1 } })).toEqual({ top: 200, bottom: 700 });
  });

  it("is the layout viewport while pinch-zoomed", () => {
    expect(visibleHeight({ innerHeight: 844, visualViewport: { height: 300, offsetTop: 120, scale: 2.5 } })).toBe(844);
  });

  it("ignores an empty visual viewport", () => {
    expect(visibleHeight({ innerHeight: 844, visualViewport: { height: 0, offsetTop: 0, scale: 1 } })).toBe(844);
  });
});

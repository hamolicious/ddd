import { describe, expect, it } from "vitest";

import { moveFocus } from "./NoteList.js";

const three = [{}, {}, {}] as unknown as readonly HTMLElement[];

describe("moving through the note list with the keyboard", () => {
  it("steps down and stops at the last note", () => {
    expect(moveFocus(three, 0, "ArrowDown")).toBe(1);
    expect(moveFocus(three, 2, "ArrowDown")).toBe(2);
  });

  it("steps up, and goes back to the search box from the first note", () => {
    expect(moveFocus(three, 2, "ArrowUp")).toBe(1);
    expect(moveFocus(three, 0, "ArrowUp")).toBe("input");
  });

  it("jumps to the ends, and Escape returns to the search box", () => {
    expect(moveFocus(three, 1, "Home")).toBe(0);
    expect(moveFocus(three, 0, "End")).toBe(2);
    expect(moveFocus(three, 1, "Escape")).toBe("input");
  });

  it("ignores other keys and an empty list", () => {
    expect(moveFocus(three, 1, "a")).toBeUndefined();
    expect(moveFocus([], 0, "ArrowDown")).toBeUndefined();
  });
});

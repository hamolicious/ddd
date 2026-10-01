import { describe, expect, it } from "vitest";

import { isIgnored, layout, nameMatchesTitle, safeName } from "./mapping.js";

describe("safeName", () => {
  it("replaces what filesystems refuse and never returns a hidden or empty name", () => {
    expect(safeName("a/b: c?")).toBe("a-b- c-");
    expect(safeName("..hidden")).toBe("hidden");
    expect(safeName("   ")).toBe("Untitled");
    expect(safeName("CON")).toBe("CON_");
    expect(new TextEncoder().encode(safeName("é".repeat(200))).length).toBeLessThanOrEqual(120);
  });
});

describe("layout", () => {
  it("writes a note with children as a directory holding its own file", () => {
    const places = layout([
      { id: "01A", title: "Home", parent: "" },
      { id: "01B", title: "Groceries", parent: "01A" },
      { id: "01C", title: "photo.png", parent: "01A", fileName: "photo.png" },
    ]);
    expect(places.get("01A")).toEqual({ path: "Home/Home.md", dir: "Home" });
    expect(places.get("01B")).toEqual({ path: "Home/Groceries.md" });
    expect(places.get("01C")).toEqual({ path: "Home/photo.png" });
  });

  it("numbers same-named siblings in id order, ignoring case", () => {
    const places = layout([
      { id: "02", title: "notes", parent: "" },
      { id: "01", title: "Notes", parent: "" },
    ]);
    expect(places.get("01")?.path).toBe("Notes.md");
    expect(places.get("02")?.path).toBe("notes (2).md");
  });

  it("keeps a child of a folder from taking the folder's own file name", () => {
    const places = layout([
      { id: "01A", title: "Home", parent: "" },
      { id: "01B", title: "Home", parent: "01A" },
    ]);
    expect(places.get("01B")?.path).toBe("Home/Home (2).md");
  });

  it("leaves a pinned note where it is", () => {
    const places = layout([{ id: "01A", title: "New name", parent: "" }], new Map([["01A", { path: "Old.md" }]]));
    expect(places.get("01A")).toEqual({ path: "Old.md" });
  });
});

describe("names", () => {
  it("treats the collision suffix and replaced characters as the same title", () => {
    expect(nameMatchesTitle("Notes (2)", "Notes")).toBe(true);
    expect(nameMatchesTitle("a-b", "a/b")).toBe(true);
    expect(nameMatchesTitle("Other", "Notes")).toBe(false);
  });

  it("ignores hidden paths and editor droppings", () => {
    expect(isIgnored(".ddd/index.json")).toBe(true);
    expect(isIgnored("Home/.obsidian/app.json")).toBe(true);
    expect(isIgnored("Home/note.md.swp")).toBe(true);
    expect(isIgnored("Home/note.md")).toBe(false);
  });
});

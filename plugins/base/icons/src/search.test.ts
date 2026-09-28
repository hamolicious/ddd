import { describe, expect, it } from "vitest";

import { searchIcons, type IconIndex } from "./search.js";

const index: IconIndex = {
  version: "test",
  categories: ["Document", "Buildings"],
  suggested: ["home", "folder", "not-in-the-set"],
  icons: [
    ["book", 0, "read library"],
    ["folder", 0, "directory dir"],
    ["folder-filled", 0, "filled directory dir"],
    ["folder-open", 0, "directory"],
    ["home", 1, "house dashboard living"],
    ["user-folder", 0, "person"],
  ],
};

const names = (query: string, limit?: number): readonly string[] =>
  searchIcons(index, query, limit).map((icon) => icon.name);

describe("searchIcons", () => {
  it("answers an empty query with every icon, the suggested ones it has first", () => {
    const all = ["home", "folder", "book", "folder-filled", "folder-open", "user-folder"];
    expect(names("")).toEqual(all);
    expect(names("   ")).toEqual(all);
    expect(names("", 3)).toEqual(["home", "folder", "book"]);
  });

  it("ranks an exact name, then a prefix, then a substring, then a tag", () => {
    expect(names("folder")).toEqual(["folder", "folder-filled", "folder-open", "user-folder"]);
    expect(names("dir")).toEqual(["folder", "folder-filled", "folder-open"]);
  });

  it("needs every word, matched anywhere", () => {
    expect(names("folder filled")).toEqual(["folder-filled"]);
    expect(names("house")).toEqual(["home"]);
    expect(names("buildings")).toEqual(["home"]);
    expect(names("folder house")).toEqual([]);
  });

  it("reads the category and tags back out", () => {
    expect(searchIcons(index, "home")[0]).toEqual({
      name: "home",
      category: "Buildings",
      tags: ["house", "dashboard", "living"],
    });
  });

  it("stops at the limit", () => {
    expect(names("folder", 2)).toEqual(["folder", "folder-filled"]);
  });
});

import { describe, expect, it } from "vitest";

import { isSubmenu, type MenuGroup, type MenuItem } from "./api.js";
import { nest, nestItems } from "./nest.js";

const run = (): void => undefined;
const leaf = (id: string, group?: string): MenuItem => ({ id, label: id, run, ...(group ? { group } : {}) });

type Shape = string | { readonly [label: string]: readonly Shape[] };

function shape(items: readonly MenuItem[]): Shape[] {
  return items.map((item) => (isSubmenu(item) ? { [item.label]: shape(item.items) } : item.label));
}

const groups = (...list: MenuGroup[]): ReadonlyMap<string, MenuGroup> => new Map(list.map((group) => [group.id, group]));

describe("nest", () => {
  const known = groups(
    { id: "new", label: "New" },
    { id: "new.view", label: "View", parent: "new" },
    { id: "deep", label: "Deep", parent: "new.view" },
    { id: "move", label: "Move to" },
  );

  it("leaves ungrouped items alone and in rank order", () => {
    expect(shape(nest([{ item: leaf("b"), rank: 5 }, { item: leaf("a"), rank: 1 }], known))).toEqual(["a", "b"]);
  });

  it("nests groups inside their parents, to any depth", () => {
    const items = nestItems([leaf("note", "new"), leaf("table", "new.view"), leaf("x", "deep"), leaf("open")], known);
    expect(shape(items)).toEqual([{ New: ["note", { View: ["table", { Deep: ["x"] }] }] }, "open"]);
  });

  it("places a group at its first item's rank unless the group sets an order", () => {
    const entries = [
      { item: leaf("open"), rank: 0 },
      { item: leaf("column", "move"), rank: 60 },
      { item: leaf("rename"), rank: 10 },
    ];
    expect(shape(nest(entries, known))).toEqual(["open", "rename", { "Move to": ["column"] }]);
    const pinned = groups({ id: "move", label: "Move to", order: -1 });
    expect(shape(nest(entries, pinned))).toEqual([{ "Move to": ["column"] }, "open", "rename"]);
  });

  it("keeps an item whose group nobody registered at its own level", () => {
    expect(shape(nestItems([leaf("a", "nowhere"), leaf("b")], known))).toEqual(["a", "b"]);
  });

  it("survives a group that is its own ancestor", () => {
    const loop = groups({ id: "a", label: "A", parent: "b" }, { id: "b", label: "B", parent: "a" });
    expect(shape(nestItems([leaf("x", "a")], loop))).toEqual([{ B: [{ A: ["x"] }] }]);
  });

  it("drops empty submenus, and groups the items of a hand-built submenu", () => {
    const built: MenuItem = { id: "more", label: "More", items: [leaf("n", "new"), leaf("plain")] };
    const empty: MenuItem = { id: "empty", label: "Empty", items: [] };
    expect(shape(nestItems([built, empty], known))).toEqual([{ More: [{ New: ["n"] }, "plain"] }]);
  });
});

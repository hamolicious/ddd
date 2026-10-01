/**
 * Menus for marked elements: which targets a right-click finds, how their actions merge
 * into one menu, and when the browser keeps its own menu.
 *
 * The suite runs without a DOM, so elements are small stand-ins with the four things the
 * code reads: attributes, a parent, `closest` and `contains`.
 */

import { describe, expect, it } from "vitest";

import type { RegistryEntry } from "@kernel";
import type { ContextAction, MenuItem, Target } from "./api.js";

import { target } from "../../_shared/target.js";

import { buildMenu, editableFirst } from "./targets.js";

class Node {
  constructor(
    readonly tag: string,
    readonly attrs: Readonly<Record<string, string | undefined>>,
    readonly parentElement: Node | null,
  ) {}
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  matches(selector: string): boolean {
    if (selector === "[data-ddd-target]") return this.attrs["data-ddd-target"] !== undefined;
    const editable = this.attrs["contenteditable"];
    return ["input", "textarea", "select"].includes(this.tag) || editable === "" || editable === "true";
  }
  closest(selector: string): Node | null {
    for (let at: Node | null = this; at; at = at.parentElement) if (at.matches(selector)) return at;
    return null;
  }
  contains(other: Node): boolean {
    for (let at: Node | null = other; at; at = at.parentElement) if (at === this) return true;
    return false;
  }
}

const el = (parent: Node | null, attrs: Readonly<Record<string, string | undefined>> = {}, tag = "div"): Node =>
  new Node(tag, attrs, parent);
const asElement = (node: Node): Element => node as unknown as Element;

const action = (
  id: string,
  type: string,
  items: (target: Target, chain: readonly Target[]) => readonly MenuItem[],
  order?: number,
  pluginId = "p",
): RegistryEntry<ContextAction> => ({
  pluginId,
  value: { id, target: type, ...(order !== undefined ? { order } : {}), items },
});
const item = (id: string, label = id): MenuItem => ({ id, label, run: () => undefined });
const labels = (menu: ReturnType<typeof buildMenu>): string[][] =>
  (menu?.sections ?? []).map((section) => section.items.map((each) => each.label));

describe("buildMenu", () => {
  const board = el(null, target("kanban/board", ""));
  const column = el(board, target("kanban/column", "0", { label: "Doing" }));
  const card = el(column, target("ddd/document", "n1", { label: "Card", types: ["kanban/card"] }));
  const inside = el(card, {}, "span");

  it("finds nothing outside a mark", () => {
    expect(buildMenu(asElement(el(null)), [action("a", "ddd/document", () => [item("x")])])).toBeUndefined();
  });

  it("merges every target from the innermost out, titling the outer sections", () => {
    const menu = buildMenu(asElement(inside), [
      action("column", "kanban/column", () => [item("add", "Add a card")]),
      action("open", "ddd/document", (t) => [item("open", `Open ${t.id}`)]),
      action("move", "kanban/card", () => [item("move", "Move to Done")]),
    ]);
    expect(menu?.title).toBe("Card");
    expect(labels(menu)).toEqual([["Open n1", "Move to Done"], ["Add a card"]]);
    expect(menu?.sections.map((section) => section.title)).toEqual([undefined, "Doing"]);
  });

  it("orders an element's items by `order`, whatever type offered them, then by list order", () => {
    const menu = buildMenu(asElement(card), [
      action("trash", "ddd/document", () => [item("trash")], 100),
      action("move", "kanban/card", () => [item("move")], 60),
      action("open", "ddd/document", () => [item("open")], 0),
      action("rename", "ddd/document", () => [item("rename")], 60),
    ]);
    expect(labels(menu)[0]).toEqual(["open", "move", "rename", "trash"]);
  });

  it("drops empty sections and names the menu after the nearest target with items", () => {
    const menu = buildMenu(asElement(card), [action("column", "kanban/column", () => [item("fold")])]);
    expect(menu?.title).toBe("Doing");
    expect(menu?.sections).toHaveLength(1);
    expect(menu?.sections[0]?.title).toBeUndefined();
  });

  it("hands every action the whole chain, innermost first", () => {
    let seen: string[] = [];
    buildMenu(asElement(card), [
      action("move", "kanban/card", (_, chain) => {
        seen = chain.map((each) => each.type);
        return [];
      }),
    ]);
    expect(seen).toEqual(["ddd/document", "kanban/card", "kanban/column", "kanban/board"]);
  });

  it("shows one action per id, the first in list order", () => {
    const menu = buildMenu(asElement(card), [
      action("document.trash", "ddd/document", () => [item("delete", "Delete")], 100, "folders"),
      action("document.trash", "ddd/document", () => [item("trash", "Move to Trash")], 100, "doc-list"),
    ]);
    expect(labels(menu)).toEqual([["Delete"]]);
  });

  it("keeps the rest of the menu when an action throws, and says which", () => {
    const failed: string[] = [];
    const menu = buildMenu(
      asElement(card),
      [
        action("broken", "ddd/document", () => {
          throw new Error("no");
        }),
        action("open", "ddd/document", () => [item("open")]),
      ],
      (entry) => failed.push(entry.value.id),
    );
    expect(labels(menu)).toEqual([["open"]]);
    expect(failed).toEqual(["broken"]);
  });

  it("leaves blank space out of the chains of what is on it", () => {
    const tree = el(null, target("folders/root", "", { label: "Folders", enclosing: false }));
    const row = el(tree, target("ddd/document", "n2", { label: "Row" }));
    const actions = [
      action("root", "folders/root", () => [item("new", "New note at the root")]),
      action("open", "ddd/document", () => [item("open")]),
    ];
    expect(labels(buildMenu(asElement(row), actions))).toEqual([["open"]]);
    expect(labels(buildMenu(asElement(tree), actions))).toEqual([["New note at the root"]]);
  });

  it("prefixes item ids with their action's, so two actions' items never collide", () => {
    const menu = buildMenu(asElement(card), [action("a", "ddd/document", () => [item("x")]), action("b", "ddd/document", () => [item("x")])]);
    expect(menu?.sections[0]?.items.map((each) => each.id)).toEqual(["a:x", "b:x"]);
  });
});

describe("editableFirst", () => {
  it("keeps the browser's menu in a text field or the editor", () => {
    const editor = el(null, { contenteditable: "true" });
    expect(editableFirst(asElement(el(editor, {}, "span")))).toBe(true);
    expect(editableFirst(asElement(el(null, {}, "input")))).toBe(true);
  });

  it("gives a mark inside the editor its menu", () => {
    const editor = el(null, { contenteditable: "true" });
    const task = el(editor, target("markdown/task", "x"), "button");
    expect(editableFirst(asElement(task))).toBe(false);
  });

  it("keeps a text field inside a mark for the browser", () => {
    const row = el(null, target("ddd/document", "n1"));
    expect(editableFirst(asElement(el(row, {}, "input")))).toBe(true);
  });

  it("is not in the way where nothing is editable", () => {
    expect(editableFirst(asElement(el(el(null, target("ddd/document", "n1")))))).toBe(false);
  });
});

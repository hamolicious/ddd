import { describe, expect, it } from "vitest";

import type { DocumentQuery, DocumentQueryResult, FilterJson } from "@kernel";

import { ruleMatcher } from "./matcher.js";
import type { Rule } from "./styles.js";

function fakeDocuments(answer: (filter: FilterJson | undefined) => readonly { id: string; plugins?: unknown }[]) {
  const open: { filter: FilterJson | undefined; listeners: Set<(result: DocumentQueryResult) => void>; closed: boolean }[] = [];
  const result = (filter: FilterJson | undefined) =>
    ({ rows: answer(filter).map((row) => ({ plugins: {}, ...row })), total: 0 }) as unknown as DocumentQueryResult;
  return {
    open,
    emit: () => {
      for (const each of open) if (!each.closed) for (const listener of each.listeners) listener(result(each.filter));
    },
    documents: {
      subscribe: async (query: DocumentQuery) => {
        const entry = { filter: query.filter, listeners: new Set<(result: DocumentQueryResult) => void>(), closed: false };
        open.push(entry);
        return {
          result: result(query.filter),
          onChange: (listener: (result: DocumentQueryResult) => void) => {
            entry.listeners.add(listener);
            return () => entry.listeners.delete(listener);
          },
          close: () => {
            entry.closed = true;
          },
        };
      },
    },
  };
}

const rule = (id: string, clauses: Rule["when"]["clauses"], style: Rule["style"]): Rule => ({
  id,
  when: { combine: "and", clauses },
  style,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ruleMatcher", () => {
  it("answers each note with the looks of the rules it matches, in order", async () => {
    const fake = fakeDocuments((filter) => {
      const text = JSON.stringify(filter);
      if (text.includes('"work"')) return [{ id: "a" }, { id: "b" }];
      if (text.includes('"home"')) return [{ id: "b" }];
      return [];
    });
    const matcher = ruleMatcher(fake.documents, () => {}, () => {});
    matcher.set([
      rule("1", [{ id: "c1", field: "fm.tags", op: "contains", value: "work", kind: "str" }], { icon: "briefcase" }),
      rule("2", [{ id: "c2", field: "fm.tags", op: "contains", value: "home", kind: "str" }], { icon: "home" }),
    ]);
    await settle();
    expect(matcher.matched("a")).toEqual([{ icon: "briefcase" }]);
    expect(matcher.matched("b")).toEqual([{ icon: "briefcase" }, { icon: "home" }]);
    expect(matcher.matched("c")).toEqual([]);
  });

  it("a rule with no usable condition matches nothing and runs no query", async () => {
    const fake = fakeDocuments(() => [{ id: "a" }]);
    const matcher = ruleMatcher(fake.documents, () => {}, () => {});
    matcher.set([rule("1", [], { icon: "x" }), rule("2", [{ id: "c", field: "", op: "eq", value: "", kind: "str" }], { icon: "y" })]);
    await settle();
    expect(fake.open).toHaveLength(0);
    expect(matcher.matched("a")).toEqual([]);
  });

  it("builds \"is inside\" from the parent's children, and follows them", async () => {
    let children = ["a"];
    const fake = fakeDocuments((filter) => {
      const text = JSON.stringify(filter);
      if (text.includes('"parent"')) return [{ id: "parent", plugins: { folders: { children } } }];
      return children.filter((child) => text.includes(`"${child}"`)).map((id) => ({ id }));
    });
    const matcher = ruleMatcher(fake.documents, () => {}, () => {});
    matcher.set([rule("1", [{ id: "c", field: "", op: "child_of", value: "parent", kind: "str" }], { icon: "folder" })]);
    await settle();
    await settle();
    expect(matcher.matched("a")).toEqual([{ icon: "folder" }]);

    children = ["a", "b"];
    fake.emit();
    await settle();
    expect(matcher.matched("b")).toEqual([{ icon: "folder" }]);
  });

  it("with \"including nested\", follows the whole subtree", async () => {
    const tree: Record<string, string[]> = { top: ["mid"], mid: ["leaf"] };
    const fake = fakeDocuments((filter) => {
      const text = JSON.stringify(filter);
      if (text.includes('"exists"')) return Object.entries(tree).map(([id, children]) => ({ id, plugins: { folders: { children } } }));
      return ["mid", "leaf", "deeper"].filter((id) => text.includes(`"${id}"`)).map((id) => ({ id }));
    });
    const matcher = ruleMatcher(fake.documents, () => {}, () => {});
    matcher.set([rule("1", [{ id: "c", field: "", op: "child_of", value: "top", kind: "str", deep: true }], { icon: "tree" })]);
    await settle();
    await settle();
    expect(matcher.matched("mid")).toEqual([{ icon: "tree" }]);
    expect(matcher.matched("leaf")).toEqual([{ icon: "tree" }]);

    tree["leaf"] = ["deeper"];
    fake.emit();
    await settle();
    expect(matcher.matched("deeper")).toEqual([{ icon: "tree" }]);
  });

  it("keeps a rule's query when only another rule changed, and closes all on close", async () => {
    const fake = fakeDocuments(() => []);
    const matcher = ruleMatcher(fake.documents, () => {}, () => {});
    const first = rule("1", [{ id: "c1", field: "fm.a", op: "exists", value: "", kind: "str" }], {});
    matcher.set([first, rule("2", [{ id: "c2", field: "fm.b", op: "exists", value: "", kind: "str" }], {})]);
    await settle();
    matcher.set([first, rule("2", [{ id: "c2", field: "fm.c", op: "exists", value: "", kind: "str" }], {})]);
    await settle();
    expect(fake.open).toHaveLength(3);
    expect(fake.open.map((each) => each.closed)).toEqual([false, true, false]);
    matcher.close();
    expect(fake.open.every((each) => each.closed)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { fakeSearch } from "../../_shared/fake-search.test-util.js";
import { ruleMatcher } from "./matcher.js";
import type { Rule } from "./styles.js";

const rule = (id: string, clauses: Rule["when"]["clauses"], style: Rule["style"]): Rule => ({
  id,
  when: { combine: "and", clauses },
  style,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ruleMatcher", () => {
  it("answers each note with the looks of the rules it matches, in order", async () => {
    const fake = fakeSearch((plan) => {
      const text = JSON.stringify(plan);
      if (text.includes('"work"')) return [{ id: "a" }, { id: "b" }];
      if (text.includes('"home"')) return [{ id: "b" }];
      return [];
    });
    const matcher = ruleMatcher(fake.search, () => {}, () => {});
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
    const fake = fakeSearch(() => [{ id: "a" }]);
    const matcher = ruleMatcher(fake.search, () => {}, () => {});
    matcher.set([rule("1", [], { icon: "x" }), rule("2", [{ id: "c", field: "", op: "eq", value: "", kind: "str" }], { icon: "y" })]);
    await settle();
    expect(fake.watches).toHaveLength(0);
    expect(matcher.matched("a")).toEqual([]);
  });

  it("asks for \"is inside\" and \"including nested\" with the native folder operator", async () => {
    const fake = fakeSearch(() => [{ id: "a" }]);
    const matcher = ruleMatcher(fake.search, () => {}, () => {});
    matcher.set([
      rule("1", [{ id: "c", field: "", op: "child_of", value: "parent", kind: "str" }], { icon: "folder" }),
      rule("2", [{ id: "d", field: "", op: "child_of", value: "top", kind: "str", deep: true }], { icon: "tree" }),
    ]);
    await settle();
    expect(fake.watches.map((each) => each.plan.stages?.[0])).toEqual([
      { where: { child_of: { field: "id", of: "parent", deep: false } } },
      { where: { child_of: { field: "id", of: "top", deep: true } } },
    ]);
    expect(matcher.matched("a")).toEqual([{ icon: "folder" }, { icon: "tree" }]);
    fake.emit();
    await settle();
    expect(matcher.matched("a")).toEqual([{ icon: "folder" }, { icon: "tree" }]);
  });

  it("keeps a rule's query when only another rule changed, and closes all on close", async () => {
    const fake = fakeSearch(() => []);
    const matcher = ruleMatcher(fake.search, () => {}, () => {});
    const first = rule("1", [{ id: "c1", field: "fm.a", op: "exists", value: "", kind: "str" }], {});
    matcher.set([first, rule("2", [{ id: "c2", field: "fm.b", op: "exists", value: "", kind: "str" }], {})]);
    await settle();
    matcher.set([first, rule("2", [{ id: "c2", field: "fm.c", op: "exists", value: "", kind: "str" }], {})]);
    await settle();
    expect(fake.watches).toHaveLength(3);
    expect(fake.watches.map((each) => each.closed)).toEqual([false, true, false]);
    matcher.close();
    expect(fake.watches.every((each) => each.closed)).toBe(true);
  });
});

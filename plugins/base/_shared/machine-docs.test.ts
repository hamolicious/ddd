import { describe, expect, it, beforeAll } from "vitest";

import type { FilterJson } from "@kernel";

import { coreArtifactExists, loadCoreForNode } from "@kernel/wasm/node-core.js";
import type { CoreBindings, FilterRow } from "@kernel/wasm/index.js";

import {
  EXCLUDE_MACHINE_DOCUMENTS,
  isMachineDocument,
  withoutMachineDocuments,
} from "./machine-docs.js";

describe("isMachineDocument", () => {
  it("is true for `machine: true` only", () => {
    expect(isMachineDocument({ fm: { machine: true } })).toBe(true);
    expect(isMachineDocument({ fm: {} })).toBe(false);
    expect(isMachineDocument({ fm: { machine: false } })).toBe(false);
    expect(isMachineDocument({ fm: { machine: "true" } })).toBe(false);
    expect(isMachineDocument({ fm: { path: ".settings" } })).toBe(false);
  });
});

describe("withoutMachineDocuments", () => {
  it("is the bare exclusion when there is no filter to combine with", () => {
    expect(withoutMachineDocuments()).toEqual(EXCLUDE_MACHINE_DOCUMENTS);
  });

  it("ands onto an existing filter rather than replacing it", () => {
    const mine: FilterJson = { cmp: { field: "title", op: "eq", value: { str: "x" } } };
    expect(withoutMachineDocuments(mine)).toEqual({
      and: [mine, EXCLUDE_MACHINE_DOCUMENTS],
    });
  });
});

const row = (fm: Record<string, unknown>): FilterRow => ({
  id: "01J8Z",
  title: "t",
  content: "",
  fm: fm as FilterRow["fm"],
  plugins: {},
  deleted: false,
});

describe.skipIf(!coreArtifactExists())("the exclusion, evaluated by the shared core", () => {
  let core: CoreBindings;
  beforeAll(async () => {
    core = await loadCoreForNode();
  });

  const matches = (fm: Record<string, unknown>): boolean =>
    core.evaluateFilter(EXCLUDE_MACHINE_DOCUMENTS, row(fm));

  it("keeps a document that has no `machine` key at all", () => {
    expect(matches({})).toBe(true);
    expect(matches({ title: "x" })).toBe(true);
  });

  it("drops `machine: true` and keeps every other value", () => {
    expect(matches({ machine: true })).toBe(false);
    expect(matches({ machine: false })).toBe(true);
    expect(matches({ machine: "true" })).toBe(true);
    expect(matches({ machine: null })).toBe(true);
  });

  it("agrees with `isMachineDocument` on every case above", () => {
    for (const value of [true, false, "true", null, 1]) {
      expect(`${String(value)} → ${String(matches({ machine: value }))}`).toBe(
        `${String(value)} → ${String(!isMachineDocument({ fm: { machine: value } }))}`,
      );
    }
  });
});

/**
 * The machine-document rule, and the one property that is easy to get backwards.
 *
 * `EXCLUDE_MACHINE_DOCUMENTS` is a **negated** comparison, so what it does to a
 * document with no `machine` key decides whether the default list shows everything or
 * nothing. The shared core answers `Ok(false)` for a comparison against a missing field,
 * so the negation is `true` and an ordinary document survives — but that is a property
 * of `filter/evaluator.rs`, not of this file, which is why it is asserted against the
 * real Wasm evaluator below rather than reasoned about in a comment.
 */

import { describe, expect, it, beforeAll } from "vitest";

import type { FilterJson } from "@kernel";

// Kernel internals, in a **test only**. `web/README.md`'s rule — a plugin imports
// `@kernel` and nothing under it — is about what ends up in a plugin's *bundle*, and
// `build:plugins` builds `src/index.tsx`; no `*.test.ts` is ever bundled or served. The
// alternative was asserting this rule against a hand-written stand-in for the
// evaluator, which is precisely the reasoning the suite exists to replace.
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
    // The whole reason this suite exists. A comparison against a missing field is
    // `Ok(false)`, so `not` is true; if it were an error the negation would be an
    // error too, the Wasm bridge would answer false, and the default document list
    // would be **empty** for every ordinary document in the workspace.
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

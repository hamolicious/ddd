/**
 * The machine-document rule, and the one property that is easy to get backwards.
 *
 * `EXCLUDE_MACHINE_DOCUMENTS` is a **negated** text clause, so what it does to a
 * document with no `fm.path` decides whether the default list shows everything or
 * nothing. The shared core answers `Ok(false)` for `text` against a missing field, so
 * the negation is `true` and an unfiled document survives — but that is a property of
 * `filter/evaluator.rs`, not of this file, which is why it is asserted against the real
 * Wasm evaluator below rather than reasoned about in a comment.
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
  isMachinePath,
  withoutMachineDocuments,
} from "./machine-docs.js";

describe("isMachinePath", () => {
  it("recognises a dotted path", () => {
    expect(isMachinePath(".settings")).toBe(true);
    expect(isMachinePath(".plugin-state/calendar")).toBe(true);
  });

  it("leaves ordinary paths alone, dots in the middle included", () => {
    expect(isMachinePath("home/lists")).toBe(false);
    expect(isMachinePath("home/.private")).toBe(false);
    expect(isMachinePath("")).toBe(false);
    expect(isMachinePath("settings")).toBe(false);
  });

  it("is false for a `fm.path` that is not a string, because the workspace is shared", () => {
    expect(isMachinePath(undefined)).toBe(false);
    expect(isMachinePath(7)).toBe(false);
    expect(isMachinePath([".settings"])).toBe(false);
    expect(isMachinePath(null)).toBe(false);
  });

  it("answers the same question about a row", () => {
    expect(isMachineDocument({ fm: { path: ".settings" } })).toBe(true);
    expect(isMachineDocument({ fm: { path: "home" } })).toBe(false);
    expect(isMachineDocument({ fm: {} })).toBe(false);
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

  it("keeps a document that has no `fm.path` at all", () => {
    // The whole reason this suite exists. `text` against a missing field is
    // `Ok(false)`, so `not` is true; if it were an error the negation would be an
    // error too, the Wasm bridge would answer false, and the default document list
    // would be **empty** for every unfiled document in the workspace.
    expect(matches({})).toBe(true);
    expect(matches({ title: "x" })).toBe(true);
  });

  it("keeps ordinary paths and drops dotted ones", () => {
    expect(matches({ path: "home/lists" })).toBe(true);
    expect(matches({ path: "" })).toBe(true);
    expect(matches({ path: ".settings" })).toBe(false);
    expect(matches({ path: ".settings/anything" })).toBe(false);
  });

  it("keeps a document whose `fm.path` is not a string", () => {
    // `text` against a non-string value is `Ok(false)` as well, so these survive —
    // which is right: a malformed `fm.path` is a human's document with a typo in it.
    expect(matches({ path: 7 })).toBe(true);
    expect(matches({ path: [".settings"] })).toBe(true);
  });

  it("agrees with `isMachinePath` on every case above", () => {
    for (const path of [".settings", "home/lists", "", ".x/y", "settings"]) {
      expect(`${path} → ${String(matches({ path }))}`).toBe(
        `${path} → ${String(!isMachinePath(path))}`,
      );
    }
  });
});

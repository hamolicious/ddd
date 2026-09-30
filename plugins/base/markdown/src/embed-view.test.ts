import { describe, expect, it } from "vitest";

import type { DocumentRow, Kernel, RegistryEntry } from "@kernel";
import type { DocumentMode } from "plugin:document-surface";

import { createRuntime } from "./runtime.js";

const kernel = {
  pluginId: "markdown",
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  ui: { boundary: <P,>(component: P) => component },
} as unknown as Kernel;

const host = (modes: readonly DocumentMode[]): { modes: () => readonly RegistryEntry<DocumentMode>[] } => ({
  modes: () => modes.map((value) => ({ pluginId: "p", value })),
});

const row = (fm: DocumentRow["fm"]): DocumentRow => ({ id: "01J", fm }) as DocumentRow;
const Read = (): null => null;
const Results = (): null => null;
const isSearch = (candidate: DocumentRow): boolean => candidate.fm.search === true;

describe("embedView", () => {
  const runtime = createRuntime(
    kernel,
    host([
      { id: "read", label: "Read", component: Read },
      { id: "results", label: "Results", component: Results, when: isSearch, prefer: isSearch },
    ]),
  );

  it("is the view that claims the document", () => {
    expect(runtime.embedView?.(row({ search: true }))).toBe(Results);
  });

  it("is nothing for a document no view claims, whatever the default", () => {
    expect(runtime.embedView?.(row({}))).toBeUndefined();
  });

  it("skips a claim whose `when` rejects the document, and one that throws", () => {
    const bad = createRuntime(
      kernel,
      host([
        { id: "hidden", label: "Hidden", component: Read, when: () => false, prefer: () => true },
        { id: "broken", label: "Broken", component: Read, prefer: () => { throw new Error("boom"); } },
      ]),
    );
    expect(bad.embedView?.(row({}))).toBeUndefined();
  });
});

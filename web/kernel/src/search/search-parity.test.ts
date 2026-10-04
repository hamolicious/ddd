import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

import { feedRow } from "../store/testing.js";
import type { CoreBindings } from "../wasm/index.js";
import { coreArtifactExists, loadCoreForNode } from "../wasm/node-core.js";
import { ProjectionHost } from "./backend.js";
import { SearchPlanError } from "@kernel";
import { reviveSearchError } from "./revive.js";
import { serializeSearchError } from "./errors.js";

interface SearchCorpus {
  readonly documents: readonly {
    readonly id: string;
    readonly content: string;
    readonly updated_at: string;
    readonly deleted?: boolean;
  }[];
  readonly cases: readonly {
    readonly name: string;
    readonly plan: unknown;
    readonly ids?: readonly string[];
    readonly rows?: readonly unknown[];
    readonly total?: number;
  }[];
  readonly errors: readonly { readonly name: string; readonly plan: unknown; readonly kind: string }[];
}

describe.skipIf(!coreArtifactExists())("search plans in the Wasm build agree with the Rust corpus", () => {
  let core: CoreBindings;
  let corpus: SearchCorpus;
  let host: ProjectionHost;

  beforeAll(async () => {
    core = await loadCoreForNode();
    corpus = JSON.parse(
      await readFile(new URL("../../../../backend/crates/core/corpus/search.json", import.meta.url), "utf8"),
    ) as SearchCorpus;
    host = new ProjectionHost({ core, persistent: false });
    await host.open();
    await host.sync(
      corpus.documents.map((document, index) =>
        feedRow({
          id: document.id,
          seq: index + 1,
          content: document.content,
          updated_at: document.updated_at,
          deleted: document.deleted === true,
          deleted_at: document.deleted === true ? document.updated_at : null,
        }),
      ),
      true,
      true,
    );
  });

  it("returns the corpus rows for every case", async () => {
    for (const testCase of corpus.cases) {
      const result = await host.run(testCase.plan);
      if (testCase.ids) expect(result.rows.map((row) => row.id), testCase.name).toEqual(testCase.ids);
      if (testCase.rows) expect(result.rows, testCase.name).toEqual(testCase.rows);
      expect(result.total, testCase.name).toBe(testCase.total);
    }
  });

  it("rejects the corpus errors with a typed plan error", async () => {
    for (const testCase of corpus.errors) {
      const error = await host.run(testCase.plan).catch((cause: unknown) => reviveSearchError(serializeSearchError(cause)));
      expect(error, testCase.name).toBeInstanceOf(SearchPlanError);
      expect((error as SearchPlanError).kind, testCase.name).toBe(testCase.kind);
    }
  });

  it("ranks fuzzy matches with hits in the Wasm build", async () => {
    const result = await host.run({ stages: [{ fuzzy: { query: "alpah", fields: ["title"] } }] });
    expect(result.rows.map((row) => row.id)).toEqual(["A"]);
    expect(result.hits?.A?.terms).toEqual(["Alpha"]);
  });

  it("folds accented capitals and finds short typos in the Wasm build", async () => {
    const small = new ProjectionHost({ core, persistent: false });
    await small.open();
    await small.sync(
      [
        feedRow({ id: "E", seq: 1, content: "# ÉCOLE\n" }),
        ...Array.from({ length: 1200 }, (_, index) => feedRow({ id: `N${String(index).padStart(5, "0")}`, seq: index + 2, content: `# Note ${index}\n` })),
        feedRow({ id: "Z", seq: 2000, content: "# Milk\n" }),
      ],
      true,
      true,
    );
    const folded = await small.run({ stages: [{ where: { text: { field: "title", mode: "contains", value: "école" } } }] });
    expect(folded.rows.map((row) => row.id)).toEqual(["E"]);
    const typo = await small.run({ stages: [{ fuzzy: { query: "mlik", limit: 3 } }] });
    expect(typo.rows.map((row) => row.id)).toEqual(["Z"]);
  });

  it("pages with cursors until every row has been seen once", async () => {
    const seen: unknown[] = [];
    let cursor: string | undefined;
    for (;;) {
      const stages: unknown[] = [{ sort: ["-fm.priority"] }];
      if (cursor) stages.push({ cursor });
      stages.push({ limit: 2 });
      const page = await host.run({ stages });
      seen.push(...page.rows.map((row) => row.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["B", "A", "C", "F", "S"]);
  });
});

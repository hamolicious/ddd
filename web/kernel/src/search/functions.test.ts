import { beforeAll, describe, expect, it } from "vitest";

import type { CoreBindings } from "../wasm/index.js";
import { coreArtifactExists, loadCoreForNode } from "../wasm/node-core.js";
import { openSearchDatabase } from "./database.js";
import { coreSqlFunctions, type SqlFunction } from "./functions.js";

describe.skipIf(!coreArtifactExists())("SQL functions in the search database", () => {
  let core: CoreBindings;

  beforeAll(async () => {
    core = await loadCoreForNode();
  });

  it("registers the core's Rust functions, so SQL calls into the shared core", async () => {
    const functions = coreSqlFunctions(core);
    expect(functions.map((fn) => fn.name)).toContain("ddd_fold");
    const db = await openSearchDatabase({ persistent: false, functions });
    try {
      expect(db.select("SELECT ddd_fold('CaFÉ') AS folded, ddd_fold(3) AS number, ddd_fold(NULL) AS missing")).toEqual([
        { folded: "café", number: 3, missing: null },
      ]);
    } finally {
      db.close();
    }
  });

  it("takes more functions later and keeps them across a reset", async () => {
    const db = await openSearchDatabase({ persistent: false, functions: coreSqlFunctions(core) });
    const twice: SqlFunction = {
      name: "test_twice",
      arity: 1,
      deterministic: true,
      call: ([value]) => (typeof value === "number" ? value * 2 : null),
    };
    try {
      db.register([twice]);
      expect(db.select("SELECT test_twice(21) AS answer")).toEqual([{ answer: 42 }]);
      await db.reset();
      expect(db.select("SELECT test_twice(4) AS answer, ddd_fold('A') AS folded")).toEqual([{ answer: 8, folded: "a" }]);
      expect(() => db.register([{ ...twice, name: "TEST_TWICE" }])).toThrow(/already registered/);
    } finally {
      db.close();
    }
  });
});

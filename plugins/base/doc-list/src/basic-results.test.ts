import { describe, expect, it } from "vitest";

import { fakeSearch } from "../../_shared/fake-search.test-util.js";
import { EXCLUDE_MACHINE_DOCUMENTS } from "../../_shared/machine-docs.js";

import { basicQuery } from "./basic-results.js";

describe("the basic documents search", () => {
  const { search } = fakeSearch(() => []);

  it("lists every document, last updated first, while there is no text", () => {
    expect(basicQuery(search, "").plan().stages).toEqual([{ where: EXCLUDE_MACHINE_DOCUMENTS }, "with_total", { sort: ["-updated_at"] }]);
  });

  it("ranks by typo-tolerant matching once there is text, still hiding machine documents", () => {
    expect(basicQuery(search, "teh qick").plan().stages).toEqual([
      { where: EXCLUDE_MACHINE_DOCUMENTS },
      "with_total",
      "with_content",
      { fuzzy: { query: "teh qick" } },
    ]);
  });
});

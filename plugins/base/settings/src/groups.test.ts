import { describe, expect, it } from "vitest";

import { baseIdsFrom, groupByBase } from "./groups.js";

const entries = [
  { pluginId: "themes", id: "a" },
  { pluginId: "my-extension", id: "b" },
  { pluginId: "header", id: "c" },
];

describe("groupByBase", () => {
  it("puts base plugins' sections first and the rest after, keeping order", () => {
    const grouped = groupByBase(entries, new Set(["themes", "header"]));
    expect(grouped.base.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(grouped.extensions.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("is one group while the base list is unknown", () => {
    expect(groupByBase(entries, undefined)).toEqual({ base: entries, extensions: [] });
  });
});

describe("baseIdsFrom", () => {
  it("reads the base ids from the plugin list", () => {
    const body = {
      plugins: [
        { base: true, manifest: { id: "themes" } },
        { base: false, manifest: { id: "my-extension" } },
      ],
    };
    expect(baseIdsFrom(body)).toEqual(["themes"]);
  });

  it("refuses a body that is not a plugin list", () => {
    expect(baseIdsFrom({ nope: true })).toBeUndefined();
    expect(baseIdsFrom(null)).toBeUndefined();
  });
});

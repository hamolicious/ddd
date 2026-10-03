import { describe, expect, it } from "vitest";

import { baseIdsFrom, groupByBase } from "./groups.js";

const entries = [
  { pluginId: "themes", id: "a" },
  { pluginId: "my-extension", id: "b" },
  { pluginId: "header", id: "c" },
  { pluginId: "kernel", id: "about" },
];

describe("groupByBase", () => {
  it("puts base plugins' sections first and the rest after, keeping order", () => {
    const grouped = groupByBase(entries, new Set(["themes", "header"]));
    expect(grouped.base.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(grouped.extensions.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("keeps the app's own sections apart, for the end of the list", () => {
    expect(groupByBase(entries, new Set(["themes"])).app.map((entry) => entry.id)).toEqual(["about"]);
    expect(groupByBase(entries, undefined).app.map((entry) => entry.id)).toEqual(["about"]);
  });

  it("is one group of plugin sections while the base list is unknown", () => {
    const grouped = groupByBase(entries, undefined);
    expect(grouped.base.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(grouped.extensions).toEqual([]);
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

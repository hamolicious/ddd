import { describe, expect, it } from "vitest";

import type { PluginAdminView } from "./api.js";
import { describeSkip, pluginRelations, providedId } from "./relations.js";

function plugin(
  id: string,
  manifest: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; provides?: string } = {},
  state: PluginAdminView["state"] = "enabled",
): PluginAdminView {
  return { id, state, manifest: { id, version: "1.0.0", kernel: "^3.0", ...manifest } } as unknown as PluginAdminView;
}

describe("pluginRelations", () => {
  it("lists dependencies, optional ones and dependents, sorted", () => {
    const relations = pluginRelations([
      plugin("changes", { dependencies: { router: "^2.0", "context-menu": "^2.0" }, optionalDependencies: { icons: "^2.0" } }),
      plugin("router"),
      plugin("context-menu"),
      plugin("header", { optionalDependencies: { router: "^2.0" } }),
    ]);
    const changes = relations.get("changes");
    expect(changes?.dependsOn.map((dep) => [dep.id, dep.range, dep.status])).toEqual([
      ["context-menu", "^2.0", "ok"],
      ["router", "^2.0", "ok"],
    ]);
    expect(changes?.optional).toEqual([{ id: "icons", range: "^2.0", status: "missing" }]);
    expect(relations.get("router")?.neededBy).toEqual(["changes", "header"]);
  });

  it("flags a dependency that is only installed disabled", () => {
    const relations = pluginRelations([plugin("a", { dependencies: { b: "^1.0" } }), plugin("b", {}, "disabled")]);
    expect(relations.get("a")?.dependsOn[0]?.status).toBe("disabled");
  });

  it("counts a stand-in as the id it provides, and reports the conflict both ways", () => {
    const relations = pluginRelations([
      plugin("editor"),
      plugin("alt-editor", { provides: "editor@2.0.0" }, "disabled"),
      plugin("doc", { dependencies: { editor: "^2.0" } }),
    ]);
    expect(relations.get("alt-editor")?.standsInFor).toBe("editor");
    expect(relations.get("alt-editor")?.conflictsWith).toEqual(["editor"]);
    expect(relations.get("editor")?.conflictsWith).toEqual(["alt-editor"]);
    expect(relations.get("alt-editor")?.neededBy).toEqual(["doc"]);
  });

  it("ignores pending installs and attaches the loader's skip reason", () => {
    const relations = pluginRelations(
      [plugin("a", { dependencies: { gone: "^1.0" } }), plugin("p", {}, "pending")],
      [{ id: "a", reason: "missing", detail: "needs gone ^1.0, which is not installed" }],
    );
    expect(relations.has("p")).toBe(false);
    expect(relations.get("a")?.skipped?.reason).toBe("missing");
    expect(describeSkip("dependency-skipped")).toBe("A dependency is not loaded");
  });

  it("reads the id out of provides", () => {
    expect(providedId("editor@2.0.0")).toBe("editor");
    expect(providedId(undefined)).toBeUndefined();
  });
});

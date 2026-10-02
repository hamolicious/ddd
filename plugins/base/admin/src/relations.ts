import type { PluginAdminView, SkippedPlugin } from "./api.js";

export interface DependencyView {
  readonly id: string;
  readonly range: string;
  readonly status: "ok" | "missing" | "disabled";
}

export interface PluginRelations {
  readonly dependsOn: readonly DependencyView[];
  readonly optional: readonly DependencyView[];
  readonly neededBy: readonly string[];
  readonly standsInFor?: string;
  readonly conflictsWith: readonly string[];
  readonly skipped?: SkippedPlugin;
}

export function providedId(provides: string | undefined): string | undefined {
  if (!provides) return undefined;
  const at = provides.lastIndexOf("@");
  return at > 0 ? provides.slice(0, at) : provides;
}

function answersTo(plugin: PluginAdminView): readonly string[] {
  const provided = providedId(plugin.manifest.provides);
  return provided && provided !== plugin.id ? [plugin.id, provided] : [plugin.id];
}

export function pluginRelations(
  plugins: readonly PluginAdminView[],
  skipped: readonly SkippedPlugin[] = [],
): ReadonlyMap<string, PluginRelations> {
  const installed = plugins.filter((plugin) => plugin.state !== "pending");
  const byAnswer = new Map<string, PluginAdminView[]>();
  for (const plugin of installed) {
    for (const id of answersTo(plugin)) {
      const list = byAnswer.get(id) ?? [];
      list.push(plugin);
      byAnswer.set(id, list);
    }
  }
  const skippedById = new Map(skipped.map((entry) => [entry.id, entry]));

  const dependencies = (ranges: Readonly<Record<string, string>> | undefined): readonly DependencyView[] =>
    Object.entries(ranges ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, range]) => {
        const candidates = byAnswer.get(id) ?? [];
        const status =
          candidates.length === 0 ? "missing" : candidates.some((plugin) => plugin.state !== "disabled") ? "ok" : "disabled";
        return { id, range, status };
      });

  const result = new Map<string, PluginRelations>();
  for (const plugin of installed) {
    const ids = answersTo(plugin);
    const neededBy = installed
      .filter((other) => other.id !== plugin.id)
      .filter((other) => {
        const named = { ...other.manifest.optionalDependencies, ...other.manifest.dependencies };
        return ids.some((id) => id in named);
      })
      .map((other) => other.id)
      .sort();
    const conflictsWith = [
      ...new Set(ids.flatMap((id) => (byAnswer.get(id) ?? []).map((other) => other.id))),
    ]
      .filter((id) => id !== plugin.id)
      .sort();
    const standsInFor = providedId(plugin.manifest.provides);
    const skip = skippedById.get(plugin.id);
    result.set(plugin.id, {
      dependsOn: dependencies(plugin.manifest.dependencies),
      optional: dependencies(plugin.manifest.optionalDependencies),
      neededBy,
      ...(standsInFor !== undefined && standsInFor !== plugin.id ? { standsInFor } : {}),
      conflictsWith,
      ...(skip !== undefined ? { skipped: skip } : {}),
    });
  }
  return result;
}

export function describeSkip(reason: SkippedPlugin["reason"]): string {
  switch (reason) {
    case "missing":
      return "A dependency is missing";
    case "version":
      return "A dependency is the wrong version";
    case "cycle":
      return "Its dependencies form a cycle";
    case "dependency-skipped":
      return "A dependency is not loaded";
    case "conflict":
      return "Another plugin holds the same id";
    default:
      return "Not loaded";
  }
}

/**
 * How the installed plugins relate: what each depends on, what depends on it, which
 * plugins answer to the same id (`provides`), and why the loader skipped it. Pure; the
 * plugin list renders it.
 */

import type { PluginAdminView, SkippedPlugin } from "./api.js";

/** One declared dependency and whether the installed set has it. */
export interface DependencyView {
  readonly id: string;
  readonly range: string;
  /** `"missing"`: nothing installed answers to the id. `"disabled"`: only disabled ones do. */
  readonly status: "ok" | "missing" | "disabled";
}

export interface PluginRelations {
  readonly dependsOn: readonly DependencyView[];
  readonly optional: readonly DependencyView[];
  /** Plugins that list this one (or the id it stands in for), required or optional. */
  readonly neededBy: readonly string[];
  /** The id this plugin stands in for, from `provides: "<id>@<version>"`. */
  readonly standsInFor?: string;
  /** Other installed plugins answering to the same id. Only one of them can be enabled. */
  readonly conflictsWith: readonly string[];
  /** Why the loader leaves it out, when it does. */
  readonly skipped?: SkippedPlugin;
}

/** `"editor@2.0.0"` → `"editor"`. */
export function providedId(provides: string | undefined): string | undefined {
  if (!provides) return undefined;
  const at = provides.lastIndexOf("@");
  return at > 0 ? provides.slice(0, at) : provides;
}

/** The ids a plugin answers to: its own, and the one it stands in for. */
function answersTo(plugin: PluginAdminView): readonly string[] {
  const provided = providedId(plugin.manifest.provides);
  return provided && provided !== plugin.id ? [plugin.id, provided] : [plugin.id];
}

/** Every installed (not pending) plugin's relations, by id. */
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

/** The skip reason in words, for the badge beside the detail sentence. */
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

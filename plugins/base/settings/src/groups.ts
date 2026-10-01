/**
 * Base-distribution sections first, extensions after a divider.
 *
 * Which plugins are base is the server's answer (`GET /api/plugins`, the list the loader
 * boots from, `base: true` per plugin). It is cached per device so the grouping survives
 * offline; until it is known the list stays one group, which is also what a workspace
 * with no extension settings looks like.
 */

import { useEffect, useState } from "react";

import type { Kernel } from "@kernel";

const CACHE_KEY = "ddd.settings.base-plugins";

export interface Grouped<T> {
  readonly base: readonly T[];
  readonly extensions: readonly T[];
}

/** Split entries by whether their plugin is base; unknown means everything is base. */
export function groupByBase<T extends { readonly pluginId: string }>(
  entries: readonly T[],
  baseIds: ReadonlySet<string> | undefined,
): Grouped<T> {
  if (!baseIds) return { base: entries, extensions: [] };
  return {
    base: entries.filter((entry) => baseIds.has(entry.pluginId)),
    extensions: entries.filter((entry) => !baseIds.has(entry.pluginId)),
  };
}

/** The ids of base plugins in `GET /api/plugins`'s body; `undefined` if it is not one. */
export function baseIdsFrom(body: unknown): string[] | undefined {
  const plugins = (body as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(plugins)) return undefined;
  const ids: string[] = [];
  for (const plugin of plugins) {
    const entry = plugin as { base?: unknown; manifest?: { id?: unknown } } | null;
    if (entry?.base === true && typeof entry.manifest?.id === "string") ids.push(entry.manifest.id);
  }
  return ids;
}

function readCache(): Set<string> | undefined {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : undefined;
    return Array.isArray(ids) ? new Set(ids.filter((id) => typeof id === "string")) : undefined;
  } catch {
    return undefined;
  }
}

export function useBasePluginIds(kernel: Kernel): ReadonlySet<string> | undefined {
  const [ids, setIds] = useState<ReadonlySet<string> | undefined>(readCache);
  useEffect(() => {
    let cancelled = false;
    kernel.session
      .fetch("/plugins")
      .then(async (response) => (response.ok ? baseIdsFrom(await response.json()) : undefined))
      .then((fresh) => {
        if (cancelled || !fresh) return;
        setIds(new Set(fresh));
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(fresh));
        } catch {
          // Per-device convenience only.
        }
      })
      .catch(() => {
        // Offline or refused: the cached grouping (or none) stands.
      });
    return () => {
      cancelled = true;
    };
  }, [kernel]);
  return ids;
}

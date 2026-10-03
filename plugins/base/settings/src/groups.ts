import { useEffect, useState } from "react";

import type { Kernel } from "@kernel";

const CACHE_KEY = "ddd.settings.base-plugins";

export interface Grouped<T> {
  readonly base: readonly T[];
  readonly extensions: readonly T[];
  readonly app: readonly T[];
}

export const APP_SECTION_OWNER = "kernel";

export function groupByBase<T extends { readonly pluginId: string }>(
  entries: readonly T[],
  baseIds: ReadonlySet<string> | undefined,
): Grouped<T> {
  const app = entries.filter((entry) => entry.pluginId === APP_SECTION_OWNER);
  const plugins = entries.filter((entry) => entry.pluginId !== APP_SECTION_OWNER);
  if (!baseIds) return { base: plugins, extensions: [], app };
  return {
    base: plugins.filter((entry) => baseIds.has(entry.pluginId)),
    extensions: plugins.filter((entry) => !baseIds.has(entry.pluginId)),
    app,
  };
}

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
        }
      })
      .catch(() => {
      });
    return () => {
      cancelled = true;
    };
  }, [kernel]);
  return ids;
}

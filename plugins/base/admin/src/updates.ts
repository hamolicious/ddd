import { s, validate, type EventsApi, type KernelEvent, type Unsubscribe } from "@kernel";

import type { PluginAdminView } from "./api.js";
import type { InstalledPackage, RemotePackageRequest } from "./sources.js";

export const UPDATE_AVAILABLE = "admin:update-available";

export interface PluginUpdate {
  readonly plugin: string;
  readonly source: string;
  readonly current: string;
  readonly latest: string;
  readonly install: RemotePackageRequest;
}

export interface ReportedUpdate extends PluginUpdate {
  readonly reportedBy: string;
}

const updateShape = s.object({
  plugin: s.string(),
  source: s.string(),
  current: s.string(),
  latest: s.string(),
  install: s.object({
    url: s.string(),
    headers: s.optional(s.record(s.string())),
    label: s.optional(s.string()),
  }),
});

export interface UpdateStore {
  readonly get: () => ReadonlyMap<string, ReportedUpdate>;
  readonly subscribe: (listener: () => void) => Unsubscribe;
  readonly report: (update: ReportedUpdate) => void;
  readonly forget: (plugin: string) => void;
  readonly clear: (source?: string) => void;
}

export function createUpdateStore(): UpdateStore {
  let updates: ReadonlyMap<string, ReportedUpdate> = new Map();
  const listeners = new Set<() => void>();
  const commit = (next: Map<string, ReportedUpdate>): void => {
    updates = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => updates,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    report: (update) => commit(new Map(updates).set(update.plugin, update)),
    forget: (plugin) => {
      if (!updates.has(plugin)) return;
      const next = new Map(updates);
      next.delete(plugin);
      commit(next);
    },
    clear: (source) =>
      commit(new Map([...updates].filter(([, update]) => source !== undefined && update.source !== source))),
  };
}

export const updateStore = createUpdateStore();

export function parseUpdate(event: KernelEvent<unknown>): ReportedUpdate | undefined {
  if (validate(updateShape, event.payload).length > 0) return undefined;
  const update = event.payload as PluginUpdate;
  const reportedBy =
    event.origin.kind === "plugin" ? event.origin.id : event.origin.kind === "server" ? event.origin.plugin : "kernel";
  return { ...update, reportedBy };
}

export function listenForUpdates(events: EventsApi, store: UpdateStore = updateStore): Unsubscribe {
  return events.on<unknown>(UPDATE_AVAILABLE, (event) => {
    const update = parseUpdate(event);
    if (update) store.report(update);
  });
}

export function installedFrom(plugins: readonly PluginAdminView[], source: string): readonly InstalledPackage[] {
  const found: InstalledPackage[] = [];
  for (const plugin of plugins) {
    if (plugin.source.kind !== "remote" || plugin.source.via !== source) continue;
    found.push({
      id: plugin.id,
      version: plugin.version,
      url: plugin.source.url,
      authenticated: plugin.source.authenticated,
    });
  }
  return found;
}

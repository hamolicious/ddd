import { createContext, useContext, type ComponentType } from "react";

import { createRegistry, s, type Kernel } from "@kernel";

import type { AdminClient, PluginInstallOutcome, SavedSource, SourceSettings } from "./api.js";

export interface SetupProps {
  readonly value: SourceSettings;
  readonly onChange: (next: SourceSettings) => void;
  readonly disabled: boolean;
}

export interface AvailablePackage {
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly plugin?: string;
  readonly description?: string;
}

export interface InstalledPackage {
  readonly id: string;
  readonly version: string;
  readonly url: string;
}

export interface PackageProvider {
  readonly id: string;
  readonly title: string;
  readonly setup: ComponentType<SetupProps>;
  readonly browse: (source: SavedSource) => Promise<readonly AvailablePackage[]>;
  readonly download: (source: SavedSource, url: string) => Promise<Blob>;
  readonly checkUpdates?: (source: SavedSource, plugins: readonly InstalledPackage[]) => Promise<void>;
  readonly defaults?: () => SourceSettings;
  readonly validate?: (settings: SourceSettings) => string | undefined;
  readonly description?: string;
  readonly order?: number;
}

export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export const providerRegistry = createRegistry<PackageProvider>({
  key: (provider) => provider.id,
  order: (provider) => provider.order ?? 100,
  shape: s.object({
    id: s.string(),
    title: s.string(),
    setup: s.component(),
    browse: s.func(),
    download: s.func(),
    checkUpdates: s.optional(s.func()),
    defaults: s.optional(s.func()),
    validate: s.optional(s.func()),
    description: s.optional(s.string()),
    order: s.optional(s.number()),
  }),
});

export const addPackageProvider = (items: PackageProvider | readonly PackageProvider[]): (() => void) => {
  for (const item of Array.isArray(items) ? items : [items as PackageProvider]) {
    if (!PROVIDER_ID_PATTERN.test(item.id)) {
      throw new Error(
        `admin: package provider id \`${item.id}\` must be 1 to 64 letters, digits, ".", "_", ":" or "-"`,
      );
    }
  }
  return providerRegistry.add(items);
};

export function providerOf(source: SavedSource): PackageProvider | undefined {
  return providerRegistry.get().find((provider) => provider.id === source.provider);
}

export const EMPTY_SETTINGS: SourceSettings = { config: {}, secrets: {} };

export interface SourceStore {
  readonly get: () => readonly SavedSource[] | undefined;
  readonly error: () => string | undefined;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: (client: AdminClient) => Promise<void>;
}

export function createSourceStore(): SourceStore {
  let sources: readonly SavedSource[] | undefined;
  let failure: string | undefined;
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    get: () => sources,
    error: () => failure,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: async (client) => {
      try {
        sources = await client.packageSources();
        failure = undefined;
      } catch (cause) {
        failure = cause instanceof Error ? cause.message : String(cause);
      }
      changed();
    },
  };
}

export const sourceStore = createSourceStore();

export async function installFrom(
  client: AdminClient,
  source: SavedSource,
  url: string,
  update?: string,
): Promise<PluginInstallOutcome> {
  const provider = providerOf(source);
  if (!provider) throw new Error(`no installed plugin provides “${source.provider}” sources`);
  const blob = await provider.download(source, url);
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "package.zip");
  const file = new File([blob], name, { type: "application/zip" });
  return client.uploadPlugin(file, { source: source.id, url, ...(update ? { update } : {}) });
}

export type Boundary = Pick<Kernel["ui"], "boundary">;

export const BoundaryContext = createContext<Boundary | undefined>(undefined);

export function useBoundary(): Boundary | undefined {
  return useContext(BoundaryContext);
}

export function describeOutcome(outcome: PluginInstallOutcome): string {
  return (
    `${outcome.id} ${outcome.version} installed — ${outcome.state}` +
    (outcome.replaced != null ? `, replacing ${outcome.replaced}` : "") +
    (outcome.warnings.length > 0 ? `. Warnings: ${outcome.warnings.join("; ")}` : "")
  );
}

import { createContext, useContext, type ComponentType } from "react";

import { createRegistry, s, type Kernel } from "@kernel";

import type { PluginInstallOutcome, RemoteLookupResult } from "./api.js";

export interface RemotePackageRequest {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly label?: string;
}

export interface PackageSourceProps {
  readonly busy: boolean;
  readonly maxPackageBytes: number | undefined;
  readonly installFile: (file: File) => Promise<PluginInstallOutcome | undefined>;
  readonly installFromUrl: (request: RemotePackageRequest) => Promise<PluginInstallOutcome | undefined>;
}

export interface InstalledPackage {
  readonly id: string;
  readonly version: string;
  readonly url: string;
  readonly authenticated: boolean;
}

export interface UpdateCheckContext {
  readonly plugins: readonly InstalledPackage[];
  readonly lookup: (url: string, headers?: Readonly<Record<string, string>>) => Promise<RemoteLookupResult>;
}

export interface PackageSource {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<PackageSourceProps>;
  readonly order?: number;
  readonly description?: string;
  readonly checkUpdates?: (context: UpdateCheckContext) => Promise<void>;
}

export const SOURCE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export const packageSourceRegistry = createRegistry<PackageSource>({
  key: (source) => source.id,
  order: (source) => source.order ?? 100,
  shape: s.object({
    id: s.string(),
    title: s.string(),
    component: s.component(),
    order: s.optional(s.number()),
    description: s.optional(s.string()),
    checkUpdates: s.optional(s.func()),
  }),
});

export const addPackageSource = (items: PackageSource | readonly PackageSource[]): (() => void) => {
  for (const item of Array.isArray(items) ? items : [items as PackageSource]) {
    if (!SOURCE_ID_PATTERN.test(item.id)) {
      throw new Error(
        `admin: package source id \`${item.id}\` must be 1 to 64 letters, digits, ".", "_", ":" or "-"`,
      );
    }
  }
  return packageSourceRegistry.add(items);
};

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

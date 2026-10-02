import type { Kernel, Registry } from "@kernel";

import type { SearchProvider } from "./api.js";

import type { ProviderResult } from "./merge.js";
import type { SearchEngine } from "./useSearch.js";

export function searchEngine(kernel: Kernel, providers: Registry<SearchProvider>): SearchEngine {
  return {
    run: (query, options, onProgress) => {
      const answered: (ProviderResult | undefined)[] = [];
      const report = (): void => onProgress?.(answered.filter((result) => result !== undefined));
      return Promise.all(
        providers.get().map(async (provider, seat): Promise<ProviderResult> => {
          const base = { providerId: provider.id, label: provider.label, order: seat };
          try {
            const hits = await provider.search(query, {
              ...(options.limit !== undefined ? { limit: options.limit } : {}),
            });
            answered[seat] = { ...base, hits };
          } catch (cause) {
            kernel.log.debug(`search provider "${provider.id}" failed`, cause);
            answered[seat] = { ...base, hits: [], error: cause instanceof Error ? cause.message : String(cause) };
          }
          report();
          return answered[seat];
        }),
      );
    },
  };
}

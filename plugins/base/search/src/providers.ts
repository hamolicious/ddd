/**
 * Other search providers (SPEC §6.5): sources a plugin adds with `addProvider` — a
 * semantic index, an external wiki.
 *
 * **The workspace itself is not a provider any more.** Its text search is part of the
 * query plan the kernel's engine answers (`results.ts`), on this device, offline too —
 * and the server runs the same engine over the same rows, so there is nothing a second
 * "on the server" provider could add. What runs here is only what other plugins
 * registered; with none, nothing does.
 *
 * - **Every provider runs, and each one's outcome is reported.** A provider that throws
 *   is recorded as an error, never thrown, and marks the answer `partial`.
 * - **Nothing waits for the slowest.** Each provider's answer is reported as it lands
 *   (`onProgress`). Unanswered providers are simply absent from a progress report.
 * - **Providers run in registry order** (`order`, lowest first), and that position is the
 *   merge's tie-breaker (`merge.ts`).
 */

import type { Kernel, Registry } from "@kernel";

import type { SearchProvider } from "./api.js";

import type { ProviderResult } from "./merge.js";
import type { SearchEngine } from "./useSearch.js";

/** The engine over the providers other plugins registered. */
export function searchEngine(kernel: Kernel, providers: Registry<SearchProvider>): SearchEngine {
  return {
    run: (query, options, onProgress) => {
      const answered: (ProviderResult | undefined)[] = [];
      const report = (): void => onProgress?.(answered.filter((result) => result !== undefined));
      return Promise.all(
        providers.get().map(async (provider, seat): Promise<ProviderResult> => {
          // The position is the tie-breaker `merge.ts` reads.
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

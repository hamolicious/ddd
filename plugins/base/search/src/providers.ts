/**
 * The search providers (SPEC §6.5): the host, and the two this plugin offers.
 *
 * **The default provider is the local index**, and that is a correctness statement,
 * not a performance one: the workspace must be searchable offline (SPEC §4.1), so what
 * the search bar talks to by default is `kernel.documents.search`, which runs MiniSearch
 * in a Worker against the replicated projection. The server's `?search=` endpoint is a
 * *second* provider — useful for very large workspaces, and honest about needing a
 * network.
 *
 * - **Every provider runs, and each one's outcome is reported.** A provider that throws
 *   (the server one, offline) is recorded as an error, never thrown — `merge.ts` explains
 *   why their scores are converted to ranks before merging.
 * - **Nothing waits for the slowest.** Each provider's answer is reported as it lands
 *   (`onProgress`), so the device's results are on screen while the server is still
 *   being asked. Unanswered providers are simply absent from a progress report.
 * - **The server is not asked when it cannot answer.** While sync reports it unreachable
 *   the server provider fails at once, and otherwise it gives up after
 *   {@link SERVER_TIMEOUT_MS}: a network that is up but cannot reach the server hangs a
 *   request for as long as the OS lets it.
 * - **Providers run in registry order.** `addProvider` puts a provider in the registry
 *   (`api.ts`), which lists them by `order`. The local index has the lowest (0), so it
 *   runs first, and the first wins ties in the merge — which is what makes the
 *   offline-correct answer the default answer.
 */

import type { Kernel, Registry, SearchHit } from "@kernel";

import type { SearchProvider } from "./api.js";

import type { ProviderResult } from "./merge.js";
import type { SearchEngine } from "./useSearch.js";

/** How long the server provider waits before reporting itself failed. */
export const SERVER_TIMEOUT_MS = 4000;

/** Sync states in which the server is known not to answer. */
const UNREACHABLE = new Set(["offline", "error", "auth-required"]);

const OFFLINE_MESSAGE = "You are offline, or the server cannot be reached.";

/** The engine over `providers`, after adding this plugin's own two to it. */
export function searchEngine(kernel: Kernel, providers: Registry<SearchProvider>): SearchEngine {
  providers.add({
    id: "local",
    label: "On this device",
    order: 0,
    search: (query, options) => kernel.documents.search(query, options),
  });

  providers.add({
    id: "server",
    label: "On the server",
    order: 10,
    search: async (query, options) => {
      if (UNREACHABLE.has(kernel.sync.state.status)) throw new Error(OFFLINE_MESSAGE);
      const params = new URLSearchParams({ search: query, limit: String(options.limit ?? 50) });
      // Metadata only: content comes from the local projection, which every client
      // already has (SPEC §4.1). Asking for text the client can read locally is the
      // definition of browsing over REST.
      params.set("metadata_only", "true");
      let response: Response;
      try {
        response = await kernel.session.fetch(`/documents?${params.toString()}`, {
          signal: AbortSignal.timeout(SERVER_TIMEOUT_MS),
        });
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "TimeoutError") throw new Error(OFFLINE_MESSAGE);
        throw cause;
      }
      const body = (await response.json()) as { documents?: readonly { id: string }[] };
      return (body.documents ?? []).map(
        (row, index): SearchHit => ({ id: row.id, score: 1 / (index + 1), terms: [] }),
      );
    },
  });

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

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
 * - **Providers run in seat order.** The `search` port is the host (`lm/search.provider`),
 *   and `kernel.ports.collect` already lists what is wired to it by seat, so nothing here
 *   sorts (PLUGIN-PROTOCOLS §6a). The local index is offered on the `local` port with the
 *   lowest default-seat hint, so it takes the first seat until someone rewires it, and
 *   the first seat wins ties in the merge — which is what makes the offline-correct
 *   answer the default answer.
 */

import type { Kernel, SearchHit } from "@kernel";
import type { SearchProvider } from "@protocols/lm/search.provider";

import type { ProviderResult } from "./merge.js";
import type { SearchEngine } from "./useSearch.js";

export function searchEngine(kernel: Kernel): SearchEngine {
  const providers = kernel.ports.collect<SearchProvider>("search");

  kernel.ports.offer<SearchProvider>("local", {
    id: "local",
    label: "On this device",
    order: 0,
    search: (query, options) => kernel.documents.search(query, options),
  });

  kernel.ports.offer<SearchProvider>("server", {
    id: "server",
    label: "On the server",
    order: 10,
    search: async (query, options) => {
      const params = new URLSearchParams({ search: query, limit: String(options.limit ?? 50) });
      // Metadata only: content comes from the local projection, which every client
      // already has (SPEC §4.1). Asking for text the client can read locally is the
      // definition of browsing over REST.
      params.set("metadata_only", "true");
      const response = await kernel.session.fetch(`/documents?${params.toString()}`);
      const body = (await response.json()) as { documents?: readonly { id: string }[] };
      return (body.documents ?? []).map(
        (row, index): SearchHit => ({ id: row.id, score: 1 / (index + 1), terms: [] }),
      );
    },
  });

  return {
    run: (query, options) =>
      Promise.all(
        providers.get().map(async (provider, seat): Promise<ProviderResult> => {
          // The seat is the tie-breaker `merge.ts` reads; the item's own `order` is only
          // the hint the wiring started from.
          const base = { providerId: provider.id, label: provider.label, order: seat };
          try {
            const hits = await provider.search(query, {
              ...(options.limit !== undefined ? { limit: options.limit } : {}),
            });
            return { ...base, hits };
          } catch (cause) {
            kernel.log.debug(`search provider "${provider.id}" failed`, cause);
            return { ...base, hits: [], error: cause instanceof Error ? cause.message : String(cause) };
          }
        }),
      ),
  };
}

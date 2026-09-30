/**
 * The search host runs providers in registry order — by each one's `order`, lowest first —
 * and reports each one's position as the merge tie-breaker.
 */

import { describe, expect, it } from "vitest";

import { createRegistry, type Kernel } from "@kernel";

import type { SearchProvider } from "./api.js";
import { searchEngine } from "./providers.js";

function fake(): { kernel: Kernel; providers: ReturnType<typeof createRegistry<SearchProvider>> } {
  const providers = createRegistry<SearchProvider>({
    key: (provider) => provider.id,
    order: (provider) => provider.order ?? 100,
  });
  const kernel = {
    documents: { search: async () => [{ id: "local-hit", score: 1, terms: [] }] },
    session: { fetch: async () => ({ json: async () => ({ documents: [{ id: "server-hit" }] }) }) },
    log: { debug: () => undefined },
  } as unknown as Kernel;
  return { kernel, providers };
}

const provider = (id: string, order: number | undefined, hits: readonly string[]): SearchProvider => ({
  id,
  label: id,
  ...(order === undefined ? {} : { order }),
  search: async () => hits.map((hit, index) => ({ id: hit, score: 1 / (index + 1), terms: [] })),
});

describe("searchEngine", () => {
  it("adds the local and the server provider, local first", () => {
    const { kernel, providers } = fake();
    searchEngine(kernel, providers);
    expect(providers.get().map((each) => each.id)).toEqual(["local", "server"]);
  });

  it("runs providers by `order`, and reports each one's position", async () => {
    const { kernel, providers } = fake();
    const engine = searchEngine(kernel, providers);
    // Replace the built-ins (same ids) so only these answer.
    providers.add([provider("none", undefined, []), provider("semantic", 5, ["s"]), provider("local", 0, ["l"]), provider("server", 10, [])]);

    const results = await engine.run("milk", {});

    expect(results.map((result) => result.providerId)).toEqual(["local", "semantic", "server", "none"]);
    // The position, 0 first, is what `merge.ts` breaks ties on.
    expect(results.map((result) => result.order)).toEqual([0, 1, 2, 3]);
  });

  it("reports a throwing provider as that provider's error, in its place", async () => {
    const { kernel, providers } = fake();
    const engine = searchEngine(kernel, providers);
    providers.add([
      provider("local", 0, ["l"]),
      { id: "server", label: "server", order: 10, search: async () => Promise.reject(new Error("offline")) },
    ]);

    const results = await engine.run("milk", { limit: 5 });

    expect(results[0]).toMatchObject({ providerId: "local", order: 0, hits: [{ id: "l" }] });
    expect(results[1]).toMatchObject({ providerId: "server", order: 1, hits: [], error: "offline" });
  });
});

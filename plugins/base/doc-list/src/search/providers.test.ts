/**
 * The search host runs providers in **seat order** and reports each one's seat as the
 * merge tie-breaker (PLUGIN-PROTOCOLS §6a: hosts stop sorting). The fake `kernel.ports`
 * here hands the host a list in an order that contradicts the items' own `order` hints,
 * so a host that went back to sorting by `order` would fail these.
 */

import { describe, expect, it } from "vitest";

import type { Kernel, SlotHost } from "@kernel";
import type { SearchProvider } from "@protocols/lm/search.provider";

import { searchEngine } from "./providers.js";

interface Fake {
  readonly kernel: Kernel;
  /** What `offer("local")` and `offer("server")` stored, by port. */
  readonly offered: Map<string, SearchProvider>;
  /** Replace what `collect("search")` lists. */
  seat(providers: readonly SearchProvider[]): void;
}

function fake(): Fake {
  const offered = new Map<string, SearchProvider>();
  let seated: readonly SearchProvider[] = [];
  const host: SlotHost<SearchProvider> = {
    get: () => seated,
    entries: () => seated.map((value) => ({ pluginId: "doc-list", port: "?", value })),
    subscribe: () => () => undefined,
  };
  const kernel = {
    ports: {
      collect: (port: string) => {
        expect(port).toBe("search");
        return host;
      },
      offer: (port: string, item: SearchProvider) => {
        offered.set(port, item);
        return { dispose: () => undefined };
      },
    },
    documents: { search: async () => [{ id: "local-hit", score: 1, terms: [] }] },
    session: { fetch: async () => ({ json: async () => ({ documents: [{ id: "server-hit" }] }) }) },
    log: { debug: () => undefined },
  } as unknown as Kernel;
  return {
    kernel,
    offered,
    seat: (providers) => {
      seated = providers;
    },
  };
}

const provider = (id: string, order: number | undefined, hits: readonly string[]): SearchProvider => ({
  id,
  label: id,
  ...(order === undefined ? {} : { order }),
  search: async () => hits.map((hit, index) => ({ id: hit, score: 1 / (index + 1), terms: [] })),
});

describe("searchEngine", () => {
  it("offers the local and the server provider on their own ports", () => {
    const { kernel, offered } = fake();
    searchEngine(kernel);
    expect(offered.get("local")?.id).toBe("local");
    expect(offered.get("server")?.id).toBe("server");
  });

  it("runs providers in the host's seat order, not by their `order` hint", async () => {
    const { kernel, seat } = fake();
    const engine = searchEngine(kernel);
    // Seated the other way round from what the hints would say.
    seat([provider("semantic", 50, ["s"]), provider("local", 0, ["l"]), provider("none", undefined, [])]);

    const results = await engine.run("milk", {});

    expect(results.map((result) => result.providerId)).toEqual(["semantic", "local", "none"]);
    // The seat, 0 first, is what `merge.ts` breaks ties on.
    expect(results.map((result) => result.order)).toEqual([0, 1, 2]);
  });

  it("reports a throwing provider as that provider's error, in its seat", async () => {
    const { kernel, seat } = fake();
    const engine = searchEngine(kernel);
    seat([
      provider("local", 0, ["l"]),
      { id: "server", label: "server", order: 10, search: async () => Promise.reject(new Error("offline")) },
    ]);

    const results = await engine.run("milk", { limit: 5 });

    expect(results[0]).toMatchObject({ providerId: "local", order: 0, hits: [{ id: "l" }] });
    expect(results[1]).toMatchObject({ providerId: "server", order: 1, hits: [], error: "offline" });
  });
});

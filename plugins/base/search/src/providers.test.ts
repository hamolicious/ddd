/**
 * The search host runs providers in registry order — by each one's `order`, lowest first —
 * and reports each one's position as the merge tie-breaker.
 */

import { describe, expect, it } from "vitest";

import { createRegistry, type Kernel } from "@kernel";

import type { SearchProvider } from "./api.js";
import { searchEngine } from "./providers.js";

function fake(
  status = "synced",
  fetch: (path: string, init?: RequestInit) => Promise<unknown> = async () => ({
    json: async () => ({ documents: [{ id: "server-hit" }] }),
  }),
): { kernel: Kernel; providers: ReturnType<typeof createRegistry<SearchProvider>> } {
  const providers = createRegistry<SearchProvider>({
    key: (provider) => provider.id,
    order: (provider) => provider.order ?? 100,
  });
  const kernel = {
    documents: { search: async () => [{ id: "local-hit", score: 1, terms: [] }] },
    session: { fetch },
    sync: { state: { status } },
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

  it("reports the device's answer before a slow server has answered", async () => {
    let answer: (value: unknown) => void = () => undefined;
    const server = new Promise((resolve) => (answer = resolve));
    const { kernel, providers } = fake("synced", () => server);
    const engine = searchEngine(kernel, providers);
    const progress: string[][] = [];

    const done = engine.run("milk", {}, (results) => progress.push(results.map((result) => result.providerId)));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(progress).toEqual([["local"]]);
    answer({ json: async () => ({ documents: [{ id: "server-hit" }] }) });
    const results = await done;
    expect(progress).toEqual([["local"], ["local", "server"]]);
    expect(results[1]).toMatchObject({ providerId: "server", hits: [{ id: "server-hit" }] });
  });

  it("does not ask the server while sync says it is unreachable", async () => {
    const asked: string[] = [];
    const { kernel, providers } = fake("offline", async (path) => {
      asked.push(path);
      return { json: async () => ({ documents: [] }) };
    });
    const engine = searchEngine(kernel, providers);

    const results = await engine.run("milk", {});

    expect(asked).toEqual([]);
    expect(results[0]).toMatchObject({ providerId: "local", hits: [{ id: "local-hit" }] });
    expect(results[1]).toMatchObject({ providerId: "server", hits: [], error: expect.stringContaining("offline") });
  });

  it("gives the server request a timeout, and reports it as offline", async () => {
    let signal: AbortSignal | undefined;
    const { kernel, providers } = fake("synced", async (_path, init) => {
      signal = init?.signal ?? undefined;
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const engine = searchEngine(kernel, providers);

    const results = await engine.run("milk", {});

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(results[1]).toMatchObject({ providerId: "server", error: expect.stringContaining("offline") });
  });
});

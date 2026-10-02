import { describe, expect, it } from "vitest";

import { createRegistry, type Kernel } from "@kernel";

import type { SearchProvider } from "./api.js";
import { searchEngine } from "./providers.js";

function fake(): { kernel: Kernel; providers: ReturnType<typeof createRegistry<SearchProvider>> } {
  const providers = createRegistry<SearchProvider>({
    key: (provider) => provider.id,
    order: (provider) => provider.order ?? 100,
  });
  const kernel = { log: { debug: () => undefined } } as unknown as Kernel;
  return { kernel, providers };
}

const provider = (id: string, order: number | undefined, hits: readonly string[]): SearchProvider => ({
  id,
  label: id,
  ...(order === undefined ? {} : { order }),
  search: async () => hits.map((hit, index) => ({ id: hit, score: 1 / (index + 1), terms: [] })),
});

describe("searchEngine", () => {
  it("adds no provider of its own", async () => {
    const { kernel, providers } = fake();
    const engine = searchEngine(kernel, providers);
    expect(providers.get()).toEqual([]);
    expect(await engine.run("milk", {})).toEqual([]);
  });

  it("runs providers by `order`, and reports each one's position", async () => {
    const { kernel, providers } = fake();
    const engine = searchEngine(kernel, providers);
    providers.add([provider("none", undefined, []), provider("semantic", 5, ["s"]), provider("wiki", 0, ["w"])]);

    const results = await engine.run("milk", {});

    expect(results.map((result) => result.providerId)).toEqual(["wiki", "semantic", "none"]);
    expect(results.map((result) => result.order)).toEqual([0, 1, 2]);
  });

  it("reports a throwing provider as that provider's error, in its place", async () => {
    const { kernel, providers } = fake();
    const engine = searchEngine(kernel, providers);
    providers.add([
      provider("wiki", 0, ["w"]),
      { id: "remote", label: "remote", order: 10, search: async () => Promise.reject(new Error("offline")) },
    ]);

    const results = await engine.run("milk", { limit: 5 });

    expect(results[0]).toMatchObject({ providerId: "wiki", order: 0, hits: [{ id: "w" }] });
    expect(results[1]).toMatchObject({ providerId: "remote", order: 1, hits: [], error: "offline" });
  });

  it("reports a fast provider's answer before a slow one's", async () => {
    const { kernel, providers } = fake();
    const engine = searchEngine(kernel, providers);
    let answer: (value: unknown) => void = () => undefined;
    const slow = new Promise((resolve) => (answer = resolve));
    providers.add([
      provider("fast", 0, ["f"]),
      { id: "slow", label: "slow", order: 10, search: async () => (await slow, [{ id: "s", score: 1, terms: [] }]) },
    ]);
    const progress: string[][] = [];

    const done = engine.run("milk", {}, (results) => progress.push(results.map((result) => result.providerId)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(progress).toEqual([["fast"]]);
    answer(undefined);
    await done;
    expect(progress).toEqual([["fast"], ["fast", "slow"]]);
  });
});

import { beforeAll, describe, expect, it } from "vitest";

import type { FeedRow } from "../protocol.js";
import { MemoryProjectionStore, feedRow } from "../store/testing.js";
import type { CoreBindings } from "../wasm/index.js";
import { coreArtifactExists, loadCoreForNode } from "../wasm/node-core.js";
import { ProjectionHost } from "./backend.js";
import { ProjectionFeed } from "./feed.js";
import type { PeerMessage, SearchPeers } from "./peers.js";

class Hub {
  owner: string | undefined;
  readonly waiting: Array<{ id: string; grant: () => void }> = [];
  readonly tabs = new Map<string, Set<(message: PeerMessage) => void>>();

  peers(id: string): SearchPeers {
    const listeners = new Set<(message: PeerMessage) => void>();
    this.tabs.set(id, listeners);
    let claimed: Promise<void> | undefined;
    return {
      id,
      post: (message) => {
        for (const [other, set] of this.tabs) {
          if (other === id) continue;
          for (const listener of [...set]) setTimeout(() => listener(structuredClone(message)), 0);
        }
      },
      onMessage: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      claim: () => {
        if (this.owner !== undefined) return Promise.resolve(false);
        this.owner = id;
        return Promise.resolve(true);
      },
      whenClaimed: () => {
        claimed ??= new Promise<void>((resolve) => {
          this.waiting.push({
            id,
            grant: () => {
              this.owner = id;
              resolve();
            },
          });
        });
        return claimed;
      },
      close: () => {
        this.tabs.delete(id);
        const index = this.waiting.findIndex((waiter) => waiter.id === id);
        if (index >= 0) this.waiting.splice(index, 1);
        if (this.owner === id) {
          this.owner = undefined;
          this.waiting.shift()?.grant();
        }
      },
    };
  }
}

const checkpoint = (rows: readonly FeedRow[]) => ({
  safeSeq: Math.max(0, ...rows.map((row) => row.seq)),
  updatedAt: 0,
  coreSemanticsVersion: 1,
  bootstrapped: true,
});

const tick = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!coreArtifactExists())("one search owner across tabs", () => {
  let core: CoreBindings;

  beforeAll(async () => {
    core = await loadCoreForNode();
  });

  const stores = new WeakMap<Hub, MemoryProjectionStore>();

  async function tab(hub: Hub, id: string, rows: readonly FeedRow[]) {
    let store = stores.get(hub);
    if (!store) {
      store = new MemoryProjectionStore();
      await store.applyRows(rows, checkpoint(rows));
      stores.set(hub, store);
    }
    const backend = new ProjectionHost({ core, persistent: false });
    let opened = 0;
    const open = backend.open.bind(backend);
    backend.open = () => {
      opened++;
      return open();
    };
    const feed = new ProjectionFeed(store, backend, hub.peers(id));
    void feed.start();
    return { store, feed, opened: () => opened };
  }

  const rows = [feedRow({ id: "A", seq: 1, content: "# Alpha\n\n- [ ] one\n" })];
  const plan = { source: "tasks", stages: [{ select: [{ field: "text" }] }, { sort: ["text"] }] };

  it("the first tab owns the database and the second asks it", async () => {
    const hub = new Hub();
    const first = await tab(hub, "first", rows);
    await first.feed.ready;
    const second = await tab(hub, "second", rows);
    await second.feed.ready;
    expect(first.feed.role).toBe("owner");
    expect(second.feed.role).toBe("follower");
    expect(second.opened()).toBe(0);
    expect((await second.feed.run(plan)).rows).toEqual([{ text: "one" }]);
  });

  it("a follower's edits, seen through the shared store, reach the owner and every tab hears about them", async () => {
    const hub = new Hub();
    const first = await tab(hub, "first", rows);
    await first.feed.ready;
    const second = await tab(hub, "second", rows);
    await second.feed.ready;
    const heard: string[][] = [];
    first.feed.onChange((sources) => heard.push(["first", ...sources]));
    second.feed.onChange((sources) => heard.push(["second", ...sources]));
    const row = (await second.store.get("A"))!;
    await second.store.putLocal([{ ...row, content: "# Alpha\n\n- [ ] typed in the second tab\n", updated_at: "2026-10-03T00:00:00Z" }]);
    await tick();
    await second.feed.settled();
    await tick();
    expect((await first.feed.run(plan)).rows).toEqual([{ text: "typed in the second tab" }]);
    expect(heard.some(([where, ...sources]) => where === "first" && sources.includes("tasks"))).toBe(true);
    expect(heard.some(([where, ...sources]) => where === "second" && sources.includes("tasks"))).toBe(true);
  });

  it("when the owner closes, the next tab takes over and keeps answering", async () => {
    const hub = new Hub();
    const first = await tab(hub, "first", rows);
    await first.feed.ready;
    const second = await tab(hub, "second", rows);
    await second.feed.ready;
    first.feed.close();
    await tick(50);
    expect(second.feed.role).toBe("owner");
    expect(second.opened()).toBe(1);
    expect((await second.feed.run(plan)).rows).toEqual([{ text: "one" }]);
  });

  it("an owner wiped from another tab sleeps until the store changes again, then rebuilds", async () => {
    const hub = new Hub();
    const first = await tab(hub, "first", rows);
    await first.feed.ready;
    const second = await tab(hub, "second", rows);
    await second.feed.ready;
    await second.feed.wipe();
    await expect(first.feed.run(plan)).rejects.toThrow(/sign in/);
    const row = (await first.store.get("A"))!;
    await first.store.putLocal([{ ...row, content: "# Alpha\n\n- [ ] after signing in\n", updated_at: "2026-10-04T00:00:00Z" }]);
    await tick(50);
    expect((await first.feed.run(plan)).rows).toEqual([{ text: "after signing in" }]);
  });

  it("a call made while nobody owns the database is answered after the takeover", async () => {
    const hub = new Hub();
    const first = await tab(hub, "first", rows);
    await first.feed.ready;
    const second = await tab(hub, "second", rows);
    const third = await tab(hub, "third", rows);
    await Promise.all([second.feed.ready, third.feed.ready]);
    first.feed.close();
    const answer = third.feed.run(plan);
    await tick(80);
    expect((await answer).rows).toEqual([{ text: "one" }]);
    expect([second.feed.role, third.feed.role].sort()).toEqual(["follower", "owner"]);
  });
});

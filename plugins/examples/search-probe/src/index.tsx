import type { Kernel, SearchPlanJson, SearchWatch } from "@kernel";

interface Probe {
  run(plan: SearchPlanJson): Promise<unknown>;
  watch(plan: SearchPlanJson): Promise<number>;
  latest(handle: number): unknown;
  updates(handle: number): number;
  window(handle: number, start: number, count: number): Promise<unknown>;
  close(handle: number): void;
}

export default function activate(kernel: Kernel): void {
  const watches = new Map<number, { watch: SearchWatch<unknown>; latest: unknown; updates: number }>();
  let next = 1;
  const probe: Probe = {
    run: (plan) => kernel.search.fromPlan(plan).run(),
    watch: async (plan) => {
      const watch = (await kernel.search.fromPlan(plan).watch()) as unknown as SearchWatch<unknown>;
      const handle = next++;
      const entry = { watch, latest: watch.result as unknown, updates: 0 };
      watch.onChange((result) => {
        entry.latest = result;
        entry.updates += 1;
      });
      watches.set(handle, entry);
      return handle;
    },
    latest: (handle) => watches.get(handle)?.latest,
    updates: (handle) => watches.get(handle)?.updates ?? 0,
    window: async (handle, start, count) => {
      const entry = watches.get(handle);
      if (!entry) return undefined;
      await entry.watch.window(start, count);
      entry.latest = entry.watch.result;
      return entry.latest;
    },
    close: (handle) => {
      watches.get(handle)?.watch.close();
      watches.delete(handle);
    },
  };
  Object.assign(globalThis, { dddSearchProbe: probe });
  kernel.log.info("search-probe: ready");
}

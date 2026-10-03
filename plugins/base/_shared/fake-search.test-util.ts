import { createSearchApi, type SearchApi, type SearchPlanJson } from "@kernel";

type Row = object;

export interface FakeWatch {
  readonly plan: SearchPlanJson;
  readonly listeners: Set<(result: { rows: readonly Row[]; total: number }) => void>;
  closed: boolean;
  window?: { readonly start: number; readonly count: number };
}

export interface FakeSearch {
  readonly search: SearchApi;
  readonly runs: SearchPlanJson[];
  readonly watches: FakeWatch[];
  emit(): void;
}

export function fakeSearch(answer: (plan: SearchPlanJson) => readonly Row[]): FakeSearch {
  const runs: SearchPlanJson[] = [];
  const watches: FakeWatch[] = [];
  const result = (plan: SearchPlanJson, window?: FakeWatch["window"]) => {
    const all = answer(plan);
    const rows = window ? all.slice(window.start, window.start + window.count) : all;
    return { rows, total: all.length, start: window?.start ?? 0 };
  };
  const search = createSearchApi({
    run: (plan) => {
      runs.push(plan);
      const { rows, total } = result(plan);
      return Promise.resolve({ rows, total } as never);
    },
    watch: (plan) => {
      const entry: FakeWatch = { plan, listeners: new Set(), closed: false };
      watches.push(entry);
      return Promise.resolve({
        get result() {
          return result(entry.plan, entry.window) as never;
        },
        onChange: (listener: never) => {
          entry.listeners.add(listener);
          return () => entry.listeners.delete(listener);
        },
        window: (start: number, count: number) => {
          entry.window = { start, count };
          return Promise.resolve();
        },
        close: () => {
          entry.closed = true;
        },
      } as never);
    },
  });
  return {
    search,
    runs,
    watches,
    emit: () => {
      for (const entry of watches) {
        if (entry.closed) continue;
        const { rows, total } = result(entry.plan, entry.window);
        for (const listener of entry.listeners) listener({ rows, total });
      }
    },
  };
}

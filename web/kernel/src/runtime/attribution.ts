/**
 * The loader's half of registry attribution (`createRegistry` in `@kernel`).
 *
 * Kernel-internal on purpose: a plugin must not be able to claim another plugin's
 * identity, so the setter is not on the `@kernel` surface. The state lives on
 * `globalThis` under `Symbol.for` keys that `kernel-api/src/registry.ts` reads, which
 * makes it one value per page however many copies of `@kernel` the page has loaded.
 */

const ACTIVATING = Symbol.for("ddd.kernel.activating-plugin");
const REGISTRIES = Symbol.for("ddd.kernel.registries");

type Global = { [ACTIVATING]?: string; [REGISTRIES]?: Set<(pluginId: string) => void> };
const page = globalThis as unknown as Global;

/**
 * Run `work` — importing a plugin's module, or its `activate` — with `pluginId` as the
 * plugin every registry `add` is attributed to. Restores the previous marker afterwards,
 * whether `work` resolves or throws.
 */
export async function asPlugin<T>(pluginId: string, work: () => T | Promise<T>): Promise<T> {
  const previous = page[ACTIVATING];
  page[ACTIVATING] = pluginId;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete page[ACTIVATING];
    else page[ACTIVATING] = previous;
  }
}

/** The same, synchronously: for the kernel's own contributions (`pluginId` `"kernel"`). */
export function asPluginSync<T>(pluginId: string, work: () => T): T {
  const previous = page[ACTIVATING];
  page[ACTIVATING] = pluginId;
  try {
    return work();
  } finally {
    if (previous === undefined) delete page[ACTIVATING];
    else page[ACTIVATING] = previous;
  }
}

/** The plugin currently being imported or activated, if any. */
export function activatingPlugin(): string | undefined {
  return page[ACTIVATING];
}

/** Withdraw every item `pluginId` added to any registry on the page (a failed activation). */
export function withdrawFromRegistries(pluginId: string): void {
  for (const withdraw of page[REGISTRIES] ?? []) {
    try {
      withdraw(pluginId);
    } catch (error) {
      console.warn(`[kernel] withdrawing "${pluginId}" from a registry threw`, error);
    }
  }
}

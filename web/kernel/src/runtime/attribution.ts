const ACTIVATING = Symbol.for("ddd.kernel.activating-plugin");
const REGISTRIES = Symbol.for("ddd.kernel.registries");

type Global = { [ACTIVATING]?: string; [REGISTRIES]?: Set<(pluginId: string) => void> };
const page = globalThis as unknown as Global;

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

export function activatingPlugin(): string | undefined {
  return page[ACTIVATING];
}

export function withdrawFromRegistries(pluginId: string): void {
  for (const withdraw of page[REGISTRIES] ?? []) {
    try {
      withdraw(pluginId);
    } catch (error) {
      console.warn(`[kernel] withdrawing "${pluginId}" from a registry threw`, error);
    }
  }
}

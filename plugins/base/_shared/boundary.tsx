import { useCallback, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

import type { Kernel, Registry, RegistryEntry } from "@kernel";

export function useRegistry<T>(registry: Registry<T>): readonly RegistryEntry<T>[] {
  const subscribe = useCallback((onChange: () => void) => registry.subscribe(() => onChange()), [registry]);
  return useSyncExternalStore(subscribe, registry.entries, registry.entries);
}

const wrappers = new WeakMap<object, Map<string, ComponentType<never>>>();

function IconSlot({ node }: { readonly node: ReactNode }): ReactNode {
  return node;
}

export function BoundedIcon({
  kernel,
  node,
  point,
  pluginId,
  className,
}: {
  readonly kernel: Kernel;
  readonly node: ReactNode;
  readonly point: string;
  readonly pluginId: string;
  readonly className?: string;
}): ReactNode {
  if (node === undefined || node === null || node === false) return null;
  const Slot = bounded(kernel, IconSlot, `${point}#icon`, pluginId);
  return (
    <span className={className} aria-hidden="true">
      <Slot node={node} />
    </span>
  );
}

export function bounded<P extends object>(
  kernel: Kernel,
  component: ComponentType<P>,
  point: string,
  pluginId: string,
): ComponentType<P> {
  const key = `${point}|${pluginId}`;
  let byKey = wrappers.get(component as unknown as object);
  if (!byKey) {
    byKey = new Map();
    wrappers.set(component as unknown as object, byKey);
  }
  const cached = byKey.get(key);
  if (cached) return cached as unknown as ComponentType<P>;
  const wrapped = kernel.ui.boundary(component, { point, pluginId });
  byKey.set(key, wrapped as unknown as ComponentType<never>);
  return wrapped;
}

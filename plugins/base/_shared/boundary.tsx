/**
 * React bindings for rendering other plugins' contributed items safely.
 *
 * A host keeps a `createRegistry` (from `@kernel`) at module scope and exports its `add`;
 * its React tree reads the registry with `useRegistry`, and renders each contributed
 * component through `bounded`:
 *
 * ```tsx
 * const entries = useRegistry(items);
 * return entries.map(({ value, pluginId }) => {
 *   const Item = bounded(kernel, value.component, "header.item", pluginId);
 *   return <Item key={value.id} />;
 * });
 * ```
 *
 * `useRegistry` reads *entries* rather than values because the renderer has to know
 * **which plugin** contributed a component before it renders it: that id is what
 * `kernel.ui.boundary` puts in the in-place failure chip, and "plugin X failed" is
 * the only actionable fact a user gets (SPEC §6.4).
 *
 * `bounded` memoizes the wrapper per (component, point, plugin). A fresh wrapper each
 * render is a different component type to React, which unmounts and remounts the
 * item — losing its scroll position, its focus and its state on every keystroke
 * somewhere else in the app.
 *
 * `BoundedIcon` covers the item field that is a `ReactNode` rather than a component,
 * which no `boundary` call could otherwise reach.
 */

import { useCallback, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

import type { Kernel, Registry, RegistryEntry } from "@kernel";

/**
 * A registry's live items, with attribution, in the registry's order. The registry
 * should be created once, at module scope; `entries()` returns the same array until the
 * next change, which is what lets React skip renders between changes.
 */
export function useRegistry<T>(registry: Registry<T>): readonly RegistryEntry<T>[] {
  const subscribe = useCallback((onChange: () => void) => registry.subscribe(() => onChange()), [registry]);
  return useSyncExternalStore(subscribe, registry.entries, registry.entries);
}

const wrappers = new WeakMap<object, Map<string, ComponentType<never>>>();

/**
 * A contributed `icon` is a `ReactNode`, not a component, so `bounded` cannot wrap it —
 * and an unwrapped node renders *outside* every boundary. One throwing icon then takes the
 * whole React root down with it (SPEC §6.4 says the opposite: every contributed item is
 * contained). This is the component that carries one, so `bounded` applies to icons too.
 */
function IconSlot({ node }: { readonly node: ReactNode }): ReactNode {
  return node;
}

/** Render a contributed icon inside its plugin's error boundary. */
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

/**
 * A contributed component wrapped in the kernel's error boundary, memoized. `point` names
 * where it renders (`"header.item"`), `pluginId` is the entry's `pluginId` from
 * `useRegistry`: both appear in the failure chip and the aggregated problems notice.
 */
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

/**
 * React bindings for rendering other plugins' offered items safely.
 *
 * `useSlotEntries` reads *entries* rather than values because the renderer has to
 * know **which plugin** offered a component before it renders it: that id is what
 * `kernel.ui.boundary` puts in the in-place failure chip, and "plugin X failed" is
 * the only actionable fact a user gets (SPEC §6.4).
 *
 * `bounded` memoizes the wrapper per (component, slot, plugin). A fresh wrapper each
 * render is a different component type to React, which unmounts and remounts the
 * item — losing its scroll position, its focus and its state on every keystroke
 * somewhere else in the app.
 *
 * `BoundedIcon` covers the item field that is a `ReactNode` rather than a component,
 * which no `boundary` call could otherwise reach.
 */

import { useEffect, useState, type ComponentType, type ReactNode } from "react";

import type { Kernel, SlotHost, SlotItem } from "@kernel";

/**
 * A slot host's live items (`kernel.ports.collect`), with attribution and in seat order.
 * `host` should be created once (in `activate`) and passed down: a fresh handle per
 * render would re-subscribe every time. `subscribe` fires immediately, so there is no
 * gap between the first render and the first update.
 */
export function useSlotEntries<T>(host: SlotHost<T>): readonly SlotItem<T>[] {
  const [entries, setEntries] = useState<readonly SlotItem<T>[]>(() => host.entries());
  useEffect(() => host.subscribe(() => setEntries(host.entries())), [host]);
  return entries;
}

const wrappers = new WeakMap<object, Map<string, ComponentType<never>>>();

/**
 * An offered `icon` is a `ReactNode`, not a component, so `bounded` cannot wrap it — and
 * an unwrapped node renders *outside* every boundary. One throwing icon then takes the
 * whole React root down with it (SPEC §6.4 says the opposite: every offered item is
 * contained). This is the component that carries one, so `bounded` applies to icons too.
 */
function IconSlot({ node }: { readonly node: ReactNode }): ReactNode {
  return node;
}

/** Render an offered icon inside its plugin's error boundary. */
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

/** An offered component wrapped in the kernel's error boundary, memoized. */
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

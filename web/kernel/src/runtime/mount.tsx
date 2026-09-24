/**
 * The single mount point (SPEC §6.4).
 *
 * The kernel owns the React root; a plugin hands it an element. **One holder at a
 * time** — normally `shell-ui` — because two plugins rendering "the app" into the
 * same node is not a layout, it is a race. A replacement shell is installed by
 * replacing the plugin, not by fighting over the node.
 *
 * The app renders {@link KernelOutlet} inside its own frame (notice strip, boot
 * errors), so the kernel's chrome survives a shell that never mounts anything.
 */

import { useEffect, useState, type ReactNode } from "react";

import { ContractViolationError, type Unsubscribe } from "@kernel";

export class MountPoint {
  #element: ReactNode = null;
  #holder: string | undefined;
  readonly #listeners = new Set<(element: ReactNode) => void>();

  constructor(readonly node: HTMLElement) {}

  /** Who holds the mount, or `undefined` while nothing is mounted. */
  get holder(): string | undefined {
    return this.#holder;
  }

  current(): ReactNode {
    return this.#element;
  }

  subscribe(listener: (element: ReactNode) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  mount(pluginId: string, element: ReactNode): Unsubscribe {
    if (this.#holder !== undefined && this.#holder !== pluginId) {
      throw new ContractViolationError(
        `the UI mount is held by "${this.#holder}"; "${pluginId}" cannot mount over it`,
        { holder: this.#holder, pluginId },
      );
    }
    this.#holder = pluginId;
    this.#element = element;
    this.#emit();
    return () => {
      if (this.#holder !== pluginId) return;
      this.#holder = undefined;
      this.#element = null;
      this.#emit();
    };
  }

  /** Force the mount back to empty — a failed or unloaded holder (see `KernelHost.retract`). */
  release(pluginId: string): void {
    if (this.#holder !== pluginId) return;
    this.#holder = undefined;
    this.#element = null;
    this.#emit();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener(this.#element);
  }
}

/** Renders whatever holds the mount, and re-renders when that changes. */
export function KernelOutlet({ mount }: { readonly mount: MountPoint }): ReactNode {
  const [element, setElement] = useState<ReactNode>(() => mount.current());
  useEffect(() => mount.subscribe(setElement), [mount]);
  return element;
}

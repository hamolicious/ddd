import { useEffect, useState, type ReactNode } from "react";

import { ContractViolationError, type Unsubscribe } from "@kernel";

export class MountPoint {
  #element: ReactNode = null;
  #holder: string | undefined;
  readonly #listeners = new Set<(element: ReactNode) => void>();

  constructor(readonly node: HTMLElement) {}

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

export function KernelOutlet({ mount }: { readonly mount: MountPoint }): ReactNode {
  const [element, setElement] = useState<ReactNode>(() => mount.current());
  useEffect(() => mount.subscribe(setElement), [mount]);
  return element;
}

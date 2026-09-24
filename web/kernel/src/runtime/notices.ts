/**
 * The notice centre: the kernel's one channel for "the user has to be told once".
 *
 * It exists as a kernel service rather than a `shell-ui` feature because the two
 * notices the SPEC *requires* both have to work when the shell is broken or absent:
 * the aggregated failed-plugin notice (SPEC §6.4) and the single "update available
 * — reload" flow (SPEC §8). The app renders a minimal strip itself; `shell-ui` may
 * render the same list more prettily.
 */

import type { Notice, Unsubscribe } from "@kernel";

export class NoticeCenter {
  readonly #notices = new Map<string, Notice>();
  readonly #listeners = new Set<(notices: readonly Notice[]) => void>();

  notify(notice: Notice): Unsubscribe {
    this.#notices.set(notice.id, notice);
    this.#emit();
    return () => this.dismiss(notice.id);
  }

  dismiss(id: string): void {
    if (this.#notices.delete(id)) this.#emit();
  }

  list(): readonly Notice[] {
    return [...this.#notices.values()];
  }

  subscribe(listener: (notices: readonly Notice[]) => void): Unsubscribe {
    this.#listeners.add(listener);
    listener(this.list());
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    const snapshot = this.list();
    for (const listener of [...this.#listeners]) listener(snapshot);
  }
}

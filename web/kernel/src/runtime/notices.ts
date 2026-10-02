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

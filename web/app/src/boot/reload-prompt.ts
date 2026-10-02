import type { Notice } from "@kernel";

export const RELOAD_NOTICE_ID = "kernel:update-available";

export type ReloadReason = "update" | "stale";

export class ReloadPrompt {
  #applyUpdate: (() => void) | undefined;
  readonly #reasons = new Set<ReloadReason>();
  #notify: ((notice: Notice) => void) | undefined;

  constructor(private readonly reloadPage: () => void = () => location.reload()) {}

  attach(notify: (notice: Notice) => void): void {
    this.#notify = notify;
    this.#render();
  }

  offerUpdate(apply: () => void): void {
    this.#applyUpdate = apply;
    this.#ask("update");
  }

  askForStale(): void {
    this.#ask("stale");
  }

  get reasons(): ReadonlySet<ReloadReason> {
    return this.#reasons;
  }

  reload(): void {
    if (this.#applyUpdate) this.#applyUpdate();
    else this.reloadPage();
  }

  #ask(reason: ReloadReason): void {
    this.#reasons.add(reason);
    this.#render();
  }

  #render(): void {
    if (!this.#notify || this.#reasons.size === 0) return;
    this.#notify({
      id: RELOAD_NOTICE_ID,
      level: "info",
      message: this.#reasons.has("update") ? "An update is available." : "Plugins need updating. Reload while online.",
      actions: [{ label: "Reload", run: () => this.reload() }],
    });
  }
}

/**
 * The one reload prompt (SPEC §8).
 *
 * Two things can ask a user to reload: a new app bundle waiting in the service worker, and
 * a plugin list with no load resolution to activate from (one cached by an older app, or
 * served by an older server). They share one notice, so a user is never asked twice, and
 * one Reload covers both: when a new worker is waiting it takes control first, so the
 * reload lands on the newest bundle.
 *
 * A change to the plugin set does **not** come here: every client reloads at once on
 * `plugins.changed` (`@kernel` 3.0, the sync client).
 *
 * It never reloads on its own. The page keeps running its current version until the user
 * chooses, which is safe because text edits already live in the local Yjs document and the
 * outbox.
 */

import type { Notice } from "@kernel";

/** The id the service-worker update has always used, kept so there is one notice. */
export const RELOAD_NOTICE_ID = "kernel:update-available";

export type ReloadReason = "update" | "stale";

export class ReloadPrompt {
  #applyUpdate: (() => void) | undefined;
  readonly #reasons = new Set<ReloadReason>();
  #notify: ((notice: Notice) => void) | undefined;

  constructor(private readonly reloadPage: () => void = () => location.reload()) {}

  /** Where notices go, once the kernel exists. Anything asked before then shows now. */
  attach(notify: (notice: Notice) => void): void {
    this.#notify = notify;
    this.#render();
  }

  /** A new service worker is waiting; `apply` activates it and reloads. */
  offerUpdate(apply: () => void): void {
    this.#applyUpdate = apply;
    this.#ask("update");
  }

  /**
   * The plugin list carries no load resolution, so no plugin can start (the order is the
   * server's alone). A reload while online fetches one.
   */
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

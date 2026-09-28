/**
 * The one reload prompt (SPEC §8, PLUGIN-PROTOCOLS §6c).
 *
 * Two things can ask a user to reload: a new app bundle waiting in the service worker, and
 * a wiring change this client cannot apply in place. They share one notice, so a user is
 * never asked twice, and one Reload covers both: when a new worker is waiting it takes
 * control first, so the reload lands on the newest bundle *and* the newest wiring.
 *
 * It never reloads on its own. The page keeps running its current version until the user
 * chooses, which is safe because text edits already live in the local Yjs document and the
 * outbox.
 */

import type { Notice } from "@kernel";

/** The id the service-worker update has always used, kept so there is one notice. */
export const RELOAD_NOTICE_ID = "kernel:update-available";

export type ReloadReason = "update" | "wiring";

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

  /** The wiring moved and this client cannot follow it without a reload. */
  askForWiring(): void {
    this.#ask("wiring");
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
      message: this.#reasons.has("update") ? "An update is available." : "Plugins changed.",
      actions: [{ label: "Reload", run: () => this.reload() }],
    });
  }
}

/**
 * Which wiring version this page runs, and which one the server has. The two arrive in
 * either order: `welcome` can land before the plugin list does.
 */
export class WiringWatch {
  #running: number | undefined;
  #live: number | undefined;

  constructor(private readonly onBehind: (live: number, running: number) => void) {}

  get running(): number | undefined {
    return this.#running;
  }

  /** The version the activated plugin set was resolved from. */
  setRunning(version: number): void {
    this.#running = version;
    this.#check();
  }

  /** The server's live version, from `welcome` or `wiring.applied`. */
  seen(version: number): void {
    this.#live = Math.max(this.#live ?? version, version);
    this.#check();
  }

  #check(): void {
    if (this.#running === undefined || this.#live === undefined) return;
    if (this.#live > this.#running) this.onBehind(this.#live, this.#running);
  }
}

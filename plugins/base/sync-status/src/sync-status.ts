/**
 * The words the sync indicator says, derived from `SyncState` and nothing else.
 *
 * Pure and separate from the component for two reasons: it is the one part of the
 * indicator worth unit-testing, and the phrasing is a promise rather than a detail —
 * SPEC §6.5 makes this the only always-visible signal that an edit has not reached
 * the server, so "synced" must never appear while `pending > 0`, and an unsynced
 * count must never be a silent dot.
 */

import type { SyncState } from "@kernel";

export type SyncTone = "ok" | "busy" | "warn" | "error";

export interface SyncDescription {
  /** Short enough for the navbar at the mobile breakpoint. */
  readonly label: string;
  readonly tone: SyncTone;
  /** The full sentence: `title` on the indicator, and its accessible description. */
  readonly detail: string;
  /** A recovery affordance, when there is one. */
  readonly action?: "reconnect" | "reauth";
  /** Unsynced local edits — rendered as its own badge so it cannot be missed. */
  readonly pending: number;
}

export function describeSync(state: SyncState): SyncDescription {
  const pending = state.pending;
  const unsynced =
    pending > 0
      ? ` ${pending} local edit${pending === 1 ? " has" : "s have"} not reached the server.`
      : "";
  const behind = Math.max(0, state.headSeq - state.safeSeq);

  switch (state.status) {
    case "synced":
      // `pending` outranks the status word: the server has our subscription but not
      // yet our bytes, and calling that "synced" is the one lie that loses work.
      return pending > 0
        ? { label: "Saving…", tone: "busy", detail: `Connected.${unsynced}`, pending }
        : { label: "Synced", tone: "ok", detail: "Everything is saved to the server.", pending };

    case "syncing": {
      const bootstrap = state.bootstrap;
      if (bootstrap && !bootstrap.complete) {
        const of = bootstrap.total !== undefined ? ` of ${bootstrap.total}` : "";
        return {
          label: "First sync…",
          tone: "busy",
          detail: `Downloading your workspace: ${bootstrap.rows}${of} documents.${unsynced}`,
          pending,
        };
      }
      return {
        label: "Syncing…",
        tone: "busy",
        detail: behind > 0 ? `Catching up on ${behind} changes.${unsynced}` : `Syncing.${unsynced}`,
        pending,
      };
    }

    case "connecting":
      return {
        label: "Connecting…",
        tone: "busy",
        detail: `Reconnecting to the server.${unsynced}`,
        pending,
      };

    case "offline":
      return {
        label: "Offline",
        tone: "warn",
        detail: `Offline. Everything is readable and editable; changes are sent when you are back online.${unsynced}`,
        action: "reconnect",
        pending,
      };

    case "auth-required":
      return {
        label: "Sign in",
        tone: "warn",
        // SPEC §5.3: a 401 never clears local data, so say so — the fear this
        // message answers is "did I just lose my notes".
        detail: `Your session expired. Sign in again to resume syncing; nothing local has been discarded.${unsynced}`,
        action: "reauth",
        pending,
      };

    case "error":
      return {
        label: "Sync error",
        tone: "error",
        detail: `${state.lastError ?? "Sync failed."}${unsynced}`,
        action: "reconnect",
        pending,
      };
  }
}

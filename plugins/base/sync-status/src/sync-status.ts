import type { SyncState } from "@kernel";

export type SyncTone = "ok" | "busy" | "warn" | "error";

export interface SyncDescription {
  readonly label: string;
  readonly tone: SyncTone;
  readonly detail: string;
  readonly action?: "reconnect" | "reauth";
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

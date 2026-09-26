/**
 * The sync-status pill: a coloured dot, plus an "n unsynced" chip (SPEC §6.5). When
 * the connection is down the dot becomes a button: a red ✕ while offline, a red ↻ after a
 * sync error, and clicking either reconnects. A lapsed session shows Sign in instead.
 *
 * The dot has no visible word; the word ("Offline", "Synced") is in its `title` and in
 * its live region, which `aria-live="polite"` announces without stealing focus. "3
 * unsynced" stays visible text: an unsynced count is the one fact a user must see
 * before they close the tab, and a colour cannot carry a number.
 */

import { useEffect, useState, type ReactNode } from "react";

import type { Kernel, SyncState } from "@kernel";

import { describeSync } from "./sync-status.js";

function useSyncState(kernel: Kernel): SyncState {
  const [state, setState] = useState<SyncState>(() => kernel.sync.state);
  useEffect(() => kernel.sync.subscribe(setState), [kernel]);
  return state;
}

/** How long the connection must stay down before the pill says so. */
const DOWN_AFTER_MS = 1500;

/**
 * The sync state as the pill shows it: steady rather than live.
 *
 * While disconnected the kernel retries on a backoff, so its status goes offline →
 * connecting → offline on every attempt; drawn as is, the ✕ blinked with each retry.
 * Here "down" (offline or error) only shows once it has lasted `DOWN_AFTER_MS` — so the
 * boot sequence, which starts at `offline`, never flashes it — and then holds through
 * the reconnect attempts until the kernel is actually syncing again.
 */
function useSteadyState(state: SyncState): SyncState {
  const [down, setDown] = useState<"offline" | "error" | undefined>(undefined);
  const hard = state.status === "offline" || state.status === "error" ? state.status : undefined;
  const connected = state.status === "syncing" || state.status === "synced";

  useEffect(() => {
    if (connected || state.status === "auth-required") {
      setDown(undefined);
      return;
    }
    if (!hard) return;
    if (down) {
      if (down !== hard) setDown(hard);
      return;
    }
    const timer = setTimeout(() => setDown(hard), DOWN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connected, hard, down, state.status]);

  if (down) return state.status === down ? state : { ...state, status: down };
  // Not down yet, or no longer: a failed attempt reads as still connecting.
  return hard ? { ...state, status: "connecting" } : state;
}

export function SyncIndicator({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const state = useSteadyState(useSyncState(kernel));
  const status = describeSync(state);

  return (
    <div className="syncstatus:group syncstatus:tap-h syncstatus:inline-flex syncstatus:items-center syncstatus:gap-1 syncstatus:whitespace-nowrap syncstatus:px-1 syncstatus:text-text-muted syncstatus:data-[tone=error]:text-text syncstatus:data-[tone=warn]:text-text" data-tone={status.tone}>
      <span className="syncstatus:inline-flex syncstatus:items-center syncstatus:gap-1" role="status" aria-live="polite" title={status.detail}>
        {status.action === "reconnect" ? null : (
          <span className="syncstatus:size-[0.6em] syncstatus:rounded-full syncstatus:bg-text-muted syncstatus:group-data-[tone=ok]:bg-success syncstatus:group-data-[tone=busy]:bg-accent syncstatus:group-data-[tone=warn]:bg-warning syncstatus:group-data-[tone=error]:bg-danger" aria-hidden="true" />
        )}
        {/* An icon alone on screen; the word stays in the live region so a change is still announced. */}
        <span className="sync-status-label syncstatus:sr-only">{status.label}</span>
      </span>
      {status.action === "reconnect" ? (
        // Offline shows ✕, a failed sync shows ↻; either one is the way to try again.
        <button
          type="button"
          className="sync-status-retry syncstatus:tap-h syncstatus:inline-flex syncstatus:cursor-pointer syncstatus:items-center syncstatus:justify-center syncstatus:rounded syncstatus:border-0 syncstatus:bg-transparent syncstatus:p-0 syncstatus:text-danger syncstatus:hover:bg-bg-raised"
          aria-label={state.status === "offline" ? "Offline. Reconnect" : "Sync failed. Try again"}
          title={`${status.detail} Click to try again.`}
          onClick={() => kernel.sync.reconnectNow()}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="syncstatus:size-[0.8em]"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {state.status === "offline" ? (
              <path d="M18 6 6 18M6 6l12 12" />
            ) : (
              <>
                <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
              </>
            )}
          </svg>
        </button>
      ) : null}
      {status.pending > 0 ? (
        <span className="syncstatus:rounded syncstatus:border syncstatus:border-warning syncstatus:px-1 syncstatus:text-sm syncstatus:text-text syncstatus:compact:text-xs" title={`${status.pending} unsynced`}>
          {status.pending} unsynced
        </span>
      ) : null}
      {status.action === "reauth" ? (
        <button
          type="button"
          className="syncstatus:tap-h syncstatus:inline-flex syncstatus:cursor-pointer syncstatus:items-center syncstatus:justify-center syncstatus:rounded syncstatus:border syncstatus:border-border-strong syncstatus:bg-transparent syncstatus:px-1.5 syncstatus:underline"
          onClick={() => {
            // The kernel owns re-authentication; reloading is the one move a plugin
            // can make that always lands on the auth gate without clearing anything.
            location.reload();
          }}
        >
          Sign in
        </button>
      ) : null}
      {/* The whole sentence, for screen readers and for a hover that is not a tooltip race. */}
      <span className="syncstatus:sr-only">{status.detail}</span>
    </div>
  );
}

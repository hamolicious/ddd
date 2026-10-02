import { useEffect, useState, type ReactNode } from "react";

import type { Kernel, SyncState } from "@kernel";

import { describeSync } from "./sync-status.js";

function useSyncState(kernel: Kernel): SyncState {
  const [state, setState] = useState<SyncState>(() => kernel.sync.state);
  useEffect(() => kernel.sync.subscribe(setState), [kernel]);
  return state;
}

const DOWN_AFTER_MS = 1500;

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
  return hard ? { ...state, status: "connecting" } : state;
}

export function SyncIndicator({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const state = useSteadyState(useSyncState(kernel));
  const status = describeSync(state);

  return (
    <div className="syncstatus:group syncstatus:tap-h syncstatus:inline-flex syncstatus:items-center syncstatus:gap-1 syncstatus:whitespace-nowrap syncstatus:px-1 syncstatus:text-text-muted syncstatus:data-[tone=error]:text-text syncstatus:data-[tone=warn]:text-text" data-tone={status.tone}>
      <span className="syncstatus:inline-flex syncstatus:items-center syncstatus:gap-1" role="status" aria-live="polite" title={status.detail}>
        <span className="syncstatus:inline-flex syncstatus:w-[4ch] syncstatus:items-center syncstatus:justify-center syncstatus:tabular-nums">
          {status.pending > 0 ? (
            <span className="syncstatus:text-sm syncstatus:font-semibold syncstatus:text-warning syncstatus:compact:text-xs" aria-hidden="true" title={`${status.pending} unsynced`}>
              {status.pending > 999 ? "999+" : status.pending}
            </span>
          ) : status.action === "reconnect" ? null : (
            <span className="syncstatus:size-[0.6em] syncstatus:rounded-full syncstatus:bg-text-muted syncstatus:group-data-[tone=ok]:bg-success syncstatus:group-data-[tone=busy]:bg-accent syncstatus:group-data-[tone=warn]:bg-warning syncstatus:group-data-[tone=error]:bg-danger" aria-hidden="true" />
          )}
        </span>
        <span className="sync-status-label syncstatus:sr-only">{status.label}</span>
      </span>
      {status.action === "reconnect" ? (
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
      {status.action === "reauth" ? (
        <button
          type="button"
          className="syncstatus:tap-h syncstatus:inline-flex syncstatus:cursor-pointer syncstatus:items-center syncstatus:justify-center syncstatus:rounded syncstatus:border syncstatus:border-border-strong syncstatus:bg-transparent syncstatus:px-1.5 syncstatus:underline"
          onClick={() => {
            location.reload();
          }}
        >
          Sign in
        </button>
      ) : null}
      <span className="syncstatus:sr-only">{status.detail}</span>
    </div>
  );
}

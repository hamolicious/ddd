/**
 * The sync-status pill: a coloured dot, plus an "n unsynced" chip and a Retry or Sign in
 * button when the sync state calls for one (SPEC §6.5).
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

export function SyncIndicator({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const state = useSyncState(kernel);
  const status = describeSync(state);

  return (
    <div className="syncstatus:group syncstatus:tap-h syncstatus:inline-flex syncstatus:items-center syncstatus:gap-1 syncstatus:whitespace-nowrap syncstatus:px-1 syncstatus:text-text-muted syncstatus:data-[tone=error]:text-text syncstatus:data-[tone=warn]:text-text" data-tone={status.tone}>
      <span className="syncstatus:inline-flex syncstatus:items-center syncstatus:gap-1" role="status" aria-live="polite" title={status.detail}>
        <span className="syncstatus:size-[0.6em] syncstatus:rounded-full syncstatus:bg-text-muted syncstatus:group-data-[tone=ok]:bg-success syncstatus:group-data-[tone=busy]:bg-accent syncstatus:group-data-[tone=warn]:bg-warning syncstatus:group-data-[tone=error]:bg-danger" aria-hidden="true" />
        {/* The dot alone on screen; the word stays in the live region so a change is still announced. */}
        <span className="sync-status-label syncstatus:sr-only">{status.label}</span>
      </span>
      {status.pending > 0 ? (
        <span className="syncstatus:rounded syncstatus:border syncstatus:border-warning syncstatus:px-1 syncstatus:text-sm syncstatus:text-text syncstatus:compact:text-xs" title={`${status.pending} unsynced`}>
          {status.pending} unsynced
        </span>
      ) : null}
      {status.action === "reconnect" ? (
        <button type="button" className="syncstatus:tap-h syncstatus:inline-flex syncstatus:cursor-pointer syncstatus:items-center syncstatus:justify-center syncstatus:rounded syncstatus:border syncstatus:border-border-strong syncstatus:bg-transparent syncstatus:px-1.5 syncstatus:underline" onClick={() => kernel.sync.reconnectNow()}>
          Retry
        </button>
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

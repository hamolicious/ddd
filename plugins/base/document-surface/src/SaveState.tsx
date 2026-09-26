/**
 * The document header's save state: one icon opposite the title, from `kernel.sync`
 * (SPEC §6.4).
 *
 * `sync-status` owns the workspace indicator in the top bar; this one answers the
 * question a person asks *while writing* — "did that last sentence get out?" — which is
 * the `pending` count as much as the connection. There is no save button: an edit is a
 * CRDT update the moment it is typed. It sits on the surface rather than in one mode
 * because every mode can write (a task ticked in Read mode is an edit too).
 *
 * The icon is the glance; the words are its accessible name and tooltip, and the
 * `status` role announces a change.
 */

import { useEffect, useState, type ReactNode } from "react";

import type { Kernel } from "@kernel";

type Tone = "saved" | "busy" | "local" | "warn" | "error";

export function SaveState({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const [state, setState] = useState(() => kernel.sync.state);
  useEffect(() => kernel.sync.subscribe(setState), [kernel]);

  const changes = `${state.pending} change${state.pending === 1 ? "" : "s"}`;
  const [tone, label]: [Tone, string] =
    state.pending > 0
      ? state.status === "offline"
        ? ["local", `Offline. ${changes} saved on this device`]
        : ["busy", `Saving ${changes}…`]
      : state.status === "offline"
        ? ["local", "Offline. Everything typed is saved on this device"]
        : state.status === "connecting" || state.status === "syncing"
          ? ["busy", "Reconnecting…"]
          : state.status === "auth-required"
            ? ["warn", "Sign in again to sync. Nothing is lost"]
            : state.status === "error"
              ? ["error", state.lastError ? `Sync error: ${state.lastError}` : "Sync error"]
              : ["saved", "Saved"];

  return (
    <span
      className="docsurface-save docsurface:inline-flex docsurface:size-7 docsurface:shrink-0 docsurface:items-center docsurface:justify-center docsurface:text-text-muted docsurface:transition-colors docsurface:data-[tone=busy]:text-accent docsurface:data-[tone=local]:text-warning docsurface:data-[tone=warn]:text-warning docsurface:data-[tone=error]:text-danger"
      role="status"
      aria-label={label}
      title={label}
      data-tone={tone}
      data-status={state.status}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {/* A cloud, and what is in it: a tick, an arrow going up, or a slash. */}
        <path d="M7 18h10.5a4 4 0 00.6-7.95A6 6 0 006.3 9.1 4.5 4.5 0 007 18z" />
        {tone === "saved" && <path d="M9.5 13.5l2 2 3.5-4" />}
        {tone === "busy" && (
          <path className="docsurface:motion-safe:animate-pulse" d="M12 16v-5M9.8 13.2L12 11l2.2 2.2" />
        )}
        {tone === "local" && <path d="M4 4l16 16" />}
        {(tone === "warn" || tone === "error") && <path d="M12 11v2.5M12 16h.01" />}
      </svg>
    </span>
  );
}

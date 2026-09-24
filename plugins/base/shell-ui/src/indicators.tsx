/**
 * The two things the shell renders that are not somebody else's contribution: the
 * sync-status indicator and the notice bell.
 *
 * **Sync status** is `shell-ui`'s by SPEC §6.5, and it is a text label rather than a
 * coloured dot on purpose — "Offline" and "3 unsynced" are the two facts a user needs
 * before they close the tab, and a dot communicates neither. `aria-live="polite"`
 * announces transitions without stealing focus.
 *
 * **The notice bell** is the in-shell way back to the kernel's notices (SPEC §6.4's
 * aggregated plugin-failure notice, SPEC §8's "update available — reload"). The
 * kernel's own frame renders a strip above the shell so that a *broken* shell cannot
 * hide it; the bell is what a working shell adds — a count that stays reachable while
 * the user is reading something else, and the same actions on the same notices.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { Kernel } from "@kernel";

import { useNotices, useSyncState } from "./hooks.js";
import { describeSync } from "./sync-status.js";

export function SyncIndicator({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const state = useSyncState(kernel);
  const status = describeSync(state);

  return (
    <div className="shell-sync" data-tone={status.tone}>
      <span className="shell-sync-text" role="status" aria-live="polite" title={status.detail}>
        <span className="shell-sync-dot" aria-hidden="true" />
        <span className="shell-sync-label">{status.label}</span>
      </span>
      {status.pending > 0 ? (
        <span className="shell-sync-pending" title={`${status.pending} unsynced`}>
          {status.pending} unsynced
        </span>
      ) : null}
      {status.action === "reconnect" ? (
        <button type="button" className="shell-sync-action" onClick={() => kernel.sync.reconnectNow()}>
          Retry
        </button>
      ) : null}
      {status.action === "reauth" ? (
        <button
          type="button"
          className="shell-sync-action"
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
      <span className="shell-visually-hidden">{status.detail}</span>
    </div>
  );
}

export function NoticeBell({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const notices = useNotices(kernel);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const container = useRef<HTMLDivElement>(null);

  // Nothing to say: no bell at all, rather than a permanently empty affordance.
  const count = notices.length;

  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (count === 0) return null;

  const worst = notices.some((notice) => notice.level === "error")
    ? "error"
    : notices.some((notice) => notice.level === "warning")
      ? "warning"
      : "info";

  return (
    <div className="shell-notices" ref={container}>
      <button
        type="button"
        className="shell-notice-bell"
        data-level={worst}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">!</span>
        <span className="shell-notice-count">{count}</span>
        <span className="shell-visually-hidden">
          {count} notice{count === 1 ? "" : "s"}
        </span>
      </button>
      <div id={panelId} className="shell-notice-panel" hidden={!open} role="group" aria-label="Notices">
        <ul>
          {notices.map((notice) => (
            <li key={notice.id} data-level={notice.level}>
              <p className="shell-notice-message">{notice.message}</p>
              {notice.pluginId ? (
                <p className="shell-notice-plugin">
                  plugin <code>{notice.pluginId}</code>
                </p>
              ) : null}
              {notice.detail ? (
                <details>
                  <summary>Details</summary>
                  <pre>{notice.detail}</pre>
                </details>
              ) : null}
              <p className="shell-notice-actions">
                {(notice.actions ?? []).map((action) => (
                  <button key={action.label} type="button" onClick={() => action.run()}>
                    {action.label}
                  </button>
                ))}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

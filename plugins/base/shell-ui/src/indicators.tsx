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
 * aggregated plugin-failure notice, SPEC §8's "update available — reload"). While this
 * shell holds the mount the bell is the *only* rendering of them: the kernel's frame
 * keeps its own strip in reserve for a workspace with no shell mounted, one whose holder
 * threw while rendering, and `?safe=bare`, where the kernel's own manager holds the mount
 * and draws no notices (`web/app/src/ui/AppFrame.tsx`). Both drew the list at once until
 * this was written down, which put every notice on screen twice and made "dismiss" a
 * thing you had to do in two places.
 *
 * The consequence for a *replacement* shell is worth stating: taking the mount means
 * taking this job. A shell that renders no notices leaves them reachable only through
 * `kernel.ui.notices()`.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { Kernel } from "@kernel";

import { useNotices, useSyncState } from "./hooks.js";
import { describeSync } from "./sync-status.js";

export function SyncIndicator({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const state = useSyncState(kernel);
  const status = describeSync(state);

  return (
    <div className="group tap-h inline-flex items-center gap-1 whitespace-nowrap px-1 text-text-muted data-[tone=error]:text-text data-[tone=warn]:text-text" data-tone={status.tone}>
      <span className="inline-flex items-center gap-1" role="status" aria-live="polite" title={status.detail}>
        <span className="size-[0.6em] rounded-full bg-text-muted group-data-[tone=ok]:bg-success group-data-[tone=busy]:bg-accent group-data-[tone=warn]:bg-warning group-data-[tone=error]:bg-danger" aria-hidden="true" />
        <span className={`shell-sync-label compact:text-sm ${status.tone === "ok" ? " compact:hidden" : ""}`}>{status.label}</span>
      </span>
      {status.pending > 0 ? (
        <span className="rounded border border-warning px-1 text-sm text-text compact:text-xs" title={`${status.pending} unsynced`}>
          {status.pending} unsynced
        </span>
      ) : null}
      {status.action === "reconnect" ? (
        <button type="button" className="tap-h inline-flex cursor-pointer items-center justify-center rounded border border-border-strong bg-transparent px-1.5 underline" onClick={() => kernel.sync.reconnectNow()}>
          Retry
        </button>
      ) : null}
      {status.action === "reauth" ? (
        <button
          type="button"
          className="tap-h inline-flex cursor-pointer items-center justify-center rounded border border-border-strong bg-transparent px-1.5 underline"
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
      <span className="sr-only">{status.detail}</span>
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
  /**
   * The ids this bell has already shown the user.
   *
   * Seeded during the **first render** — the lazy-ref pattern, idempotent and observable
   * nowhere else — rather than in the effect below, so that the boundary between "was
   * already there" and "just arrived" is the moment the bell appeared, not the moment
   * React got round to flushing passive effects. A notice raised during the commit that
   * mounted this shell (an error boundary catching a contributed component, SPEC §6.4) is
   * therefore new, which is what it is.
   */
  const announced = useRef<ReadonlySet<string> | undefined>(undefined);
  if (announced.current === undefined) {
    announced.current = new Set(notices.map((notice) => notice.id));
  }

  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  /**
   * A notice that **arrives while the bell is up** opens the panel by itself, once.
   *
   * The kernel's strip stands down while a shell holds the mount — the two used to
   * render the same list and every notice appeared twice — so this bell is the only
   * place SPEC §6.4's aggregated plugin failure and SPEC §8's "update available —
   * reload" are shown. Left to a badge alone, both would be a number beside an
   * exclamation mark: the failure would go unread, and the update's `Reload` action
   * would be two clicks behind an affordance nobody had reason to press.
   *
   * No filtering by level. The kernel's notice centre is already the "the user has to
   * be told once" channel and nothing routine goes through it, so a rule about which
   * levels deserve attention would be a second, quieter policy about the same
   * question — and the wrong half of it is a notice nobody ever sees.
   *
   * **"Arrives" is doing the work, and the seed above is why.** Boot raises notices before
   * this plugin exists — a waiting service worker's `kernel:update-available`, a browser
   * that refused storage persistence — so an empty starting set made every one of them
   * "fresh" on first paint and sprang the panel open over the navbar on *every* reload
   * until the underlying condition changed. Seeding from what is already on the list makes
   * the rule the one the paragraphs above describe: the badge carries what the boot
   * sequence found, and the panel opens for what happens next.
   *
   * Once, too: a re-render, or a plugin that throws on every paint and pushes the same
   * aggregate notice again, must not re-open a panel the user closed.
   */
  useEffect(() => {
    const previous = announced.current ?? new Set<string>();
    // Only the ids still on the list are remembered, so a notice that was dismissed and
    // later raised again is a new one rather than one the user has already answered.
    announced.current = new Set(notices.map((notice) => notice.id));
    if (notices.some((notice) => !previous.has(notice.id))) setOpen(true);
  }, [notices]);

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
    <div className="relative inline-flex compact:static" ref={container}>
      <button
        type="button"
        className="shell-notice-bell tap box-border inline-flex cursor-pointer items-center justify-center gap-1 rounded border border-border bg-transparent px-2.5 hover:bg-bg-raised compact:w-[var(--lm-tap-target)] compact:gap-0 compact:p-0! data-[level=warning]:border-warning data-[level=warning]:text-warning data-[level=error]:border-danger data-[level=error]:text-danger"
        data-level={worst}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">!</span>
        <span className="tabular-nums">{count}</span>
        <span className="sr-only">
          {count} notice{count === 1 ? "" : "s"}
        </span>
      </button>
      <div id={panelId} className="shell-notice-panel absolute right-0 top-[calc(100%+var(--lm-space)*0.5)] z-25 max-h-[calc(var(--lm-viewport-height)*0.6)] w-[min(26rem,calc(100vw-var(--lm-space)*2))] overflow-y-auto rounded-lg border border-border bg-bg-raised p-2 shadow-2 compact:inset-x-2 compact:w-auto compact:pb-[calc(var(--lm-space)+var(--lm-safe-bottom))] [&_li]:border-b [&_li]:border-border [&_li]:py-1.5 [&_li:last-child]:border-b-0 [&_pre]:mt-1 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap [&_ul]:m-0 [&_ul]:list-none [&_ul]:p-0" hidden={!open} role="group" aria-label="Notices">
        <ul>
          {notices.map((notice) => (
            <li key={notice.id} data-level={notice.level}>
              <p className={`mb-1 mt-0 [overflow-wrap:anywhere] ${notice.level === "error" ? " text-danger" : notice.level === "warning" ? " text-warning" : ""}`}>{notice.message}</p>
              {notice.pluginId ? (
                <p className="mb-1 mt-0 text-sm text-text-muted">
                  plugin <code>{notice.pluginId}</code>
                </p>
              ) : null}
              {notice.detail ? (
                <details>
                  <summary>Details</summary>
                  <pre>{notice.detail}</pre>
                </details>
              ) : null}
              <p className="m-0 flex flex-wrap gap-1">
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

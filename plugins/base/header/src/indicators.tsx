/**
 * The two things the header renders that are not somebody else's contribution: the
 * sync-status indicator and the notice bell.
 *
 * **Sync status** was `shell-ui`'s by SPEC §6.5 and moved here with the top bar. It is
 * a text label rather than a coloured dot on purpose — "Offline" and "3 unsynced" are
 * the two facts a user needs before they close the tab, and a dot communicates neither.
 * `aria-live="polite"` announces transitions without stealing focus.
 *
 * **The notice bell** is the in-shell way back to the kernel's notices (SPEC §6.4's
 * aggregated plugin-failure notice, SPEC §8's "update available — reload"). While
 * `shell-ui` holds the mount the bell is the *only* rendering of them: the kernel's frame
 * keeps its own strip in reserve for a workspace with no shell mounted, one whose holder
 * threw while rendering, and `?safe=bare`, where the kernel's own manager holds the mount
 * and draws no notices (`web/app/src/ui/AppFrame.tsx`). Both drew the list at once until
 * this was written down, which put every notice on screen twice and made "dismiss" a
 * thing you had to do in two places.
 *
 * The consequence for a *replacement* header is worth stating: the kernel's strip stands
 * down for whoever holds the mount (`shell-ui`), not for this plugin, so a header — or a
 * workspace with no `shell.header` contribution at all — that renders no notices leaves
 * them reachable only through `kernel.ui.notices()`.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { Kernel } from "@kernel";

import { useNotices, useSyncState } from "./hooks.js";
import { describeSync } from "./sync-status.js";

export function SyncIndicator({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const state = useSyncState(kernel);
  const status = describeSync(state);

  return (
    <div className="header:group header:tap-h header:inline-flex header:items-center header:gap-1 header:whitespace-nowrap header:px-1 header:text-text-muted header:data-[tone=error]:text-text header:data-[tone=warn]:text-text" data-tone={status.tone}>
      <span className="header:inline-flex header:items-center header:gap-1" role="status" aria-live="polite" title={status.detail}>
        <span className="header:size-[0.6em] header:rounded-full header:bg-text-muted header:group-data-[tone=ok]:bg-success header:group-data-[tone=busy]:bg-accent header:group-data-[tone=warn]:bg-warning header:group-data-[tone=error]:bg-danger" aria-hidden="true" />
        <span className={`header-sync-label header:compact:text-sm ${status.tone === "ok" ? " header:compact:hidden" : ""}`}>{status.label}</span>
      </span>
      {status.pending > 0 ? (
        <span className="header:rounded header:border header:border-warning header:px-1 header:text-sm header:text-text header:compact:text-xs" title={`${status.pending} unsynced`}>
          {status.pending} unsynced
        </span>
      ) : null}
      {status.action === "reconnect" ? (
        <button type="button" className="header:tap-h header:inline-flex header:cursor-pointer header:items-center header:justify-center header:rounded header:border header:border-border-strong header:bg-transparent header:px-1.5 header:underline" onClick={() => kernel.sync.reconnectNow()}>
          Retry
        </button>
      ) : null}
      {status.action === "reauth" ? (
        <button
          type="button"
          className="header:tap-h header:inline-flex header:cursor-pointer header:items-center header:justify-center header:rounded header:border header:border-border-strong header:bg-transparent header:px-1.5 header:underline"
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
      <span className="header:sr-only">{status.detail}</span>
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
    <div className="header:relative header:inline-flex header:compact:static" ref={container}>
      <button
        type="button"
        className="header-notice-bell header:tap header:box-border header:inline-flex header:cursor-pointer header:items-center header:justify-center header:gap-1 header:rounded header:border header:border-border header:bg-transparent header:px-2.5 header:hover:bg-bg-raised header:compact:w-[var(--lm-tap-target)] header:compact:gap-0 header:compact:p-0! header:data-[level=warning]:border-warning header:data-[level=warning]:text-warning header:data-[level=error]:border-danger header:data-[level=error]:text-danger"
        data-level={worst}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">!</span>
        <span className="header:tabular-nums">{count}</span>
        <span className="header:sr-only">
          {count} notice{count === 1 ? "" : "s"}
        </span>
      </button>
      <div id={panelId} className="header-notice-panel header:absolute header:right-0 header:top-[calc(100%+var(--lm-space)*0.5)] header:z-25 header:max-h-[calc(var(--lm-viewport-height)*0.6)] header:w-[min(26rem,calc(100vw-var(--lm-space)*2))] header:overflow-y-auto header:rounded-lg header:border header:border-border header:bg-bg-raised header:p-2 header:shadow-2 header:compact:inset-x-2 header:compact:w-auto header:compact:pb-[calc(var(--lm-space)+var(--lm-safe-bottom))] header:[&_li]:border-b header:[&_li]:border-border header:[&_li]:py-1.5 header:[&_li:last-child]:border-b-0 header:[&_pre]:mt-1 header:[&_pre]:max-w-full header:[&_pre]:overflow-x-auto header:[&_pre]:whitespace-pre-wrap header:[&_ul]:m-0 header:[&_ul]:list-none header:[&_ul]:p-0" hidden={!open} role="group" aria-label="Notices">
        <ul>
          {notices.map((notice) => (
            <li key={notice.id} data-level={notice.level}>
              <p className={`header:mb-1 header:mt-0 header:[overflow-wrap:anywhere] ${notice.level === "error" ? " header:text-danger" : notice.level === "warning" ? " header:text-warning" : ""}`}>{notice.message}</p>
              {notice.pluginId ? (
                <p className="header:mb-1 header:mt-0 header:text-sm header:text-text-muted">
                  plugin <code>{notice.pluginId}</code>
                </p>
              ) : null}
              {notice.detail ? (
                <details>
                  <summary>Details</summary>
                  <pre>{notice.detail}</pre>
                </details>
              ) : null}
              <p className="header:m-0 header:flex header:flex-wrap header:gap-1">
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

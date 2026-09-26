/**
 * The notice bell: the in-shell way back to the kernel's notices (SPEC §6.4's
 * aggregated plugin-failure notice, SPEC §8's "update available — reload").
 *
 * While `shell-ui` holds the mount the bell is the *only* rendering of them: the
 * kernel's frame keeps its own strip in reserve for a workspace with no shell mounted,
 * one whose holder threw while rendering, and `?safe=bare`, where the kernel's own
 * manager holds the mount and draws no notices (`web/app/src/ui/AppFrame.tsx`). Both
 * drew the list at once until this was written down, which put every notice on screen
 * twice and made "dismiss" a thing you had to do in two places.
 *
 * The consequence is worth stating: the kernel's strip stands down for whoever holds
 * the mount (`shell-ui`), not for this plugin, so with `notices` disabled — or with a
 * header that has no `end` seat — notices are reachable only through
 * `kernel.ui.notices()`.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { Kernel, Notice } from "@kernel";

function useNotices(kernel: Kernel): readonly Notice[] {
  const [notices, setNotices] = useState<readonly Notice[]>(() => kernel.ui.notices());
  useEffect(() => kernel.ui.onNotices(setNotices), [kernel]);
  return notices;
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
    <div className="notices:relative notices:inline-flex notices:compact:static" ref={container}>
      {/* Styled like every other bar button: borderless until hovered. The badge, not
          the button, carries the level's colour. */}
      <button
        type="button"
        className="notices-bell notices:group notices:tap notices:relative notices:box-border notices:inline-flex notices:w-[var(--lm-tap-target)] notices:cursor-pointer notices:items-center notices:justify-center notices:rounded notices:border notices:border-transparent notices:bg-transparent notices:p-0 notices:text-text-muted notices:hover:border-border notices:hover:bg-bg-raised notices:hover:text-text"
        data-level={worst}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="notices:size-[1.15em]"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        <span
          aria-hidden="true"
          className="notices:absolute notices:right-1 notices:top-1 notices:min-w-[1.3em] notices:rounded-full notices:bg-accent notices:px-1 notices:text-center notices:text-[0.7em] notices:font-semibold notices:leading-[1.3em] notices:text-accent-text notices:tabular-nums notices:group-data-[level=warning]:bg-warning notices:group-data-[level=warning]:text-text-inverse notices:group-data-[level=error]:bg-danger notices:group-data-[level=error]:text-danger-text"
        >
          {count}
        </span>
        <span className="notices:sr-only">
          {count} notice{count === 1 ? "" : "s"}
        </span>
      </button>
      <div id={panelId} className="notices-panel notices:absolute notices:right-0 notices:top-[calc(100%+var(--lm-space)*0.5)] notices:z-25 notices:max-h-[calc(var(--lm-viewport-height)*0.6)] notices:w-[min(26rem,calc(100vw-var(--lm-space)*2))] notices:overflow-y-auto notices:rounded-lg notices:border notices:border-border notices:bg-bg-raised notices:p-2 notices:shadow-2 notices:compact:inset-x-2 notices:compact:w-auto notices:compact:pb-[calc(var(--lm-space)+var(--lm-safe-bottom))] notices:[&_li]:border-b notices:[&_li]:border-border notices:[&_li]:py-1.5 notices:[&_li:last-child]:border-b-0 notices:[&_pre]:mt-1 notices:[&_pre]:max-w-full notices:[&_pre]:overflow-x-auto notices:[&_pre]:whitespace-pre-wrap notices:[&_ul]:m-0 notices:[&_ul]:list-none notices:[&_ul]:p-0" hidden={!open} role="group" aria-label="Notices">
        <ul>
          {notices.map((notice) => (
            <li key={notice.id} data-level={notice.level}>
              <p className={`notices:mb-1 notices:mt-0 notices:[overflow-wrap:anywhere] ${notice.level === "error" ? " notices:text-danger" : notice.level === "warning" ? " notices:text-warning" : ""}`}>{notice.message}</p>
              {notice.pluginId ? (
                <p className="notices:mb-1 notices:mt-0 notices:text-sm notices:text-text-muted">
                  plugin <code>{notice.pluginId}</code>
                </p>
              ) : null}
              {notice.detail ? (
                <details>
                  <summary>Details</summary>
                  <pre>{notice.detail}</pre>
                </details>
              ) : null}
              <p className="notices:m-0 notices:flex notices:flex-wrap notices:gap-1">
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

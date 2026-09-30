/**
 * The one open menu or sheet, drawn from the `shell.overlay` spot.
 *
 * **A portal**, because the sidebar declares `container-type: inline-size`, which makes
 * it the containing block for `position: fixed` descendants: a menu rendered in place
 * would be clipped inside a 288 px column.
 *
 * **Popover or sheet.** On a wide screen every menu and sheet is a popover: under its
 * anchor, right-aligned to it; with no anchor (a keyboard shortcut, a command), at the
 * pointer's last press, or under the focused control, or near the top of the screen. It
 * is kept on screen and flips above when there is no room below. On a phone it is a
 * bottom sheet. A modal is a question, not a menu: a centred dialog. Either way the
 * backdrop takes the click that closes it, so a click outside never also lands on
 * whatever is underneath.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";

import type { MenuItem, MenuRequest, ModalRequest, ModalResult, SheetRequest } from "./api.js";
import { useCompact } from "../../_shared/compact.js";

import { ModalForm } from "./Modal.js";

const FOCUSABLE = 'button:not([disabled]), input, select, textarea, [href], [tabindex]:not([tabindex="-1"])';
const GAP = 4;
/** How long a pointer press still says where a menu opened from it belongs. */
const POINT_FRESH_MS = 1500;

/** The last pointer press, for a menu opened with no anchor. */
let lastPoint: { readonly x: number; readonly y: number; readonly at: number } | undefined;
if (typeof document !== "undefined") {
  const remember = (event: MouseEvent): void => {
    lastPoint = { x: event.clientX, y: event.clientY, at: Date.now() };
  };
  document.addEventListener("pointerdown", remember, true);
  document.addEventListener("contextmenu", remember, true);
}

/** A box to place an unanchored popover against: the fresh pointer press, the focused control, or the top middle. */
function fallbackBox(): { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number } {
  if (lastPoint && Date.now() - lastPoint.at < POINT_FRESH_MS) {
    return { top: lastPoint.y, bottom: lastPoint.y, left: lastPoint.x, right: lastPoint.x };
  }
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused !== document.body) {
    const box = focused.getBoundingClientRect();
    if (box.width > 0 || box.height > 0) return { top: box.top, bottom: box.bottom, left: box.left, right: box.left };
  }
  const middle = innerWidth / 2;
  return { top: innerHeight * 0.15, bottom: innerHeight * 0.15, left: middle, right: middle };
}

export type Open =
  | { readonly kind: "menu"; readonly request: MenuRequest }
  | { readonly kind: "sheet"; readonly request: SheetRequest }
  | {
      readonly kind: "modal";
      readonly request: ModalRequest & { readonly onClose: () => void };
      readonly settle: (result: ModalResult) => void;
    };

export function MenuHost({
  open,
  close,
}: {
  readonly open: Open | undefined;
  readonly close: () => void;
}): ReactNode {
  if (!open) return null;
  // Keyed on the request, so a new menu is a fresh mount: focus moves into it again.
  return <Panel key={keyOf(open)} open={open} close={close} />;
}

const keys = new WeakMap<object, number>();
let next = 0;
function keyOf(open: Open): number {
  let key = keys.get(open.request);
  if (key === undefined) {
    key = next++;
    keys.set(open.request, key);
  }
  return key;
}

function Panel({ open, close }: { readonly open: Open; readonly close: () => void }): ReactElement {
  const compact = useCompact();
  const panel = useRef<HTMLDivElement | null>(null);
  const { anchor, title, description } = open.request;
  // A modal is a question, not a menu: always centred, the anchor only takes focus back.
  const popover = open.kind !== "modal" && !compact;
  const anchored = anchor instanceof HTMLElement && anchor.isConnected;
  const [position, setPosition] = useState<{ top: number; left: number } | undefined>(undefined);
  // Where an unanchored popover opened: fixed at open, so it does not chase the pointer.
  const [fallback] = useState(fallbackBox);

  useLayoutEffect(() => {
    if (!popover || !panel.current) return;
    const place = (): void => {
      const box = anchored && anchor ? anchor.getBoundingClientRect() : undefined;
      const own = panel.current?.getBoundingClientRect();
      const width = own?.width ?? 0;
      const height = own?.height ?? 0;
      if (!box) {
        // At the point, opening rightwards and down; kept on screen.
        const left = Math.max(GAP, Math.min(fallback.left, innerWidth - width - GAP));
        const below = fallback.bottom + GAP;
        const top = below + height > innerHeight - GAP ? Math.max(GAP, fallback.top - height - GAP) : below;
        setPosition({ top, left });
        return;
      }
      const left = Math.max(GAP, Math.min(box.right - width, innerWidth - width - GAP));
      const below = box.bottom + GAP;
      const top = below + height > innerHeight - GAP ? Math.max(GAP, box.top - height - GAP) : below;
      setPosition({ top, left });
    };
    place();
    addEventListener("resize", place);
    // A sheet's body can grow after it opens (a list that loads): placed only at its first
    // size, it would run off the bottom of the screen instead of flipping above.
    const growth = new ResizeObserver(place);
    growth.observe(panel.current);
    return () => {
      removeEventListener("resize", place);
      growth.disconnect();
    };
  }, [anchor, anchored, popover, fallback]);

  // Focus moves in once the panel is shown: a popover is `visibility: hidden` until it is
  // placed, and a hidden control cannot take focus.
  const shown = !popover || position !== undefined;
  useEffect(() => {
    if (!shown) return undefined;
    const restore = anchor ?? document.activeElement;
    const target =
      panel.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      panel.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => {
      if (restore instanceof HTMLElement && restore.isConnected) restore.focus();
    };
  }, [anchor, shown]);

  // Escape closes wherever focus is, like the palette.
  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [close]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const focusable = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (focusable.length === 0) return;
    const index = focusable.indexOf(document.activeElement as HTMLElement);
    const move = (to: number): void => {
      event.preventDefault();
      focusable[(to + focusable.length) % focusable.length]?.focus();
    };
    // Arrows and Home / End belong to a modal's text fields and selects.
    const list = open.kind !== "modal";
    if (!list && event.key !== "Tab") return;
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(focusable.length - 1);
    else if (event.key === "Tab") {
      // Nothing behind a modal menu is reachable, so Tab cycles inside it.
      if (event.shiftKey && index <= 0) move(focusable.length - 1);
      else if (!event.shiftKey && index === focusable.length - 1) move(0);
    }
  }, [open.kind]);

  const body =
    open.kind === "menu" ? (
      <MenuSections request={open.request} close={close} />
    ) : open.kind === "modal" ? (
      <ModalForm request={open.request} settle={open.settle} close={close} />
    ) : (
      open.request.render(close)
    );

  // A sheet draws its own body (a picker, a form), so it gets more room than a list of items.
  const width = open.kind === "sheet" ? "ctxmenu:max-w-[min(30rem,calc(100vw-1rem))]" : "ctxmenu:max-w-[min(22rem,calc(100vw-1rem))]";
  const panelClasses = popover
    ? `context-menu ctxmenu:fixed ctxmenu:flex ctxmenu:max-h-[min(70vh,32rem)] ctxmenu:min-w-[14rem] ctxmenu:flex-col ctxmenu:gap-1 ctxmenu:overflow-y-auto ctxmenu:rounded-lg ctxmenu:border ctxmenu:border-border ctxmenu:bg-bg-raised ctxmenu:p-1 ctxmenu:font-sans ctxmenu:text-text ctxmenu:shadow-2 ${width}`
    : "context-menu ctxmenu:flex ctxmenu:max-h-[85dvh] ctxmenu:w-full ctxmenu:flex-col ctxmenu:gap-3 ctxmenu:overflow-y-auto ctxmenu:rounded-t-lg ctxmenu:border ctxmenu:border-b-0 ctxmenu:border-border ctxmenu:bg-bg-raised ctxmenu:p-4 ctxmenu:pb-[calc(var(--lm-space)*1.5+env(safe-area-inset-bottom,0px))] ctxmenu:font-sans ctxmenu:text-text ctxmenu:shadow-2 ctxmenu:sm:max-h-[40rem] ctxmenu:sm:max-w-[30rem] ctxmenu:sm:rounded-lg ctxmenu:sm:border-b ctxmenu:sm:pb-4";

  return createPortal(
    <div
      className={`ctxmenu:fixed ctxmenu:inset-0 ctxmenu:z-[1000] ${popover ? "" : "ctxmenu:flex ctxmenu:items-end ctxmenu:justify-center ctxmenu:bg-bg-overlay ctxmenu:sm:items-center ctxmenu:sm:p-8"}`}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        // The press closes the menu and nothing else: no focus moves to what is underneath,
        // so focus goes back where the menu was opened from.
        event.preventDefault();
        close();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panel}
        className={panelClasses}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={
          popover
            ? position
              ? { top: position.top, left: position.left }
              : { visibility: "hidden", top: 0, left: 0 }
            : undefined
        }
      >
        {popover ? (
          // A sheet's body is the caller's: its title says what it is for.
          open.kind === "sheet" ? (
            <p className="ctxmenu:m-0 ctxmenu:px-2 ctxmenu:pt-1 ctxmenu:text-sm ctxmenu:font-semibold ctxmenu:text-text-muted">{title}</p>
          ) : null
        ) : (
          <header className="ctxmenu:flex ctxmenu:items-center ctxmenu:gap-3">
            <h2 className="ctxmenu:m-0 ctxmenu:min-w-0 ctxmenu:flex-1 ctxmenu:break-words ctxmenu:text-lg">{title}</h2>
            <button
              type="button"
              className="ctxmenu:tap ctxmenu:shrink-0 ctxmenu:rounded ctxmenu:border ctxmenu:border-transparent ctxmenu:bg-transparent ctxmenu:text-text-muted ctxmenu:hover:border-border ctxmenu:hover:text-text"
              aria-label="Close"
              onClick={close}
            >
              ✕
            </button>
          </header>
        )}
        {description ? <p className="ctxmenu:m-0 ctxmenu:px-2 ctxmenu:text-sm ctxmenu:text-text-muted">{description}</p> : null}
        {body}
      </div>
    </div>,
    document.body,
  );
}

function MenuSections({
  request,
  close,
}: {
  readonly request: MenuRequest;
  readonly close: () => void;
}): ReactElement {
  const choose = (item: MenuItem): void => {
    close();
    item.run();
  };
  return (
    <>
      {request.sections.map((section, index) => (
        <div key={section.title ?? index} role="group" aria-label={section.title} className={index > 0 ? "ctxmenu:border-t ctxmenu:border-border ctxmenu:pt-1" : ""}>
          {section.title ? (
            <p className="ctxmenu:m-0 ctxmenu:px-3 ctxmenu:pb-0.5 ctxmenu:pt-1.5 ctxmenu:text-xs ctxmenu:font-semibold ctxmenu:uppercase ctxmenu:tracking-[0.04em] ctxmenu:text-text-muted">
              {section.title}
            </p>
          ) : null}
          <ul className="ctxmenu:m-0 ctxmenu:flex ctxmenu:list-none ctxmenu:flex-col ctxmenu:p-0">
            {section.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                  aria-checked={item.checked}
                  disabled={item.disabled}
                  className={`ctxmenu:tap-h ctxmenu:flex ctxmenu:w-full ctxmenu:items-center ctxmenu:gap-2 ctxmenu:rounded-md ctxmenu:border-0 ctxmenu:bg-transparent ctxmenu:px-3 ctxmenu:py-1 ctxmenu:text-left ctxmenu:hover:bg-bg-subtle ctxmenu:focus-visible:bg-bg-subtle ctxmenu:disabled:opacity-50 ${item.danger ? "ctxmenu:text-danger" : "ctxmenu:text-text"}`}
                  onClick={() => choose(item)}
                >
                  {item.checked === undefined ? null : (
                    <span aria-hidden="true" className="ctxmenu:w-4 ctxmenu:shrink-0 ctxmenu:text-accent">
                      {item.checked ? "✓" : ""}
                    </span>
                  )}
                  {item.icon === undefined ? null : (
                    <span aria-hidden="true" className="ctxmenu:flex ctxmenu:w-4 ctxmenu:shrink-0 ctxmenu:justify-center">
                      {item.icon}
                    </span>
                  )}
                  <span className="ctxmenu:flex ctxmenu:min-w-0 ctxmenu:flex-col">
                    <span>{item.label}</span>
                    {item.hint ? <small className="ctxmenu:text-text-muted">{item.hint}</small> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

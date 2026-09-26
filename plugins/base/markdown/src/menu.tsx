/**
 * The small popup menu behind both right-click affordances: the task state list
 * (SPEC §6.6) and the embedded-attachment actions (SPEC §3.6).
 *
 * Keyboard operability is a requirement, not polish (SPEC §8: "keyboard-operable
 * palette/editor, focus rings"), and a context menu is the easiest place in a renderer to
 * get it wrong — a `div` with click handlers is invisible to a screen reader and
 * unreachable without a pointer. So: real `<button>`s in a `role="menu"`, focus moved to
 * the first item on open, arrows to move, Escape and focus-loss to close, and focus
 * handed **back to the trigger** on the two dismissals the user chose (see `restoreTo`).
 *
 * Positioned with plain CSS relative to the trigger rather than portalled to
 * `kernel.ui.root`: a portal would escape `overflow: hidden` but also escape the
 * document's own stacking context, and a menu that outlives its list item while the
 * document scrolls is worse than one that clips.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

/** Breathing room between the menu and the edge of the screen. */
const GUTTER = 8;
/** Below this a scrolling menu is worse than one that overlaps its trigger. */
const MIN_MENU_HEIGHT = 132;

/**
 * Keep the menu inside the screen.
 *
 * It is `position: absolute` against its trigger (see the file header for why it is not
 * portalled), so no stylesheet can know whether the trigger sits at x = 8 or at x = 340:
 * a task marker in an indented list at 360 px opens a 12 rem menu past the right edge and
 * nothing flips or clamps it. That has to be a measurement, and it is this one.
 *
 * Measured against `visualViewport`, not `innerWidth`/`innerHeight`: on Android the soft
 * keyboard shrinks the **visual** viewport only (SPEC §6.5, M5), so a menu sized against
 * the layout viewport opens underneath the keyboard and looks like it never opened.
 */
function clampIntoViewport(menu: HTMLElement): void {
  menu.style.removeProperty("--md-menu-shift");
  menu.style.removeProperty("--md-menu-max-width");
  menu.style.removeProperty("--md-menu-max-height");
  menu.removeAttribute("data-place");

  const view = window.visualViewport;
  const left = view?.offsetLeft ?? 0;
  const top = view?.offsetTop ?? 0;
  const width = view?.width ?? document.documentElement.clientWidth;
  const height = view?.height ?? document.documentElement.clientHeight;

  menu.style.setProperty("--md-menu-max-width", `${Math.max(width - GUTTER * 2, 160)}px`);

  // Re-read after the width cap: a narrowed menu is taller, and the flip below depends
  // on the height it will actually have.
  const box = menu.getBoundingClientRect();

  let shift = 0;
  if (box.right > left + width - GUTTER) shift = left + width - GUTTER - box.right;
  if (box.left + shift < left + GUTTER) shift = left + GUTTER - box.left;
  menu.style.setProperty("--md-menu-shift", `${Math.round(shift)}px`);

  // `box.top` is the trigger's bottom edge (the menu hangs off it), so these are the two
  // gaps the menu can occupy.
  const below = top + height - GUTTER - box.top;
  const above = box.top - top - GUTTER;
  // Flip only when it genuinely helps: a menu that opens upward from the last line of a
  // document is right, one that opens upward with less room there than below is not.
  const flip = below < Math.min(box.height, MIN_MENU_HEIGHT) && above > below;
  if (flip) menu.setAttribute("data-place", "above");
  menu.style.setProperty(
    "--md-menu-max-height",
    `${Math.round(Math.max(flip ? above : below, MIN_MENU_HEIGHT))}px`,
  );
}

/** Focusable, still in the document, and not the body itself. */
function isRestorable(element: Element | null | undefined): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.isConnected &&
    element !== document.body &&
    !element.hasAttribute("disabled")
  );
}

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  /** Renders as the current choice — the task state the marker is already in. */
  readonly selected?: boolean;
  run(): void;
}

export interface PopupMenuProps {
  /** Names the menu for assistive technology. */
  readonly label: string;
  readonly items: readonly MenuItem[];
  readonly onClose: () => void;
}

export function PopupMenu({ label, items, onClose }: PopupMenuProps): ReactNode {
  const root = useRef<HTMLDivElement | null>(null);
  /**
   * Where focus goes when the menu is dismissed **deliberately** — Escape, or choosing an
   * item. Without it, Escape left `document.activeElement` on `<body>`: a keyboard user
   * who opened the state menu and changed their mind was dropped at the top of the
   * document and had to tab back through the whole shell to reach the next task.
   *
   * It is captured at mount, because by the time the menu closes React has already
   * detached it and the DOM no longer says what it was rendered next to.
   *
   * `document.activeElement` alone is the obvious answer and the wrong one: a right-click
   * does not focus the control it targets, so on the very path this menu exists for, the
   * active element at mount *is* `<body>`. The trigger is the control the menu is
   * rendered beside — both call sites wrap `<trigger/>{menu}` in one element — and the
   * remembered active element is the fallback for a menu opened from the keyboard.
   */
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement;
    const sibling = root.current?.previousElementSibling;
    restoreTo.current = isRestorable(sibling)
      ? sibling
      : isRestorable(opener)
        ? opener
        : null;
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);

  /**
   * Before paint, and again whenever the screen changes shape under it — the soft
   * keyboard opening is a `visualViewport` resize and nothing else, so a menu measured
   * once at mount would be the only thing on screen that did not notice it.
   */
  useLayoutEffect(() => {
    const menu = root.current;
    if (!menu) return;
    const measure = (): void => clampIntoViewport(menu);
    measure();
    const view = window.visualViewport;
    view?.addEventListener("resize", measure);
    view?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    return () => {
      view?.removeEventListener("resize", measure);
      view?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [items.length]);

  /**
   * Close and hand focus back. Deliberately *not* used by the outside-click and
   * focus-loss paths below: those close the menu because the user has already moved
   * somewhere else, and pulling focus back out of it would be the worse bug.
   */
  const dismiss = useCallback((): void => {
    const target = restoreTo.current;
    onClose();
    if (isRestorable(target)) target.focus();
  }, [onClose]);

  useEffect(() => {
    // `mousedown`, not `click`: closing on mousedown means the click that opened another
    // menu is not swallowed by this one's teardown.
    const onPointerDown = (event: Event): void => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("touchstart", onPointerDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("touchstart", onPointerDown, true);
    };
  }, [onClose]);

  const move = (from: HTMLElement, delta: number): void => {
    const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const index = buttons.indexOf(from as HTMLButtonElement);
    const next = buttons[(index + delta + buttons.length) % buttons.length];
    next?.focus();
  };

  return (
    <div
      className="markdown:absolute markdown:left-0 markdown:top-full markdown:z-20 markdown:flex markdown:min-w-48 markdown:max-w-[var(--md-menu-max-width,16rem)] markdown:translate-x-[var(--md-menu-shift,0px)] markdown:flex-col markdown:overflow-y-auto markdown:overscroll-contain markdown:rounded markdown:border markdown:border-border markdown:bg-bg-raised markdown:p-1 markdown:shadow-2 markdown:data-[place=above]:bottom-full markdown:data-[place=above]:top-auto markdown:max-h-[var(--md-menu-max-height,none)]"
      role="menu"
      aria-label={label}
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          move(event.target as HTMLElement, event.key === "ArrowDown" ? 1 : -1);
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) onClose();
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="markdown:tap-h markdown:flex markdown:w-full markdown:shrink-0 markdown:cursor-pointer markdown:items-center markdown:gap-2 markdown:rounded markdown:border-0 markdown:bg-transparent markdown:px-2 markdown:py-1 markdown:text-left markdown:text-text markdown:hover:bg-accent-subtle markdown:focus-visible:bg-accent-subtle markdown:aria-current:font-semibold"
          aria-current={item.selected ? "true" : undefined}
          onClick={() => {
            // Focus back on the trigger before the action runs: choosing a state
            // re-renders the marker, and the control the user was on is the one they
            // should still be on afterwards.
            dismiss();
            item.run();
          }}
        >
          {item.icon === undefined ? null : (
            <span className="markdown:min-w-[1.25em]" aria-hidden="true">
              {item.icon}
            </span>
          )}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Long-press detection for touch (SPEC §6.6: "right-click / **long-press on touch**").
 *
 * Restricted to touch and pen on purpose. Binding it to mouse too would mean a slow
 * click on a checkbox silently opens a menu instead of toggling, which is the kind of
 * interaction bug that only shows up on someone else's trackpad.
 *
 * `moved` cancels: a long press that turns into a scroll is a scroll.
 */
export interface LongPress {
  readonly handlers: {
    readonly onPointerDown: (event: ReactPointerEvent) => void;
    readonly onPointerMove: (event: ReactPointerEvent) => void;
    readonly onPointerUp: () => void;
    readonly onPointerCancel: () => void;
  };
  /** `true` when the press already opened the menu, so the click must not also fire. */
  consumeClick: () => boolean;
}

export function useLongPress(open: () => void, delay = 500): LongPress {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  };

  return {
    handlers: {
      onPointerDown: (event) => {
        if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
        fired.current = false;
        origin.current = { x: event.clientX, y: event.clientY };
        timer.current = setTimeout(() => {
          fired.current = true;
          cancel();
          open();
        }, delay);
      },
      onPointerMove: (event) => {
        const start = origin.current;
        if (!start) return;
        if (Math.abs(event.clientX - start.x) > 10 || Math.abs(event.clientY - start.y) > 10) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
    },
    consumeClick: () => {
      const wasFired = fired.current;
      fired.current = false;
      return wasFired;
    },
  };
}

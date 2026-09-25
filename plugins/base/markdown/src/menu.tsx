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
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

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
      className="md-menu"
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
          className="md-menu-item"
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
            <span className="md-menu-icon" aria-hidden="true">
              {item.icon}
            </span>
          )}
          <span className="md-menu-label">{item.label}</span>
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

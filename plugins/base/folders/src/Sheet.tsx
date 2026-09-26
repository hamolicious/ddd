/**
 * The sheet: one small dialog the tree opens for the things a drag cannot do.
 *
 * **Why it exists at all.** Drag and drop is a mouse gesture — HTML5 DnD does not fire
 * from touch, which is `POLISH-BACKLOG.md` §3 in one sentence: on a phone there was no
 * way to move a document between folders. So every move in this plugin has a second,
 * pointer-free path that ends in the same `fm.path` splice (SPEC §3.3): long-press (or
 * right-click, or the row's ⋯ button, or the `M` key) opens this, and the picker inside
 * it is an ordinary list of buttons.
 *
 * **Why it is a portal.** `shell-ui`'s sidebar declares `container-type: inline-size`,
 * which makes it the containing block for `position: fixed` descendants — a sheet
 * rendered in place would be clipped inside a 288 px column and, in the drawer, inside a
 * transformed ancestor. `commands` reaches for `react-dom`'s `createPortal` for the
 * palette for the same reason; this is that, at panel scale.
 *
 * Keyboard operability is the requirement (SPEC §8): focus moves into the sheet on open,
 * Tab cycles inside it, Escape closes, and focus goes back to whatever opened it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";

import { isWithin, nameOf, normalizePath } from "./path.js";

const FOCUSABLE = 'button:not([disabled]), input, [href], [tabindex]:not([tabindex="-1"])';

export interface SheetProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

export function Sheet({ title, description, onClose, children }: SheetProps): ReactElement {
  const panel = useRef<HTMLDivElement | null>(null);
  /** Where focus came from. Captured at mount: by close time the DOM no longer says. */
  const restoreTo = useRef<Element | null>(
    typeof document === "undefined" ? null : document.activeElement,
  );

  useEffect(() => {
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const previous = restoreTo.current;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      // A dialog that lets Tab wander into the page behind it is a dialog a keyboard
      // user cannot get out of without a pointer, because nothing brings them back.
      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return createPortal(
    <div
      className="folders:fixed folders:inset-0 folders:z-[1000] folders:flex folders:items-end folders:justify-center folders:bg-bg-overlay folders:sm:items-center folders:sm:p-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="folders-sheet folders:flex folders:max-h-[85dvh] folders:w-full folders:flex-col folders:gap-4 folders:overflow-y-auto folders:rounded-t-lg folders:border folders:border-border folders:border-b-0 folders:bg-bg-raised folders:p-5 folders:pb-[calc(var(--lm-space)*1.5+env(safe-area-inset-bottom,0px))] folders:font-sans folders:text-text folders:shadow-2 folders:sm:max-h-[40rem] folders:sm:max-w-[30rem] folders:sm:rounded-lg folders:sm:border folders:sm:pb-5" role="dialog" aria-modal="true" aria-label={title} ref={panel}>
        <header className="folders:flex folders:items-center folders:gap-3">
          <h2 className="folders:m-0 folders:min-w-0 folders:flex-1 folders:break-words folders:text-lg">{title}</h2>
          <button type="button" className="folders:tap folders:shrink-0 folders:rounded folders:border folders:border-transparent folders:bg-transparent folders:text-text-muted folders:hover:border-border folders:hover:text-text" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        {description && <p className="folders:m-0 folders:text-sm folders:text-text-muted">{description}</p>}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export interface SheetAction {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly danger?: boolean;
  run(): void;
}

/** The long-press menu: a list of real buttons, one per action. */
export function SheetActions({ actions }: { readonly actions: readonly SheetAction[] }): ReactElement {
  return (
    <ul className="folders:m-0 folders:flex folders:list-none folders:flex-col folders:gap-1 folders:p-0">
      {actions.map((action) => (
        <li key={action.id}>
          <button
            type="button"
            className={`folders:flex folders:min-h-[var(--lm-tap-target)] folders:w-full folders:flex-col folders:items-start folders:rounded-md folders:border folders:border-transparent folders:bg-transparent folders:px-3 folders:py-2 folders:text-left folders:hover:border-border folders:hover:bg-bg-subtle ${action.danger ? " folders:text-danger" : ""}`}
            onClick={action.run}
          >
            <span>{action.label}</span>
            {action.hint && <small>{action.hint}</small>}
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface MovePickerProps {
  /** Every folder in the workspace, already sorted. */
  readonly folders: readonly string[];
  /** What is being moved — shown, and excluded from the list when it is a folder. */
  readonly subject: string;
  /** The folder it is in now; marked so a no-op choice is visibly a no-op. */
  readonly currentFolder: string;
  /** Set when a folder is moving: it and its descendants cannot be its own destination. */
  readonly excludeSubtree?: string;
  readonly onChoose: (folder: string) => void;
}

/**
 * The keyboard-and-touch half of drag and drop: pick a destination from a filtered list.
 *
 * Root is always the first option and is never filtered away — "take this out of its
 * folder" is the one destination a user cannot type the name of.
 */
export function MovePicker({
  folders,
  subject,
  currentFolder,
  excludeSubtree,
  onChoose,
}: MovePickerProps): ReactElement {
  const [query, setQuery] = useState("");

  const options = useMemo(() => {
    const exclude = excludeSubtree === undefined ? undefined : normalizePath(excludeSubtree);
    const needle = query.trim().toLowerCase();
    return folders.filter((folder) => {
      if (exclude !== undefined && isWithin(folder, exclude)) return false;
      if (needle === "") return true;
      return folder.toLowerCase().includes(needle);
    });
  }, [excludeSubtree, folders, query]);

  return (
    <div className="folders:flex folders:min-h-0 folders:flex-col folders:gap-3">
      <label>
        <span className="folders:sr-only">Filter folders</span>
        <input
          className="folders:min-h-[var(--lm-tap-target)] folders:w-full folders:rounded folders:border folders:border-border folders:bg-bg folders:px-3 folders:text-text"
          type="text"
          value={query}
          placeholder="Filter folders…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <ul className="folders:m-0 folders:flex folders:max-h-[50dvh] folders:list-none folders:flex-col folders:gap-1 folders:overflow-y-auto folders:p-0 folders:sm:max-h-[22rem]">
        <li>
          <button
            type="button"
            className="folders:tap-h folders:flex folders:w-full folders:flex-col folders:items-start folders:rounded folders:border folders:border-transparent folders:bg-transparent folders:px-2 folders:py-1 folders:text-left folders:hover:border-border folders:hover:bg-bg-subtle folders:aria-current:bg-accent-subtle"
            onClick={() => onChoose("")}
            aria-current={currentFolder === "" ? "true" : undefined}
          >
            <span>Root</span>
            <span className="folders:font-mono folders:text-xs folders:text-text-muted">no folder</span>
          </button>
        </li>
        {options.map((folder) => (
          <li key={folder}>
            <button
              type="button"
              className="folders:tap-h folders:flex folders:w-full folders:flex-col folders:items-start folders:rounded folders:border folders:border-transparent folders:bg-transparent folders:px-2 folders:py-1 folders:text-left folders:hover:border-border folders:hover:bg-bg-subtle folders:aria-current:bg-accent-subtle"
              onClick={() => onChoose(folder)}
              aria-current={folder === currentFolder ? "true" : undefined}
            >
              <span>{nameOf(folder)}</span>
              <span className="folders:font-mono folders:text-xs folders:text-text-muted">{folder}</span>
            </button>
          </li>
        ))}
        {options.length === 0 && (
          <li className="folders:p-3 folders:text-sm folders:text-text-muted">
            No folder matches “{query.trim()}”. Move {subject} to Root, or close this and use
            “New folder”.
          </li>
        )}
      </ul>
    </div>
  );
}

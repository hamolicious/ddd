/**
 * The command palette (`Mod+K`).
 *
 * **Keyboard-operable end to end**, which SPEC §8 lists as a requirement rather than
 * polish: the input takes focus on open, `ArrowUp`/`ArrowDown` move the active option,
 * `Home`/`End` jump, `Enter` runs, `Escape` closes, `Tab` is trapped inside the dialog,
 * and focus returns to whatever had it before. The list is a `listbox` with
 * `aria-activedescendant` (rather than moving DOM focus per row, which makes the input
 * lose its value to screen readers), and a polite live region announces the count.
 *
 * It renders through a portal into `document.body` because `shell-ui` owns the single
 * `kernel.ui.mount` (SPEC §6.4) — a plugin that wanted its own root would be taking a
 * mount point that is not its to take. The overlay is therefore a sibling of the app,
 * which is also what makes it survive a shell that re-renders underneath it.
 *
 * **On a phone it is a sheet measured against the *visual* viewport.** Android's soft
 * keyboard does not shrink the layout viewport, so `position: fixed; inset: 0` covers the
 * area behind the keyboard: the input survived (it is at the top) and the last options
 * were unreachable underneath it. `visualViewport` is what reports the visible box, and
 * it moves on scroll as well as on resize — the two custom properties below are that
 * measurement, with `dvh` in the stylesheet as the fallback for a browser without the API.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import { createPortal } from "react-dom";

import { useCompact, useVisibleViewport } from "../../_shared/compact.js";
import { formatKeys } from "./keys.js";
import { rankMatches } from "./match.js";
import type { Command } from "../../_shared/points.js";

export interface PaletteProps {
  readonly commands: readonly Command[];
  readonly bindingFor: (commandId: string) => string | undefined;
  readonly onRun: (command: Command) => void;
  readonly onClose: () => void;
  readonly initialQuery?: string;
  /** Shown above the list when a binding is ambiguous (SPEC §6.5: conflicts are listed). */
  readonly conflictCount?: number;
  readonly onShowConflicts?: () => void;
}

export function Palette({
  commands,
  bindingFor,
  onRun,
  onClose,
  initialQuery = "",
  conflictCount = 0,
  onShowConflicts,
}: PaletteProps): ReactElement {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const restoreTo = useRef<Element | null>(null);
  const baseId = useId();

  const results = useMemo(() => rankMatches(query, commands), [query, commands]);
  const clamped = results.length === 0 ? 0 : Math.min(active, results.length - 1);

  useEffect(() => {
    restoreTo.current = document.activeElement;
    inputRef.current?.focus();
    // Focus goes back where it came from, or the palette is a keyboard dead end.
    return () => {
      const target = restoreTo.current;
      if (target instanceof HTMLElement && document.contains(target)) target.focus();
    };
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the active row in view without scrolling the page behind the overlay.
  useEffect(() => {
    const list = listRef.current;
    const option = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    option?.scrollIntoView({ block: "nearest" });
  }, [clamped, results.length]);

  const run = useCallback(
    (command: Command | undefined) => {
      if (!command) return;
      onClose();
      onRun(command);
    },
    [onClose, onRun],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        case "ArrowDown":
          event.preventDefault();
          setActive((current) => (results.length === 0 ? 0 : (current + 1) % results.length));
          return;
        case "ArrowUp":
          event.preventDefault();
          setActive((current) =>
            results.length === 0 ? 0 : (current - 1 + results.length) % results.length,
          );
          return;
        case "Home":
          event.preventDefault();
          setActive(0);
          return;
        case "End":
          event.preventDefault();
          setActive(Math.max(0, results.length - 1));
          return;
        case "Enter":
          event.preventDefault();
          run(results[clamped]?.item);
          return;
        case "Tab":
          // A modal dialog with one focusable control: trapping Tab is one line.
          event.preventDefault();
          inputRef.current?.focus();
          return;
        default:
      }
    },
    [clamped, onClose, results, run],
  );

  const listboxId = `${baseId}-list`;
  const activeId = results.length > 0 ? `${baseId}-option-${clamped}` : undefined;

  // Measured only where it is used: on a wide screen the palette is a centred dialog
  // with a `max-height` and there is nothing for a viewport listener to do.
  const compact = useCompact();
  const visible = useVisibleViewport(compact);
  const sheet: CSSProperties | undefined =
    compact && visible
      ? ({
          "--cmd-sheet-top": `${visible.top}px`,
          "--cmd-sheet-height": `${visible.height}px`,
        } as CSSProperties)
      : undefined;

  return createPortal(
    <div
      className="cmd-overlay fixed inset-0 z-[1000] flex items-start justify-center bg-bg-overlay px-2 pb-2 pt-12 compact:p-0"
      {...(sheet ? { style: sheet } : {})}
      // A click on the backdrop dismisses; a click inside must not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        className="cmd-palette flex max-h-[min(70vh,36rem)] w-full max-w-[42rem] flex-col overflow-hidden rounded-lg border border-border bg-bg-raised font-sans text-text shadow-2 focus-within:[&_:focus-visible]:outline-2 focus-within:[&_:focus-visible]:outline-offset-[-2px] focus-within:[&_:focus-visible]:outline-focus compact:fixed compact:inset-x-0 compact:top-[var(--cmd-sheet-top,0px)] compact:h-[var(--cmd-sheet-height,100dvh)] compact:max-h-none compact:max-w-none compact:rounded-none compact:border-0 compact:pb-[env(safe-area-inset-bottom,0px)]"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          className="shrink-0 border-0 border-b border-border bg-transparent px-4 py-3 text-lg text-inherit compact:px-3 compact:py-2"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          {...(activeId ? { "aria-activedescendant": activeId } : {})}
          placeholder="Type a command…"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />

        {conflictCount > 0 && (
          <p className="m-0 border-b border-border px-4 py-2 text-sm text-warning">
            {conflictCount} keybinding {conflictCount === 1 ? "conflict" : "conflicts"}.{" "}
            {onShowConflicts && (
              <button type="button" className="cursor-pointer border-0 bg-transparent text-link underline" onClick={onShowConflicts}>
                Review in settings
              </button>
            )}
          </p>
        )}

        <ul className="cmd-list m-0 flex-1 list-none overflow-y-auto overscroll-contain py-1" id={listboxId} role="listbox" ref={listRef} aria-label="Commands">
          {results.map((result, index) => {
            const command = result.item;
            const keys = bindingFor(command.id);
            return (
              <li
                key={command.id}
                id={`${baseId}-option-${index}`}
                role="option"
                aria-selected={index === clamped}
                className={`tap-h flex cursor-pointer items-center gap-2 px-4 compact:px-3 ${index === clamped ? " bg-accent-subtle" : ""}`}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  run(command);
                }}
              >
                {command.icon !== undefined && <span className="shrink-0 text-text-muted">{command.icon}</span>}
                <span className="min-w-0 flex-1 truncate">
                  {command.category && <span className="cmd-category mr-0.5 text-text-muted after:content-['_›_']">{command.category}</span>}
                  {command.title}
                </span>
                {keys && <kbd className="shrink-0 whitespace-nowrap rounded border border-border bg-bg-subtle px-1.5 font-mono text-[0.85em] text-text-muted">{formatKeys(keys)}</kbd>}
              </li>
            );
          })}
        </ul>

        {results.length === 0 && (
          <p className="m-0 px-4 py-2 text-sm text-text-muted">
            {commands.length === 0
              ? "No commands are registered yet."
              : `Nothing matches “${query}”.`}
          </p>
        )}

        <p className="m-0 border-t border-border px-4 py-2 text-sm text-text-muted" role="status" aria-live="polite">
          {results.length} of {commands.length} commands
        </p>
      </div>
    </div>,
    document.body,
  );
}

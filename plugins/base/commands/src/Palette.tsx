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
 * **On a phone it is a sheet as tall as the visible screen.** Android's soft keyboard
 * does not shrink the layout viewport, so `position: fixed; inset: 0` covers the area
 * behind the keyboard and the last options were unreachable underneath it. The height is
 * the app's `--ddd-viewport-height` (`web/app/src/boot/viewport.ts`), which the app frame
 * is sized from too — CSS, not React state: re-rendering the sheet on every viewport
 * event while the keyboard moved it made it flicker. For the same reason the active row
 * is kept in view by scrolling the list alone, never `scrollIntoView`, which pans the
 * visual viewport as well.
 *
 * **Back closes it** (`_shared/back.ts`): on a phone the back button is the way out.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";

import { useBackToClose } from "../../_shared/back.js";
import { formatKeys } from "./keys.js";
import { rankMatches } from "./match.js";
import type { Command } from "./api.js";

export interface PaletteProps {
  readonly commands: readonly Command[];
  readonly bindingFor: (commandId: string) => string | undefined;
  readonly onRun: (command: Command) => void;
  readonly onClose: () => void;
  /** Draws a command's `icon` by name; without it no icons are drawn. */
  readonly renderIcon?: (name: string) => ReactNode;
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
  renderIcon,
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

  const leave = useBackToClose(onClose);
  const close = useCallback(() => leave(onClose), [leave, onClose]);

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

  // Escape closes wherever focus is: a key handler on the dialog alone missed it once
  // focus had left the input (a click on the panel's padding drops it to <body>).
  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [close]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the active row in view without scrolling the page behind the overlay.
  useEffect(() => {
    const list = listRef.current;
    const option = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [clamped, results.length]);

  const run = useCallback(
    (command: Command | undefined) => {
      if (!command) return;
      leave(() => {
        onClose();
        onRun(command);
      });
    },
    [leave, onClose, onRun],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
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
    [clamped, results, run],
  );

  const listboxId = `${baseId}-list`;
  const activeId = results.length > 0 ? `${baseId}-option-${clamped}` : undefined;

  return createPortal(
    <div
      className="cmd-overlay commands:fixed commands:inset-0 commands:z-[1000] commands:flex commands:items-start commands:justify-center commands:bg-bg-overlay commands:px-2 commands:pb-2 commands:pt-12 commands:compact:p-0"
      // A click on the backdrop dismisses; a click inside must not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        className="cmd-palette commands:flex commands:max-h-[min(70vh,36rem)] commands:w-full commands:max-w-[42rem] commands:flex-col commands:overflow-hidden commands:rounded-lg commands:border commands:border-border commands:bg-bg-raised commands:font-sans commands:text-text commands:shadow-2 commands:focus-within:[&_:focus-visible]:outline-2 commands:focus-within:[&_:focus-visible]:outline-offset-[-2px] commands:focus-within:[&_:focus-visible]:outline-focus commands:compact:fixed commands:compact:inset-x-0 commands:compact:top-0 commands:compact:h-[var(--ddd-viewport-height,100dvh)] commands:compact:max-h-none commands:compact:max-w-none commands:compact:rounded-none commands:compact:border-0 commands:compact:pb-[env(safe-area-inset-bottom,0px)]"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        // A click on the panel's padding or list must not take focus off the input:
        // the arrow keys, Enter and typing all go through it.
        onMouseDown={(event) => {
          if (event.target !== inputRef.current) event.preventDefault();
        }}
      >
        <input
          ref={inputRef}
          className="commands:shrink-0 commands:border-0 commands:border-b commands:border-border commands:bg-transparent commands:px-4 commands:py-3 commands:text-lg commands:text-inherit commands:compact:px-3 commands:compact:py-2"
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
          <p className="commands:m-0 commands:border-b commands:border-border commands:px-4 commands:py-2 commands:text-sm commands:text-warning">
            {conflictCount} keybinding {conflictCount === 1 ? "conflict" : "conflicts"}.{" "}
            {onShowConflicts && (
              <button type="button" className="commands:cursor-pointer commands:border-0 commands:bg-transparent commands:text-link commands:underline" onClick={onShowConflicts}>
                Review in settings
              </button>
            )}
          </p>
        )}

        <ul className="cmd-list commands:relative commands:m-0 commands:min-h-0 commands:flex-1 commands:list-none commands:overflow-y-auto commands:overscroll-contain commands:px-0 commands:py-1" id={listboxId} role="listbox" ref={listRef} aria-label="Commands">
          {results.map((result, index) => {
            const command = result.item;
            const keys = bindingFor(command.id);
            return (
              <li
                key={command.id}
                id={`${baseId}-option-${index}`}
                role="option"
                aria-selected={index === clamped}
                className={`commands:tap-h commands:flex commands:cursor-pointer commands:items-center commands:gap-2 commands:px-4 commands:compact:px-3 ${index === clamped ? " commands:bg-accent-subtle" : ""}`}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  run(command);
                }}
              >
                {renderIcon && (
                  // Every row keeps the slot, so titles line up whether or not they have an icon.
                  <span aria-hidden="true" className="commands:flex commands:w-4 commands:shrink-0 commands:justify-center commands:text-text-muted">
                    {command.icon !== undefined && renderIcon(command.icon)}
                  </span>
                )}
                <span className="commands:min-w-0 commands:flex-1 commands:truncate">
                  {command.category && <span className="cmd-category commands:mr-0.5 commands:text-text-muted commands:after:content-['_›_']">{command.category}</span>}
                  {command.title}
                </span>
                {keys && <kbd className="commands:shrink-0 commands:whitespace-nowrap commands:rounded commands:border commands:border-border commands:bg-bg-subtle commands:px-1.5 commands:font-mono commands:text-[0.85em] commands:text-text-muted">{formatKeys(keys)}</kbd>}
              </li>
            );
          })}
        </ul>

        {results.length === 0 && (
          <p className="commands:m-0 commands:px-4 commands:py-2 commands:text-sm commands:text-text-muted">
            {commands.length === 0
              ? "No commands are registered yet."
              : `Nothing matches “${query}”.`}
          </p>
        )}

        {/* Not shown; still announced, so a screen reader hears how many matched. */}
        <p className="commands:sr-only" role="status" aria-live="polite">
          {results.length} of {commands.length} commands
        </p>
      </div>
    </div>,
    document.body,
  );
}

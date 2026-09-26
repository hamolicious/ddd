/**
 * The shipped task-checkbox interaction (SPEC §6.6).
 *
 * > Shipped interaction (rendering plugin's decision, replaceable): left-click toggles
 * > non-off → off, off → on; right-click / **long-press on touch** opens the state menu.
 *
 * "Rendering plugin's decision, replaceable" is doing work in that sentence: a plugin that
 * wants a different interaction contributes `markdown.component` for `listItem` and gets
 * the whole thing. What is *not* replaceable is the write: whatever the interaction, the
 * change lands as a single-character text splice at the marker's offset (SPEC §3.3), which
 * is what makes two people ticking two boxes in one list a clean CRDT merge instead of a
 * fight over a rewritten block.
 *
 * The menu lists **every registered state in menu order**, including the current one, so
 * the registry is discoverable — a plugin that adds `[/]` and `[-]` needs no UI of its
 * own for them to be reachable.
 */

import { useState, type ReactNode } from "react";

import type { MarkdownTaskState } from "../../_shared/points.js";

import { PopupMenu, useLongPress, type MenuItem } from "./menu.js";
import type { MarkdownRuntime } from "./runtime.js";
import { toggleMarker, type TaskLocation, type TaskRegistry, type TaskScan } from "./tasks.js";

export interface TaskCheckboxProps {
  readonly state: MarkdownTaskState;
  readonly registry: TaskRegistry;
  readonly location: TaskLocation;
  readonly ordinal: number;
  readonly documentId: string | undefined;
  readonly offset: number | undefined;
  readonly runtime: MarkdownRuntime;
  readonly rescan: (body: string) => TaskScan;
}

export function TaskCheckbox({
  state,
  registry,
  location,
  ordinal,
  documentId,
  offset,
  runtime,
  rescan,
}: TaskCheckboxProps): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);
  const longPress = useLongPress(() => setMenuOpen(true));

  /**
   * A checkbox with nowhere to write is rendered **disabled, not hidden**. It happens in
   * two real situations — a preview of text that belongs to no document, and a document
   * whose id the caller did not pass — and in both, showing the state while refusing the
   * click is honest, where a plain non-interactive glyph looks like a bug.
   */
  const writable = documentId !== undefined;

  const write = (marker: string): void => {
    if (!writable || marker === location.marker) return;
    void runtime
      .writeTaskMarker({ documentId, offset, expected: location, ordinal, next: marker, rescan })
      .catch((error: unknown) => {
        runtime.kernel.log.error("task write failed", { documentId, ordinal, error });
      });
  };

  const items: readonly MenuItem[] = registry.states.map((candidate) => ({
    id: candidate.marker,
    label: candidate.label,
    icon: candidate.icon,
    selected: candidate.marker === location.marker,
    run: () => write(candidate.marker),
  }));

  const openMenu = (): void => setMenuOpen(true);

  return (
    <span className="md-task-control markdown:relative markdown:mx-[calc((var(--md-gutter)-var(--lm-tap-target))/2)] markdown:inline-flex markdown:min-w-[var(--lm-tap-target)] markdown:shrink-0 markdown:justify-center">
      <button
        type="button"
        className="md-task-box markdown:tap markdown:size-[var(--lm-tap-target)] markdown:touch-manipulation markdown:select-none markdown:cursor-pointer markdown:rounded markdown:border-0 markdown:bg-transparent markdown:p-0 markdown:text-[1.1em] markdown:leading-none markdown:text-inherit markdown:hover:enabled:bg-accent-subtle markdown:disabled:cursor-default markdown:disabled:opacity-55"
        // `role="checkbox"` with `aria-checked` is the right role even with more than two
        // states: `done` is the binary an assistive technology can act on, and `aria-label`
        // carries the state's real name ("In progress") so the nuance is not lost.
        role="checkbox"
        aria-checked={state.done === true}
        aria-label={state.label}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={!writable}
        title={writable ? `${state.label}. Long-press for other states.` : state.label}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          // A long press already opened the menu; the trailing click must not also toggle.
          if (longPress.consumeClick()) return;
          const next = toggleMarker(location.marker, registry);
          if (next !== null) write(next);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openMenu();
        }}
        onKeyDown={(event) => {
          // The platform gestures for "open the context menu" from the keyboard.
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            openMenu();
          }
        }}
        {...longPress.handlers}
      >
        <span className="md-task-icon" aria-hidden="true">
          {state.icon}
        </span>
      </button>
      {menuOpen ? (
        <PopupMenu label="Task state" items={items} onClose={() => setMenuOpen(false)} />
      ) : null}
    </span>
  );
}

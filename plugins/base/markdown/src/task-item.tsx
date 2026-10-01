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
 * own for them to be reachable. The checkbox is marked `markdown/task` and the menu is
 * `context-menu`'s (`menu.ts`): right-click, long press and the menu key all open it.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { MenuItem } from "plugin:context-menu";
import type { MarkdownTaskState } from "./api.js";

import { target } from "../../_shared/target.js";

import { useMenuItems } from "./menu.js";
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
  state: written,
  registry,
  location,
  ordinal,
  documentId,
  offset,
  runtime,
  rescan,
}: TaskCheckboxProps): ReactNode {
  /**
   * A checkbox with nowhere to write is rendered **disabled, not hidden**. It happens in
   * two real situations — a preview of text that belongs to no document, and a document
   * whose id the caller did not pass — and in both, showing the state while refusing the
   * click is honest, where a plain non-interactive glyph looks like a bug.
   */
  const writable = documentId !== undefined;

  /**
   * The click shows at once; the document catches up after the open and splice. `pending`
   * is the marker the user last chose, shown until the text says it too with no write
   * still in flight. Writes are chained, each expecting the marker the one before it left,
   * so a quick second click is not refused as "the document changed". A refused or failed
   * write drops `pending`, so the box never sticks on a state the text lacks.
   */
  const [pending, setPending] = useState<string | null>(null);
  const [inflight, setInflight] = useState(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (inflight === 0 && pending === location.marker) setPending(null);
  }, [inflight, pending, location.marker]);
  const marker = pending ?? location.marker;
  const state = registry.byMarker.get(marker) ?? written;

  const write = (next: string): void => {
    if (!writable || next === marker) return;
    const expected = { ...location, marker };
    setPending(next);
    setInflight((count) => count + 1);
    chain.current = chain.current
      .then(() => runtime.writeTaskMarker({ documentId, offset, expected, ordinal, next, rescan }))
      .then(
        (wrote) => {
          if (!wrote) setPending(null);
        },
        (error: unknown) => {
          setPending(null);
          runtime.kernel.log.error("task write failed", { documentId, ordinal, error });
        },
      )
      .finally(() => setInflight((count) => count - 1));
  };

  const menuRef = useMenuItems<HTMLButtonElement>((): readonly MenuItem[] =>
    writable
      ? registry.states.map((candidate) => ({
          id: candidate.marker,
          label: candidate.label,
          icon: candidate.icon,
          checked: candidate.marker === marker,
          run: () => write(candidate.marker),
        }))
      : [],
  );

  return (
    <span className="md-task-control markdown:relative markdown:mx-[calc((var(--md-gutter)-var(--ddd-tap-target))/2)] markdown:inline-flex markdown:min-w-[var(--ddd-tap-target)] markdown:shrink-0 markdown:justify-center">
      <button
        type="button"
        // One line tall, so a list of tasks is spaced like a list of text. The 44 px touch
        // target (SPEC §6.5) is the `::before` overlay, which takes no room in the layout.
        className="md-task-box markdown:relative markdown:h-[1.45em] markdown:w-[var(--ddd-tap-target)] markdown:before:absolute markdown:before:inset-x-0 markdown:before:top-1/2 markdown:before:h-[var(--ddd-tap-target)] markdown:before:-translate-y-1/2 markdown:before:content-[''] markdown:touch-manipulation markdown:select-none markdown:cursor-pointer markdown:rounded markdown:border-0 markdown:bg-transparent markdown:p-0 markdown:text-[1.1em] markdown:leading-none markdown:text-inherit markdown:hover:enabled:bg-accent-subtle markdown:disabled:cursor-default markdown:disabled:opacity-55"
        // `role="checkbox"` with `aria-checked` is the right role even with more than two
        // states: `done` is the binary an assistive technology can act on, and `aria-label`
        // carries the state's real name ("In progress") so the nuance is not lost.
        role="checkbox"
        aria-checked={state.done === true}
        aria-label={state.label}
        aria-haspopup="menu"
        disabled={!writable}
        ref={menuRef}
        {...target("markdown/task", marker, { label: "Task state" })}
        title={writable ? `${state.label}. Long-press for other states.` : state.label}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const next = toggleMarker(marker, registry);
          if (next !== null) write(next);
        }}
      >
        <span className="md-task-icon" aria-hidden="true">
          {state.icon}
        </span>
      </button>
    </span>
  );
}

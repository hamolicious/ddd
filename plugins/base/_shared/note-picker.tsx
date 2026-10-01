/**
 * Choosing a note: a filter box over every note, drawn as the folder tree draws them —
 * the note's colour and icon, its title, the notes above it — in a box of its own that
 * scrolls through a virtual list (`virtual-list.ts`), so a workspace of thousands costs a
 * screenful. And the chip that shows the note once chosen.
 *
 * Notes come from a {@link NoteSource}: synchronous, and live through `subscribe`, so a
 * title shows as soon as the index knows it rather than whenever it was first asked.
 *
 * Styled inline, on the kernel's tokens: a shared file gets no Tailwind classes (see
 * `conditions-editor.tsx`). Each option also carries `${classPrefix}-note-option`, for a
 * host that wants a hover.
 */

import { useEffect, useMemo, useReducer, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import type { DocumentsApi, Unsubscribe } from "@kernel";

import { withoutMachineDocuments } from "./machine-docs.js";
import { useVirtualList } from "./virtual-list.js";

export interface PickableNote {
  readonly id: string;
  readonly title: string;
  /** The titles above it, joined by ` / `; `""` at the root or when not known. */
  readonly folder: string;
}

/** A note's colour and icon, as `ddd/folders.decoration` gives them. */
export interface NoteLook {
  readonly background?: string;
  readonly color?: string;
  readonly icon?: ReactNode;
}

export interface NoteSource {
  /** Every note a person can pick, machine-owned ones left out. */
  notes(): readonly PickableNote[];
  /** Fires when `notes` or `look` may answer differently. */
  subscribe(listener: () => void): Unsubscribe;
  look?(id: string): NoteLook | undefined;
}

/** Re-renders on every change `source` announces; returns its notes by id. */
export function useNotes(source: NoteSource): ReadonlyMap<string, PickableNote> {
  const [version, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => source.subscribe(bump), [source]);
  // `version` is the dependency that says `notes()` moved.
  return useMemo(() => new Map(source.notes().map((note) => [note.id, note])), [source, version]);
}

/** A note's name as the tree draws it: on its pill, after its icon. */
export function NoteName({ title, look }: { readonly title: string; readonly look: NoteLook | undefined }): ReactElement {
  const pill = look?.background !== undefined;
  return (
    <span
      style={{
        display: "inline-flex",
        maxWidth: "100%",
        alignItems: "center",
        gap: "0.25rem",
        lineHeight: 1.4,
        verticalAlign: "middle",
        ...(pill ? { borderRadius: "var(--ddd-radius)", paddingInline: "0.375rem", background: look.background } : {}),
        ...(look?.color !== undefined ? { color: look.color } : {}),
      }}
    >
      {look?.icon}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {title || "Untitled"}
      </span>
    </span>
  );
}

const OPTION: CSSProperties = {
  display: "flex",
  width: "100%",
  minHeight: "var(--ddd-tap-target)",
  alignItems: "center",
  gap: "0.5rem",
  border: 0,
  borderRadius: "var(--ddd-radius)",
  background: "transparent",
  paddingInline: "0.5rem",
  textAlign: "left",
  font: "inherit",
  color: "var(--ddd-text)",
  cursor: "pointer",
};

const MUTED: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "0.85em",
  color: "var(--ddd-text-muted)",
};

/** How tall the list's box may grow before it scrolls. */
const BOX_HEIGHT = "16rem";

export interface NotePickerProps {
  readonly source: NoteSource;
  readonly onChoose: (id: string) => void;
  readonly classPrefix: string;
  /** Focus the filter box on mount. */
  readonly autoFocus?: boolean;
}

export function NotePicker({ source, onChoose, classPrefix: p, autoFocus = false }: NotePickerProps): ReactElement {
  const notes = useNotes(source);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = [...notes.values()];
    const matching = needle === "" ? all : all.filter((note) => note.title.toLowerCase().includes(needle) || note.folder.toLowerCase().includes(needle));
    // Title matches before folder-only ones, then by where the note sits.
    const rank = (note: PickableNote): number => (needle !== "" && !note.title.toLowerCase().includes(needle) ? 1 : 0);
    return matching.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        `${a.folder} / ${a.title}`.localeCompare(`${b.folder} / ${b.title}`, undefined, { sensitivity: "base" }),
    );
  }, [notes, query]);
  const virtual = useVirtualList({ count: shown.length, keyOf: (index) => shown[index]?.id ?? String(index), estimate: 44 });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", minWidth: 0, flex: "1 1 16rem" }}>
      <input
        type="search"
        aria-label="Find a note"
        placeholder="Find a note"
        value={query}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          const first = shown[0];
          if (event.key === "Enter" && first !== undefined) {
            event.preventDefault();
            onChoose(first.id);
          }
        }}
      />
      <div
        style={{
          maxHeight: BOX_HEIGHT,
          overflowY: "auto",
          overscrollBehavior: "contain",
          border: "1px solid var(--ddd-border)",
          borderRadius: "var(--ddd-radius)",
          background: "var(--ddd-bg)",
        }}
      >
        {shown.length === 0 ? (
          <p style={{ margin: 0, padding: "0.5rem", ...MUTED }}>No note matches.</p>
        ) : (
          <ul
            ref={virtual.listRef}
            role="listbox"
            aria-label="Notes"
            style={{ margin: 0, padding: 0, listStyle: "none", paddingTop: virtual.before, paddingBottom: virtual.after }}
          >
            {shown.slice(virtual.first, virtual.end).map((note, offset) => (
              <li key={note.id} data-virtual-index={virtual.first + offset} role="option" aria-selected={false}>
                <button
                  type="button"
                  className={`${p}-note-option`}
                  style={OPTION}
                  onClick={() => onChoose(note.id)}
                >
                  <NoteName title={note.title} look={source.look?.(note.id)} />
                  {note.folder !== "" && <span style={MUTED}>{note.folder}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A {@link NoteSource} over one live query of every human document, for a host without the index. */
export function documentsNoteSource(documents: Pick<DocumentsApi, "subscribe">): NoteSource {
  let notes: readonly PickableNote[] = [];
  const listeners = new Set<() => void>();
  let started = false;
  const start = (): void => {
    if (started) return;
    started = true;
    void documents.subscribe({ filter: withoutMachineDocuments() }).then((subscription) => {
      const take = (rows: readonly { id: string; title: string }[]): void => {
        notes = rows.map((row) => ({ id: row.id, title: row.title, folder: "" }));
        for (const listener of [...listeners]) listener();
      };
      take(subscription.result.rows);
      subscription.onChange((result) => take(result.rows));
    });
  };
  return {
    notes: () => {
      start();
      return notes;
    },
    subscribe: (listener) => {
      start();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

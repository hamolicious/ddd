/**
 * Notes as the folder tree draws them, for the pickers here: each note's title and the
 * notes above it (`plugin:indexer`), and its colour and icon (`setNoteLooks`, which
 * `folders` calls).
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactElement } from "react";

import type { Unsubscribe } from "@kernel";
import type { WorkspaceIndex } from "plugin:indexer";

import { NoteName, type NoteLook } from "../../../_shared/note-picker.js";

import type { ParentOf } from "./proximity.js";

/** How notes are dressed, and where they sit: `folders`' functions of the same names. */
export interface NoteLooks {
  readonly look: (id: string) => NoteLook | undefined;
  readonly onLookChange: (listener: () => void) => Unsubscribe;
  /** The note's parent, `""` at the root; for `cwd`. Since 4.6.0. */
  readonly parentOf?: ParentOf;
  /** Fires when the tree changes. Since 4.6.0. */
  readonly onChange?: (listener: () => void) => Unsubscribe;
}

export interface NotesDeps {
  readonly index: Pick<WorkspaceIndex, "documents" | "subscribe" | "version">;
  /** The looks in force, when a plugin has set them. */
  readonly looks: () => NoteLooks | undefined;
  /** Fires when `looks` is set or cleared. */
  readonly onLooksSet: (listener: () => void) => Unsubscribe;
}

export interface KnownNote {
  readonly title: string;
  /** The titles above it, joined by ` / `; `""` at the root. */
  readonly folder: string;
}

export interface NoteHooks {
  /** Every note the index knows, by id; live with it. */
  readonly useKnownNotes: () => ReadonlyMap<string, KnownNote>;
  /** The looks in force; re-renders when they are set, or any note's look or place changes. */
  readonly useLooks: () => { readonly current: NoteLooks | undefined; readonly version: number };
  /** A note's look now, for a row drawn where `useLooks` is live. */
  readonly look: (id: string) => NoteLook | undefined;
}

export function createNoteHooks({ index, looks, onLooksSet }: NotesDeps): NoteHooks {
  return {
    useKnownNotes: () => {
      const version = useSyncExternalStore(index.subscribe, () => index.version);
      // `version` is the dependency that says `documents()` moved.
      return useMemo(
        () => new Map(index.documents().map((note) => [note.id, { title: note.title, folder: note.folder }])),
        [version],
      );
    },
    useLooks: () => {
      const [version, bump] = useState(0);
      useEffect(() => onLooksSet(() => bump((count) => count + 1)), []);
      const current = looks();
      useEffect(() => {
        const again = (): void => bump((count) => count + 1);
        const offLook = current?.onLookChange(again);
        const offTree = current?.onChange?.(again);
        return () => {
          offLook?.();
          offTree?.();
        };
      }, [current]);
      return { current, version };
    },
    look: (id) => looks()?.look(id),
  };
}

const MUTED: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "0.85em",
  color: "var(--lm-text-muted)",
};

/** A note as the tree draws it: its pill and icon, its title, then the notes above it. */
export function NoteRow({
  title,
  folder,
  look,
}: {
  readonly title: string;
  readonly folder: string;
  readonly look: NoteLook | undefined;
}): ReactElement {
  return (
    <>
      <NoteName title={title} look={look} />
      {folder !== "" && <span style={MUTED}>{folder}</span>}
    </>
  );
}

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactElement } from "react";

import type { Unsubscribe } from "@kernel";
import type { WorkspaceIndex } from "plugin:indexer";

import { NoteName, type NoteLook } from "../../../_shared/note-picker.js";

import type { ParentOf } from "./proximity.js";

export interface NoteLooks {
  readonly look: (id: string) => NoteLook | undefined;
  readonly onLookChange: (listener: () => void) => Unsubscribe;
  readonly parentOf?: ParentOf;
  readonly onChange?: (listener: () => void) => Unsubscribe;
}

export interface NotesDeps {
  readonly index: Pick<WorkspaceIndex, "documents" | "subscribe" | "version">;
  readonly looks: () => NoteLooks | undefined;
  readonly onLooksSet: (listener: () => void) => Unsubscribe;
}

export interface KnownNote {
  readonly title: string;
  readonly folder: string;
}

export interface NoteHooks {
  readonly useKnownNotes: () => ReadonlyMap<string, KnownNote>;
  readonly useLooks: () => { readonly current: NoteLooks | undefined; readonly version: number };
  readonly look: (id: string) => NoteLook | undefined;
}

export function createNoteHooks({ index, looks, onLooksSet }: NotesDeps): NoteHooks {
  return {
    useKnownNotes: () => {
      const version = useSyncExternalStore(index.subscribe, () => index.version);
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
  color: "var(--ddd-text-muted)",
};

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

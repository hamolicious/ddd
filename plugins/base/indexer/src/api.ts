import type { DocumentId, Iso8601, Unsubscribe } from "@kernel";

import type { PropertyKind } from "../../_shared/fm-display.js";

export type { PropertyKind };

export type ConnectionKind = "link" | "embed" | "frontmatter";

export type TargetState = "live" | "trashed" | "missing";

export interface Connection {
  readonly id: DocumentId;
  readonly kind: ConnectionKind;
  readonly key?: string;
  readonly count: number;
}

export interface OutgoingConnection extends Connection {
  readonly state: TargetState;
}

export interface NoteConnections {
  readonly outgoing: readonly OutgoingConnection[];
  readonly incoming: readonly Connection[];
}

export interface IndexedDocument {
  readonly id: DocumentId;
  readonly title: string;
  readonly folder: string;
  readonly machine: boolean;
}

export interface FmField {
  readonly key: string;
  readonly count: number;
  readonly machineOnly: boolean;
  readonly kinds: Readonly<Partial<Record<PropertyKind, number>>>;
}

export interface FmValueCount {
  readonly value: string | number | boolean | null;
  readonly count: number;
}

export interface WorkspaceStats {
  readonly documents: {
    readonly live: number;
    readonly trashed: number;
    readonly machine: number;
  };
  readonly words: number;
  readonly characters: number;
  readonly tasks: { readonly open: number; readonly done: number; readonly other: number };
  readonly connections: {
    readonly total: number;
    readonly broken: number;
    readonly toTrash: number;
  };
  readonly orphans: number;
  readonly attachments: number;
  readonly folders: number;
  readonly fmParseErrors: number;
  readonly lastUpdated: Iso8601 | null;
}

export interface IndexScope {
  readonly includeMachine?: boolean;
}

export interface FieldScope {
  readonly exclude?: DocumentId;
}

export interface WorkspaceIndex {
  readonly ready: Promise<void>;
  readonly version: number;
  readonly stats: (scope?: IndexScope) => WorkspaceStats;
  readonly fmFields: (scope?: FieldScope) => readonly FmField[];
  readonly fmValues: (key: string, scope?: FieldScope) => readonly FmValueCount[];
  readonly documents: (scope?: IndexScope) => readonly IndexedDocument[];
  readonly connections: (id: DocumentId) => NoteConnections;
  readonly subscribe: (listener: () => void) => Unsubscribe;
}

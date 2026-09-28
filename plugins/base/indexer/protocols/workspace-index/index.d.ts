/**
 * lm/workspace-index@1.0.0: service, owned by `indexer`.
 *
 * Indexes over the local projection, kept current on every change: a keystroke on this
 * device or a change arriving from the feed. Nothing is written anywhere; every client
 * builds its own, offline included.
 *
 * Trashed documents are counted in `stats().documents.trashed` and nowhere else. Every
 * frontmatter field of every live document is indexed, machine-owned ones included, and
 * keys nested in a map are dotted paths (`project.status`). Content stats are for human
 * documents unless `includeMachine`. Every read is synchronous and answers from the
 * current index; before `ready` resolves that is an empty workspace.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { DocumentId, Iso8601, Unsubscribe } from "@kernel";

/** The protocol this package describes. */
export type ProtocolId = "lm/workspace-index";
export type ProtocolVersion = "1.0.0";

/** A frontmatter value's kind, as `fm-display.ts`'s `inferKind` reports it. */
export type PropertyKind = "string" | "number" | "boolean" | "date" | "array" | "map" | "null";

/**
 * How one document refers to another.
 *
 * - `link` — `[text](doc://<id>)`, `<doc://<id>>`, or a reference definition.
 * - `embed` — `![text](doc://<id>)`: the target's body shown in place.
 * - `frontmatter` — a frontmatter value (or a list item in one) that is a `doc://` URL,
 *   e.g. `parent: doc://01J…`. `key` names the field.
 */
export type ConnectionKind = "link" | "embed" | "frontmatter";

/** Where an outgoing connection lands. `missing`: no such document on this device. */
export type TargetState = "live" | "trashed" | "missing";

export interface Connection {
  /** The other document: the target of an outgoing connection, the source of an incoming one. */
  readonly id: DocumentId;
  readonly kind: ConnectionKind;
  /** The frontmatter key, for `kind: "frontmatter"`. */
  readonly key?: string;
  /** How many times the source refers to the target this way. */
  readonly count: number;
}

export interface OutgoingConnection extends Connection {
  readonly state: TargetState;
}

export interface NoteConnections {
  /** What this document refers to, in the order it first does. Self-references are left out. */
  readonly outgoing: readonly OutgoingConnection[];
  /** Live documents that refer to this one (its backlinks), by title. */
  readonly incoming: readonly Connection[];
}

/** One live document, as the index knows it: enough to draw it without reading the row. */
export interface IndexedDocument {
  readonly id: DocumentId;
  readonly title: string;
  /** `fm.path`, `""` at the root. */
  readonly folder: string;
  /** Machine-owned (`_shared/machine-docs.ts`). */
  readonly machine: boolean;
}

export interface FmField {
  /** The key; a nested one as a dotted path from the top level (`project.status`). */
  readonly key: string;
  /** Documents that have this key. */
  readonly count: number;
  /** Every document with this key is machine-owned. */
  readonly machineOnly: boolean;
  /** How many of those hold each kind of value (`fm-display.ts`'s `inferKind`). */
  readonly kinds: Readonly<Partial<Record<PropertyKind, number>>>;
}

export interface FmValueCount {
  /** A scalar as stored; a list contributes each item. Maps are not listed. */
  readonly value: string | number | boolean | null;
  /** Documents holding it. */
  readonly count: number;
}

export interface WorkspaceStats {
  readonly documents: {
    /** Not in Trash, machine-owned included. */
    readonly live: number;
    readonly trashed: number;
    /** Of `live`, how many are machine-owned. */
    readonly machine: number;
  };
  /** Body only — no frontmatter, no `%%%` sections. Runs of letters and digits: markup and link destinations are not words. */
  readonly words: number;
  readonly characters: number;
  /** List items with a task marker: `[ ]` open, `[x]` done, any other marker `other`. */
  readonly tasks: { readonly open: number; readonly done: number; readonly other: number };
  readonly connections: {
    /** Every outgoing connection, counted once per (source, target, kind, key). */
    readonly total: number;
    /** Of those, pointing at a document this device does not know. */
    readonly broken: number;
    /** Of those, pointing at a document in Trash. */
    readonly toTrash: number;
  };
  /** Documents with no connection to or from another live document. */
  readonly orphans: number;
  /** Distinct `attachment://` ids referenced. */
  readonly attachments: number;
  /** Distinct folders, parents included (`a/b` counts `a` and `a/b`). */
  readonly folders: number;
  /** Documents whose frontmatter did not fully parse (SPEC §3.4). */
  readonly fmParseErrors: number;
  /** The newest `updated_at`; `null` for an empty workspace. */
  readonly lastUpdated: Iso8601 | null;
}

export interface IndexScope {
  /** Count machine-owned documents too. Default `false`. */
  readonly includeMachine?: boolean;
}

export interface FieldScope {
  /**
   * Leave this document out — the one being edited, so what is half typed in it is not
   * offered back as if another note used it.
   */
  readonly exclude?: DocumentId;
}

export interface WorkspaceIndex {
  /** Resolves after the first full build; rejects if the projection could not be read. */
  readonly ready: Promise<void>;
  /** Goes up by one each time any index changes. */
  readonly version: number;
  readonly stats: (scope?: IndexScope) => WorkspaceStats;
  /** Every frontmatter key in use, nested keys included; most-used first. */
  readonly fmFields: (scope?: FieldScope) => readonly FmField[];
  /** The values one key holds, most-used first. */
  readonly fmValues: (key: string, scope?: FieldScope) => readonly FmValueCount[];
  /** Every live document, by title; machine-owned ones only with `includeMachine`. */
  readonly documents: (scope?: IndexScope) => readonly IndexedDocument[];
  /** Outgoing and incoming connections of one document. An unknown id has none. */
  readonly connections: (id: DocumentId) => NoteConnections;
  /** Called after every change to any index. */
  readonly subscribe: (listener: () => void) => Unsubscribe;
}

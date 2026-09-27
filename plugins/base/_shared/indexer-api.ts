/**
 * The service `indexer` provides
 * (`kernel.services.require<IndexerApi>("indexer")`).
 *
 * Indexes over the local projection, kept current on every change — a keystroke on this
 * device (once the kernel's local row catches up, ~250 ms) or a change arriving from the
 * feed. Nothing is written anywhere: every client builds its own, offline included.
 *
 * **Which documents count.** Trashed documents are counted in `stats().documents.trashed`
 * and nowhere else: they have no fields, no words and no connections.
 *
 * **Every frontmatter field is indexed**, from every live document — machine-owned ones
 * (a `fm.path` starting with `.`, `_shared/machine-docs.ts`) included — and keys nested in
 * a map are indexed as dotted paths (`project.status`), the spelling the filter DSL uses
 * (`fm.project.status`). The parent key is listed too, with kind `map`. A client that wants
 * only what a person typed filters on `machineOnly`.
 *
 * Content stats (words, tasks, orphans…) are for human documents unless `includeMachine`,
 * for the reason `doc-list` hides machine-owned ones: "how many words have I written?" does
 * not mean the kernel's settings documents. Their links always count: a link is a link.
 *
 * Every read is synchronous and answers from the current index. Before `ready` resolves
 * that is an empty workspace; await it when an empty answer would be wrong.
 */

import type { DocumentId, Iso8601, Unsubscribe } from "@kernel";

import type { PropertyKind } from "./fm-display.js";

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

export interface IndexerApi {
  /** Resolves after the first full build; rejects if the projection could not be read. */
  readonly ready: Promise<void>;
  /** Goes up by one each time any index changes. */
  readonly version: number;
  /** Content stats are for human documents unless `includeMachine`; `documents` always counts both. */
  stats(scope?: IndexScope): WorkspaceStats;
  /** Every frontmatter key in use in any live document, nested keys included; most-used first. */
  fmFields(scope?: FieldScope): readonly FmField[];
  /** The values one key (dotted for a nested one) holds, most-used first. */
  fmValues(key: string, scope?: FieldScope): readonly FmValueCount[];
  /** Outgoing and incoming connections of one document. An unknown id has none. */
  connections(id: DocumentId): NoteConnections;
  /** Called after every change to any index. */
  subscribe(listener: () => void): Unsubscribe;
}

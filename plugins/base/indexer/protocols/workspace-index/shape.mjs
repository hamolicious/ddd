import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/workspace-index",
  version: "1.0.0",
  kind: "service",
  name: "WorkspaceIndex",
  description: `
Indexes over the local projection, kept current on every change: a keystroke on this device
(once the kernel's local row catches up, about 250 ms later) or a change arriving from the
feed. Nothing is written anywhere; every client builds its own, offline included.

Trashed documents are counted in \`stats().documents.trashed\` and nowhere else: they have no
fields, no words and no connections. Every frontmatter field of every live document is
indexed, machine-owned ones (\`machine: true\`) included. Keys nested in a map
are dotted paths (\`project.status\`), the spelling the filter language uses
(\`fm.project.status\`), and the parent key is listed too, with kind \`map\`. To offer only what
a person typed, filter on \`machineOnly\`.

Content stats are for human documents unless \`includeMachine\`, but links from machine-owned
documents always count: a link is a link. Every read is synchronous and answers from the
current index; before \`ready\` resolves that is an empty workspace, so await it when an empty
answer would be wrong.`,
  imports: `import type { DocumentId, Iso8601, Unsubscribe } from "@kernel";`,
  declarations: `
/** A frontmatter value's kind, as \`fm-display.ts\`'s \`inferKind\` reports it. */
export type PropertyKind = "string" | "number" | "boolean" | "date" | "array" | "map" | "null";

/**
 * How one document refers to another.
 *
 * - \`link\` — \`[text](doc://<id>)\`, \`<doc://<id>>\`, or a reference definition.
 * - \`embed\` — \`![text](doc://<id>)\`: the target's body shown in place.
 * - \`frontmatter\` — a frontmatter value (or a list item in one) that is a \`doc://\` URL,
 *   e.g. \`parent: doc://01J…\`. \`key\` names the field.
 */
export type ConnectionKind = "link" | "embed" | "frontmatter";

/** Where an outgoing connection lands. \`missing\`: no such document on this device. */
export type TargetState = "live" | "trashed" | "missing";

export interface Connection {
  /** The other document: the target of an outgoing connection, the source of an incoming one. */
  readonly id: DocumentId;
  readonly kind: ConnectionKind;
  /** The frontmatter key, for \`kind: "frontmatter"\`. */
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
  /** The titles of the notes above it in the folder tree, joined by \` / \`; \`""\` at the root. */
  readonly folder: string;
  /** Machine-owned (\`_shared/machine-docs.ts\`). */
  readonly machine: boolean;
}

export interface FmField {
  /** The key; a nested one as a dotted path from the top level (\`project.status\`). */
  readonly key: string;
  /** Documents that have this key. */
  readonly count: number;
  /** Every document with this key is machine-owned. */
  readonly machineOnly: boolean;
  /** How many of those hold each kind of value (\`fm-display.ts\`'s \`inferKind\`). */
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
    /** Of \`live\`, how many are machine-owned. */
    readonly machine: number;
  };
  /** Body only — no frontmatter, no \`%%%\` sections. Runs of letters and digits: markup and link destinations are not words. */
  readonly words: number;
  readonly characters: number;
  /** List items with a task marker: \`[ ]\` open, \`[x]\` done, any other marker \`other\`. */
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
  /** Distinct \`attachment://\` ids referenced. */
  readonly attachments: number;
  /** Notes that hold at least one other note in the folder tree. */
  readonly folders: number;
  /** Documents whose frontmatter did not fully parse (SPEC §3.4). */
  readonly fmParseErrors: number;
  /** The newest \`updated_at\`; \`null\` for an empty workspace. */
  readonly lastUpdated: Iso8601 | null;
}

export interface IndexScope {
  /** Count machine-owned documents too. Default \`false\`. */
  readonly includeMachine?: boolean;
}

export interface FieldScope {
  /**
   * Leave this document out — the one being edited, so what is half typed in it is not
   * offered back as if another note used it.
   */
  readonly exclude?: DocumentId;
}`,
  shape: s.object({
    ready: s
      .promise()
      .as("Promise<void>")
      .describe("Resolves after the first full build; rejects if the projection could not be read."),
    version: s.number().describe("Goes up by one each time any index changes."),
    stats: s
      .func()
      .as("(scope?: IndexScope) => WorkspaceStats")
      .describe("Content stats are for human documents unless `includeMachine`; `documents` always counts both."),
    fmFields: s
      .func()
      .as("(scope?: FieldScope) => readonly FmField[]")
      .describe("Every frontmatter key in use in any live document, nested keys included; most-used first."),
    fmValues: s
      .func()
      .as("(key: string, scope?: FieldScope) => readonly FmValueCount[]")
      .describe("The values one key (dotted for a nested one) holds, most-used first."),
    documents: s
      .func()
      .as("(scope?: IndexScope) => readonly IndexedDocument[]")
      .describe("Every live document, by title; machine-owned ones only with `includeMachine`."),
    connections: s
      .func()
      .as("(id: DocumentId) => NoteConnections")
      .describe("Outgoing and incoming connections of one document. An unknown id has none."),
    subscribe: s.func().as("(listener: () => void) => Unsubscribe").describe("Called after every change to any index."),
  }),
};

/**
 * The indexes, over every row of the projection.
 *
 * Two layers, split by cost:
 *
 * - **Per document, incremental.** `sync` is handed the whole projection on every change
 *   (a live query's result is the whole result) and re-extracts only the rows whose
 *   fingerprint moved — the scan of the text is the one thing worth not repeating.
 * - **Workspace-wide, lazy.** Stats, fields, values and backlinks are sums over the
 *   extracted entries, built on the first read after a change and kept until the next.
 *   Maintaining each one incrementally would be a subtract-then-add for every aggregate
 *   on every edit, which is where an index quietly drifts; a rebuild is a loop over a few
 *   thousand small records.
 */

import type { CoreValue, DocumentId, DocumentRow } from "@kernel";

import { inferKind, type PropertyKind } from "../../_shared/fm-display.js";
import type {
  Connection,
  FieldScope,
  FmField,
  FmValueCount,
  IndexScope,
  NoteConnections,
  OutgoingConnection,
  TargetState,
  WorkspaceStats,
} from "../../_shared/indexer-api.js";

import { extract, fingerprint, type Extracted } from "./extract.js";

interface Entry {
  readonly fingerprint: string;
  readonly data: Extracted;
}

interface FieldTally {
  count: number;
  human: number;
  kinds: Partial<Record<PropertyKind, number>>;
  values: Map<string, { value: FmValueCount["value"]; count: number }>;
}

interface Derived {
  readonly fields: readonly FmField[];
  readonly tallies: ReadonlyMap<string, FieldTally>;
  readonly incoming: ReadonlyMap<DocumentId, readonly Connection[]>;
  readonly stats: { readonly human: WorkspaceStats; readonly all: WorkspaceStats };
}

const NO_CONNECTIONS: NoteConnections = { outgoing: [], incoming: [] };

export class WorkspaceIndex {
  readonly #entries = new Map<DocumentId, Entry>();
  #version = 0;
  #derived: Derived | undefined;

  /** Goes up by one each time `sync` changes anything. */
  get version(): number {
    return this.#version;
  }

  /**
   * Bring the index level with `rows` — every row the projection has, Trash included.
   * Returns whether anything changed.
   */
  sync(rows: readonly DocumentRow[]): boolean {
    let changed = false;
    const seen = new Set<DocumentId>();
    for (const row of rows) {
      if (row.purged) continue;
      seen.add(row.id);
      const print = fingerprint(row);
      if (this.#entries.get(row.id)?.fingerprint === print) continue;
      this.#entries.set(row.id, { fingerprint: print, data: extract(row) });
      changed = true;
    }
    for (const id of this.#entries.keys()) {
      if (!seen.has(id)) {
        this.#entries.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.#version += 1;
      this.#derived = undefined;
    }
    return changed;
  }

  stats(scope: IndexScope = {}): WorkspaceStats {
    const { stats } = this.#derive();
    return scope.includeMachine ? stats.all : stats.human;
  }

  fmFields(scope: FieldScope = {}): readonly FmField[] {
    const { fields, tallies } = this.#derive();
    const own = this.#ownFields(scope.exclude);
    if (!own) return fields;
    // Take the one document back out: a count down by one, a kind down by one, and a
    // field gone when it was the only document with it.
    const out: FmField[] = [];
    for (const field of fields) {
      const value = own.get(field.key);
      if (value === undefined) {
        out.push(field);
        continue;
      }
      if (field.count === 1) continue;
      const tally = tallies.get(field.key);
      const human = (tally?.human ?? 0) - (own.machine ? 0 : 1);
      const kind = inferKind(lastSegment(field.key), value);
      const kinds = { ...field.kinds, [kind]: (field.kinds[kind] ?? 1) - 1 };
      if (kinds[kind] === 0) delete kinds[kind];
      out.push({ key: field.key, count: field.count - 1, machineOnly: human === 0, kinds });
    }
    return out.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }

  fmValues(key: string, scope: FieldScope = {}): readonly FmValueCount[] {
    const tally = this.#derive().tallies.get(key);
    if (!tally) return [];
    const counts = new Map([...tally.values].map(([slot, entry]) => [slot, { ...entry }]));
    const own = this.#ownFields(scope.exclude)?.get(key);
    if (own !== undefined) {
      const mine = new Map<string, { value: FmValueCount["value"]; count: number }>();
      countValues(mine, own);
      for (const slot of mine.keys()) {
        const entry = counts.get(slot);
        if (entry && (entry.count -= 1) === 0) counts.delete(slot);
      }
    }
    return [...counts.values()].sort(byCount).map(({ value, count }) => ({ value, count }));
  }

  /** The live document's fields by key, for taking it back out; `undefined` when there is nothing to take. */
  #ownFields(id: DocumentId | undefined): (Map<string, CoreValue> & { machine: boolean }) | undefined {
    const data = id === undefined ? undefined : this.#entries.get(id)?.data;
    if (!data || data.deleted || data.fields.length === 0) return undefined;
    return Object.assign(new Map(data.fields), { machine: data.machine });
  }

  connections(id: DocumentId): NoteConnections {
    const entry = this.#entries.get(id);
    if (!entry || entry.data.deleted) return NO_CONNECTIONS;
    const outgoing: OutgoingConnection[] = entry.data.references.map((reference) => ({
      ...reference,
      state: this.#stateOf(reference.id),
    }));
    return { outgoing, incoming: this.#derive().incoming.get(id) ?? [] };
  }

  #stateOf(id: DocumentId): TargetState {
    const target = this.#entries.get(id);
    if (!target) return "missing";
    return target.data.deleted ? "trashed" : "live";
  }

  #derive(): Derived {
    if (this.#derived) return this.#derived;

    const live = [...this.#entries.values()].map((entry) => entry.data).filter((data) => !data.deleted);
    const trashed = this.#entries.size - live.length;

    // Fields: every key of every live document.
    const tallies = new Map<string, FieldTally>();
    for (const data of live) {
      for (const [key, value] of data.fields) {
        let tally = tallies.get(key);
        if (!tally) {
          tally = { count: 0, human: 0, kinds: {}, values: new Map() };
          tallies.set(key, tally);
        }
        tally.count += 1;
        if (!data.machine) tally.human += 1;
        const kind = inferKind(lastSegment(key), value);
        tally.kinds[kind] = (tally.kinds[kind] ?? 0) + 1;
        countValues(tally.values, value);
      }
    }
    const fields: FmField[] = [...tallies.entries()]
      .map(([key, tally]) => ({ key, count: tally.count, machineOnly: tally.human === 0, kinds: { ...tally.kinds } }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

    // Backlinks, and which documents are connected at all (for orphans).
    const incoming = new Map<DocumentId, Connection[]>();
    const connected = new Set<DocumentId>();
    for (const data of live) {
      for (const reference of data.references) {
        if (this.#stateOf(reference.id) !== "live") continue;
        connected.add(data.id).add(reference.id);
        const list = incoming.get(reference.id) ?? [];
        list.push({ ...reference, id: data.id });
        incoming.set(reference.id, list);
      }
    }
    const titles = new Map(live.map((data) => [data.id, data.title]));
    for (const list of incoming.values()) {
      list.sort((a, b) => (titles.get(a.id) ?? "").localeCompare(titles.get(b.id) ?? "") || a.id.localeCompare(b.id));
    }

    const counts = { live: live.length, trashed, machine: live.filter((data) => data.machine).length };
    const stats = {
      human: this.#stats(live.filter((data) => !data.machine), counts, connected),
      all: this.#stats(live, counts, connected),
    };

    this.#derived = { fields, tallies, incoming, stats };
    return this.#derived;
  }

  #stats(
    docs: readonly Extracted[],
    documents: WorkspaceStats["documents"],
    connected: ReadonlySet<DocumentId>,
  ): WorkspaceStats {
    const tasks = { open: 0, done: 0, other: 0 };
    const connections = { total: 0, broken: 0, toTrash: 0 };
    const attachments = new Set<string>();
    const folders = new Set<string>();
    let words = 0;
    let characters = 0;
    let orphans = 0;
    let fmParseErrors = 0;
    let lastUpdated: string | null = null;

    for (const data of docs) {
      words += data.words;
      characters += data.characters;
      tasks.open += data.tasks.open;
      tasks.done += data.tasks.done;
      tasks.other += data.tasks.other;
      for (const reference of data.references) {
        connections.total += 1;
        const state = this.#stateOf(reference.id);
        if (state === "missing") connections.broken += 1;
        else if (state === "trashed") connections.toTrash += 1;
      }
      for (const id of data.attachments) attachments.add(id);
      for (const folder of ancestors(data.folder)) folders.add(folder);
      if (!connected.has(data.id)) orphans += 1;
      if (data.fmParseError) fmParseErrors += 1;
      if (lastUpdated === null || data.updatedAt > lastUpdated) lastUpdated = data.updatedAt;
    }

    return {
      documents,
      words,
      characters,
      tasks,
      connections,
      orphans,
      attachments: attachments.size,
      folders: folders.size,
      fmParseErrors,
      lastUpdated,
    };
  }
}

/** One count per document per distinct value: a list holding `a` twice is one `a`. */
function countValues(values: FieldTally["values"], value: CoreValue): void {
  const items: readonly CoreValue[] = Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  for (const item of items) {
    if (item !== null && typeof item === "object") continue;
    const slot = `${typeof item}:${String(item)}`;
    if (seen.has(slot)) continue;
    seen.add(slot);
    const existing = values.get(slot);
    if (existing) existing.count += 1;
    else values.set(slot, { value: item, count: 1 });
  }
}

function byCount(a: FmValueCount, b: FmValueCount): number {
  return b.count - a.count || String(a.value).localeCompare(String(b.value));
}

function lastSegment(key: string): string {
  return key.slice(key.lastIndexOf(".") + 1);
}

/** `a/b/c` → `a`, `a/b`, `a/b/c`; `""` has none. */
function ancestors(folder: string): string[] {
  if (folder === "") return [];
  const segments = folder.split("/");
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

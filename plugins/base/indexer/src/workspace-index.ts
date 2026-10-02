import type { CoreValue, DocumentId, DocumentRow } from "@kernel";
import type {
  Connection,
  FieldScope,
  FmField,
  FmValueCount,
  IndexedDocument,
  IndexScope,
  NoteConnections,
  OutgoingConnection,
  TargetState,
  WorkspaceStats,
} from "./api.js";

import { inferKind, type PropertyKind } from "../../_shared/fm-display.js";

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
  readonly documents: readonly IndexedDocument[];
}

const NO_CONNECTIONS: NoteConnections = { outgoing: [], incoming: [] };

export class WorkspaceIndex {
  readonly #entries = new Map<DocumentId, Entry>();
  #version = 0;
  #derived: Derived | undefined;

  get version(): number {
    return this.#version;
  }

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

  #ownFields(id: DocumentId | undefined): (Map<string, CoreValue> & { machine: boolean }) | undefined {
    const data = id === undefined ? undefined : this.#entries.get(id)?.data;
    if (!data || data.deleted || data.fields.length === 0) return undefined;
    return Object.assign(new Map(data.fields), { machine: data.machine });
  }

  documents(scope: IndexScope = {}): readonly IndexedDocument[] {
    const { documents } = this.#derive();
    return scope.includeMachine ? documents : documents.filter((document) => !document.machine);
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

    const folderOf = folderTitles(live);
    const documents = live
      .map(({ id, title, machine }) => ({ id, title, folder: folderOf(id), machine }))
      .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

    this.#derived = { fields, tallies, incoming, stats, documents };
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
      folders: docs.filter((data) => data.children.some((child) => this.#stateOf(child) === "live")).length,
      fmParseErrors,
      lastUpdated,
    };
  }
}

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

function folderTitles(live: readonly Extracted[]): (id: DocumentId) => string {
  const titles = new Map(live.map((data) => [data.id, data.title]));
  const parentOf = new Map<DocumentId, DocumentId>();
  for (const data of [...live].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const child of data.children) {
      if (child !== data.id && titles.has(child) && !parentOf.has(child)) parentOf.set(child, data.id);
    }
  }
  return (id) => {
    const path: string[] = [];
    const seen = new Set([id]);
    for (let parent = parentOf.get(id); parent !== undefined && !seen.has(parent); parent = parentOf.get(parent)) {
      seen.add(parent);
      path.unshift(titles.get(parent) ?? "");
    }
    return path.join(" / ");
  };
}

import type { CoreMap, CoreValue, DocumentId, DocumentRow } from "@kernel";
import type { ConnectionKind } from "./api.js";

import { isMachineDocument } from "../../_shared/machine-docs.js";
import { bodyOf } from "../../_shared/regions.js";

export interface Reference {
  readonly id: DocumentId;
  readonly kind: ConnectionKind;
  readonly key?: string;
  readonly count: number;
}

export interface Extracted {
  readonly id: DocumentId;
  readonly title: string;
  readonly deleted: boolean;
  readonly machine: boolean;
  readonly children: readonly DocumentId[];
  readonly fields: ReadonlyArray<readonly [string, CoreValue]>;
  readonly fmParseError: boolean;
  readonly updatedAt: string;
  readonly references: readonly Reference[];
  readonly attachments: readonly string[];
  readonly words: number;
  readonly characters: number;
  readonly tasks: { readonly open: number; readonly done: number; readonly other: number };
}

export function fingerprint(row: DocumentRow): string {
  return `${row.materialized_version}\u0000${row.updated_at}\u0000${row.deleted}\u0000${row.content?.length ?? -1}`;
}

export function extract(row: DocumentRow): Extracted {
  const machine = isMachineDocument(row);
  const base = {
    id: row.id,
    title: row.title,
    deleted: row.deleted,
    machine,
    children: readChildren(row.plugins),
    fmParseError: row.fm_parse_error,
    updatedAt: row.updated_at,
  };
  if (row.deleted) {
    return { ...base, fields: [], references: [], attachments: [], words: 0, characters: 0, tasks: { open: 0, done: 0, other: 0 } };
  }

  const fields = flattenFm(row.fm);
  const references = new ReferenceSet(row.id);
  frontmatterReferences(fields, references);
  const body = bodyOf(row.content ?? "");
  const scanned = scanBody(body, references);
  return { ...base, ...scanned, fields, references: references.list() };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TASK = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[(.)\]/;
const INLINE_CODE = /(`+)[\s\S]*?\1/g;
const INLINE_LINK = /(!?)\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*<?(doc:[^\s)>]*)/g;
const AUTOLINK = /<(doc:[^\s>]*)>/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*<?(doc:[^\s>]*)/;
const DESTINATION = /\]\([^)]*\)|<[A-Za-z][A-Za-z0-9+.-]*:[^\s>]*>/g;
const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const ATTACHMENT = /attachment:(?:\/\/)?([0-9A-Za-z]{26})(?![0-9A-Za-z-])/g;

function scanBody(body: string, references: ReferenceSet) {
  const tasks = { open: 0, done: 0, other: 0 };
  const attachments = new Set<string>();
  let words = 0;
  let fence: string | null = null;

  for (const line of body.split("\n")) {
    words += line.replace(DESTINATION, " ").match(WORD)?.length ?? 0;

    const opener = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (opener && opener[0] === fence[0] && opener.length >= fence.length && line.trim() === opener) fence = null;
      continue;
    }
    if (opener) {
      fence = opener;
      continue;
    }

    const task = TASK.exec(line)?.[1];
    if (task === " ") tasks.open += 1;
    else if (task === "x" || task === "X") tasks.done += 1;
    else if (task !== undefined) tasks.other += 1;

    const prose = line.replace(INLINE_CODE, "");
    for (const match of prose.matchAll(INLINE_LINK)) {
      references.add(match[2], match[1] === "!" ? "embed" : "link");
    }
    for (const match of prose.matchAll(AUTOLINK)) references.add(match[1], "link");
    const definition = REFERENCE_DEFINITION.exec(prose)?.[1];
    if (definition) references.add(definition, "link");
    for (const match of prose.matchAll(ATTACHMENT)) {
      if (match[1]) attachments.add(match[1]);
    }
  }

  return { attachments: [...attachments], words, characters: body.trim().length, tasks };
}

function frontmatterReferences(
  fields: ReadonlyArray<readonly [string, CoreValue]>,
  references: ReferenceSet,
): void {
  for (const [key, value] of fields) {
    const items: readonly CoreValue[] = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item === "string") references.add(item.trim(), "frontmatter", key);
    }
  }
}

const MAX_DEPTH = 5;

export function flattenFm(fm: CoreMap): Array<readonly [string, CoreValue]> {
  const out: Array<readonly [string, CoreValue]> = [];
  const walk = (map: CoreMap, prefix: string, depth: number): void => {
    for (const [key, value] of Object.entries(map)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      out.push([path, value]);
      if (isMap(value) && depth < MAX_DEPTH) walk(value, path, depth + 1);
    }
  };
  walk(fm, "", 1);
  return out;
}

function isMap(value: CoreValue): value is CoreMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function docIdOf(destination: string): string | null {
  if (!destination.startsWith("doc:")) return null;
  let rest = destination.slice("doc:".length);
  if (rest.startsWith("//")) rest = rest.slice(2);
  const id = rest.split(/[/?#]/, 1)[0] ?? "";
  return id.length > 0 ? id : null;
}

class ReferenceSet {
  readonly #counts = new Map<string, { id: string; kind: ConnectionKind; key?: string; count: number }>();

  constructor(private readonly self: DocumentId) {}

  add(destination: string | undefined, kind: ConnectionKind, key?: string): void {
    const id = destination ? docIdOf(destination) : null;
    if (id === null || id === this.self) return;
    const slot = `${id}\u0000${kind}\u0000${key ?? ""}`;
    const existing = this.#counts.get(slot);
    if (existing) existing.count += 1;
    else this.#counts.set(slot, key === undefined ? { id, kind, count: 1 } : { id, kind, key, count: 1 });
  }

  list(): readonly Reference[] {
    return [...this.#counts.values()];
  }
}

function readChildren(plugins: DocumentRow["plugins"]): readonly DocumentId[] {
  const section = plugins["folders"];
  if (section === null || typeof section !== "object" || Array.isArray(section)) return [];
  const raw = (section as Record<string, CoreValue>)["children"];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw as readonly CoreValue[]) {
    if (typeof entry === "string" && entry.trim() !== "" && !out.includes(entry.trim())) out.push(entry.trim());
  }
  return out;
}

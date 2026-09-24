/**
 * The randomized edit repertoire: what a simulated client actually *does* to a
 * document (SPEC §9 M2 — "randomized concurrent text ops incl. frontmatter and
 * `%%%` edits").
 *
 * Two rules shape every operation, and they are the same rules the real client
 * must obey (SPEC §3.3):
 *
 * - **Frontmatter values are minimal splices.** Only the affected key's value
 *   span is replaced — never a parse → re-serialize → whole-block rewrite, which
 *   destroys comments and corrupts under concurrent edits.
 * - **`%%%` sections are line splices.** One YAML key per line; only the changed
 *   key's line is touched, so different keys merge cleanly and a same-key race
 *   resolves last-occurrence-wins.
 *
 * Body edits carry a **marker** — `{{client#n}}` — and the harness guarantees no
 * operation ever inserts into, or deletes part of, an existing marker. That makes
 * marker survival an exact test for update loss: after convergence, every marker
 * every client ever wrote must appear exactly once (SPEC §9 M2, "no update loss
 * across reconnects"). Concurrent inserts cannot split each other (neither
 * replica can address the other's unseen characters), and later inserts are
 * snapped clear of markers here.
 */

import * as Y from "yjs";

/** Root key of the single `Y.Text` in every document (PROTOCOL.md §3.2). */
export const TEXT_ROOT = "content";

export type OpKind =
  | "body-marker"
  | "body-delete"
  | "fm-set"
  | "fm-title"
  | "section-set"
  | "heading-rewrite";

/** One applied operation, as recorded in the replay journal. */
export interface OpRecord {
  readonly kind: OpKind;
  readonly client: string;
  readonly documentId: string;
  /** The marker this op inserted, when it inserted one. */
  readonly marker?: string;
  readonly detail: string;
  /** `false` when the op found nothing to do (e.g. no deletable span). */
  readonly applied: boolean;
}

const OP_WEIGHTS: readonly (readonly [OpKind, number])[] = [
  ["body-marker", 40],
  ["body-delete", 15],
  ["fm-set", 20],
  ["fm-title", 5],
  ["section-set", 15],
  ["heading-rewrite", 5],
];

const OP_TOTAL = OP_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);

/** Pick an operation kind from the weighted repertoire. */
export function chooseOp(random: () => number): OpKind {
  let ticket = random() * OP_TOTAL;
  for (const [kind, weight] of OP_WEIGHTS) {
    ticket -= weight;
    if (ticket <= 0) return kind;
  }
  return "body-marker";
}

export const MARKER_PATTERN = /\{\{[A-Za-z0-9_-]+#\d+\}\}/g;

export function markerFor(client: string, counter: number): string {
  return `{{${client}#${counter}}}`;
}

/** Every marker occurrence in `text`, in order. */
export function markersIn(text: string): string[] {
  return text.match(MARKER_PATTERN) ?? [];
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

/**
 * The three regions of a document (SPEC §3.1), located byte-exactly the way the
 * shared core locates them: frontmatter only if `---` is the literal first line,
 * machine sections only as the last contiguous run of `%%% <id>` fences.
 */
export interface Regions {
  readonly fmStart: number;
  readonly fmEnd: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly sectionsStart: number;
}

export function regions(text: string): Regions {
  const fmEnd = frontmatterEnd(text);
  const sectionsStart = sectionsStartIndex(text);
  return {
    fmStart: fmEnd === 0 ? 0 : 0,
    fmEnd,
    bodyStart: fmEnd,
    bodyEnd: sectionsStart,
    sectionsStart,
  };
}

/** Index just past the closing `---` line, or 0 when there is no frontmatter. */
export function frontmatterEnd(text: string): number {
  if (!text.startsWith("---\n")) return 0;
  let cursor = 4;
  while (cursor <= text.length) {
    const lineEnd = indexOfLineEnd(text, cursor);
    const line = text.slice(cursor, lineEnd);
    if (line === "---") return Math.min(lineEnd + 1, text.length);
    if (lineEnd >= text.length) return 0; // unterminated block: no frontmatter
    cursor = lineEnd + 1;
  }
  return 0;
}

/**
 * Start index of the trailing `%%%` run, or `text.length` when there is none.
 * A fence run qualifies only when everything from it to the end of the document
 * is fences and blank lines — the core's rule, and the reason a body edit that
 * eats the newline before `%%%` legitimately un-parses a section.
 */
export function sectionsStartIndex(text: string): number {
  const lines = text.split("\n");
  let candidate = text.length;
  let offset = 0;
  const starts: number[] = [];
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (/^%%% [A-Za-z0-9_-]+$/.test(line) && isFenceRun(lines, index)) {
      candidate = starts[index] ?? text.length;
    }
  }
  return candidate;
}

/** `true` when `lines[from..]` is nothing but complete `%%% id`…`%%%` blocks and blanks. */
function isFenceRun(lines: readonly string[], from: number): boolean {
  let index = from;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (!/^%%% [A-Za-z0-9_-]+$/.test(line)) return false;
    index += 1;
    let closed = false;
    while (index < lines.length) {
      const inner = lines[index] ?? "";
      index += 1;
      if (inner === "%%%") {
        closed = true;
        break;
      }
      if (/^%%% [A-Za-z0-9_-]+$/.test(inner)) return false;
    }
    if (!closed) return false;
  }
  return true;
}

/** Marker spans `[start, end)` in `text`. */
export function markerSpans(text: string): (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = [];
  for (const match of text.matchAll(MARKER_PATTERN)) {
    const start = match.index ?? 0;
    spans.push([start, start + match[0].length]);
  }
  return spans;
}

/** Move `index` out of any marker it falls inside (never into one). */
export function safeInsertIndex(text: string, index: number): number {
  let cursor = Math.max(0, Math.min(index, text.length));
  for (const [start, end] of markerSpans(text)) {
    if (cursor > start && cursor < end) return end;
  }
  return cursor;
}

/**
 * The longest deletable span of at most `want` characters starting at or after
 * `index` and ending before `limit`, touching no marker. `undefined` when there
 * is nothing safe to delete.
 */
export function safeDeleteSpan(
  text: string,
  index: number,
  want: number,
  from: number,
  to: number,
): { start: number; length: number } | undefined {
  const spans = markerSpans(text);
  const blocked = (position: number): boolean =>
    spans.some(([start, end]) => position >= start && position < end);

  let start = Math.max(from, Math.min(index, Math.max(from, to - 1)));
  while (start < to && blocked(start)) start += 1;
  if (start >= to) return undefined;

  let length = 0;
  while (length < want && start + length < to && !blocked(start + length)) length += 1;
  return length > 0 ? { start, length } : undefined;
}

function indexOfLineEnd(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  return newline === -1 ? text.length : newline;
}

// ---------------------------------------------------------------------------
// Splices (the two write disciplines of SPEC §3.3)
// ---------------------------------------------------------------------------

/**
 * Set a frontmatter key by replacing **only its value span**; a missing key is
 * added as one line before the closing `---`. Returns `false` when the document
 * has no frontmatter block to splice into.
 */
export function spliceFrontmatterValue(text: Y.Text, key: string, value: string): boolean {
  const current = text.toString();
  const fmEnd = frontmatterEnd(current);
  if (fmEnd === 0) return false;
  const block = current.slice(0, fmEnd);
  const pattern = new RegExp(`^(${escapeRegExp(key)}:)([ \\t]*)(.*)$`, "m");
  const match = pattern.exec(block);

  text.doc?.transact(() => {
    if (match) {
      const lineStart = match.index;
      const valueStart = lineStart + (match[1]?.length ?? 0) + (match[2]?.length ?? 0);
      const valueLength = match[3]?.length ?? 0;
      if (valueLength > 0) text.delete(valueStart, valueLength);
      text.insert(valueStart, value);
    } else {
      // Insert before the closing `---` line, which is the last 4 characters of
      // the block (`---\n`).
      text.insert(Math.max(0, fmEnd - 4), `${key}: ${value}\n`);
    }
  });
  return true;
}

/**
 * Set one YAML line inside the caller's `%%%` section (SPEC §3.3): replace that
 * key's line, or add it before the closing `%%%`. The whole section is appended
 * when the document has none.
 */
export function spliceSectionLine(
  text: Y.Text,
  pluginId: string,
  key: string,
  value: string,
): void {
  const current = text.toString();
  const fenceOpen = `%%% ${pluginId}`;
  const openIndex = findLine(current, fenceOpen, sectionsStartIndex(current));

  if (openIndex === -1) {
    const suffix = current.endsWith("\n") || current.length === 0 ? "" : "\n";
    text.doc?.transact(() => {
      text.insert(text.length, `${suffix}\n${fenceOpen}\n${key}: ${value}\n%%%\n`);
    });
    return;
  }

  const closeIndex = findLine(current, "%%%", openIndex + fenceOpen.length + 1);
  const sectionEnd = closeIndex === -1 ? current.length : closeIndex;
  const body = current.slice(openIndex, sectionEnd);
  const pattern = new RegExp(`^(${escapeRegExp(key)}:)([ \\t]*)(.*)$`, "m");
  const match = pattern.exec(body);

  text.doc?.transact(() => {
    if (match) {
      const lineStart = openIndex + match.index;
      const lineLength = match[0].length;
      text.delete(lineStart, lineLength);
      text.insert(lineStart, `${key}: ${value}`);
    } else {
      text.insert(sectionEnd, `${key}: ${value}\n`);
    }
  });
}

/** Index of a line exactly equal to `line` at or after `from`, or -1. */
function findLine(text: string, line: string, from: number): number {
  let cursor = Math.max(0, from);
  while (cursor <= text.length) {
    const end = indexOfLineEnd(text, cursor);
    if (text.slice(cursor, end) === line) return cursor;
    if (end >= text.length) return -1;
    cursor = end + 1;
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// The repertoire
// ---------------------------------------------------------------------------

const WORDS = [
  "milk",
  "bread",
  "review",
  "invoice",
  "sketch",
  "follow-up",
  "kernel",
  "budget",
  "letter",
  "garden",
];
const FM_KEYS = ["status", "path", "date", "priority", "owner"] as const;
const STATUSES = ["open", "done", "blocked", "waiting"] as const;
const SECTION_PLUGINS = ["calendar", "harness"] as const;
const SECTION_KEYS = ["revision", "source-uid", "checked-at"] as const;

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] ?? (items[0] as T);
}

/**
 * Apply one randomized operation to `text`, as `client`. Deterministic for a
 * given `random` stream and document state.
 */
export function applyOp(
  text: Y.Text,
  documentId: string,
  client: string,
  counter: number,
  random: () => number,
  kind: OpKind = chooseOp(random),
): OpRecord {
  const current = text.toString();
  const { bodyStart, bodyEnd } = regions(current);
  const record = (extra: Partial<OpRecord>): OpRecord => ({
    kind,
    client,
    documentId,
    detail: "",
    applied: true,
    ...extra,
  });

  switch (kind) {
    case "body-marker": {
      const marker = markerFor(client, counter);
      const span = Math.max(0, bodyEnd - bodyStart);
      const at = safeInsertIndex(current, bodyStart + Math.floor(random() * (span + 1)));
      const word = pick(WORDS, random);
      text.doc?.transact(() => {
        text.insert(at, ` ${word} ${marker}`);
      });
      return record({ marker, detail: `insert ${marker} at ${at}` });
    }

    case "body-delete": {
      const want = 1 + Math.floor(random() * 8);
      const at = bodyStart + Math.floor(random() * Math.max(1, bodyEnd - bodyStart));
      const span = safeDeleteSpan(current, at, want, bodyStart, bodyEnd);
      if (!span) return record({ applied: false, detail: "no marker-free span to delete" });
      text.doc?.transact(() => {
        text.delete(span.start, span.length);
      });
      return record({ detail: `delete ${span.length} at ${span.start}` });
    }

    case "fm-set": {
      const key = pick(FM_KEYS, random);
      const value = frontmatterValue(key, random, counter);
      const ok = spliceFrontmatterValue(text, key, value);
      return record({ applied: ok, detail: `fm ${key} = ${value}` });
    }

    case "fm-title": {
      const value = `${pick(WORDS, random)} ${counter}`;
      const ok = spliceFrontmatterValue(text, "title", value);
      return record({ applied: ok, detail: `fm title = ${value}` });
    }

    case "section-set": {
      const plugin = pick(SECTION_PLUGINS, random);
      const key = pick(SECTION_KEYS, random);
      const value =
        key === "checked-at"
          ? `2026-0${1 + Math.floor(random() * 9)}-1${Math.floor(random() * 9)}`
          : `${client}-${counter}`;
      spliceSectionLine(text, plugin, key, value);
      return record({ detail: `%%% ${plugin} ${key} = ${value}` });
    }

    case "heading-rewrite": {
      const headingMatch = /^# .*$/m.exec(current.slice(bodyStart, bodyEnd));
      const marker = markerFor(client, counter);
      if (!headingMatch) {
        const at = safeInsertIndex(current, bodyStart);
        text.doc?.transact(() => {
          text.insert(at, `# ${pick(WORDS, random)} ${marker}\n\n`);
        });
        return record({ marker, detail: `new heading at ${at}` });
      }
      const at = bodyStart + headingMatch.index + headingMatch[0].length;
      const safe = safeInsertIndex(current, at);
      text.doc?.transact(() => {
        text.insert(safe, ` ${marker}`);
      });
      return record({ marker, detail: `heading suffix ${marker}` });
    }
  }
}

function frontmatterValue(key: string, random: () => number, counter: number): string {
  switch (key) {
    case "status":
      return pick(STATUSES, random);
    case "path":
      return `${pick(WORDS, random)}/${pick(WORDS, random)}`;
    case "date": {
      // Three shapes on purpose, because materialization canonicalizes dates
      // (SPEC §3.4) and the harness compares the server's `fm` against a *client*
      // parse:
      //   - a canonical date            → unchanged on both sides
      //   - an offset datetime          → canonicalized to UTC by the server, so
      //                                   the client parse must be too
      //   - `2026-9-3`                  → **not** a date to the shared core (it
      //                                   demands zero-padding), so it stays a
      //                                   plain string
      // A divergence in any of the three is a parity bug, and this is where it
      // surfaces instead of in production sorting.
      const roll = random();
      const month = `0${1 + Math.floor(random() * 9)}`;
      const day = `1${Math.floor(random() * 9)}`;
      if (roll < 0.4) return `2026-${month}-${day}`;
      if (roll < 0.7) return `2026-${month}-${day}T07:${day}+02:00`;
      return `2026-${1 + Math.floor(random() * 9)}-${1 + Math.floor(random() * 9)}`;
    }
    case "priority":
      return String(counter % 5);
    default:
      return `${pick(WORDS, random)}-${counter}`;
  }
}

// ---------------------------------------------------------------------------
// Seed documents
// ---------------------------------------------------------------------------

/** A realistic seed document: frontmatter, body with tasks, one `%%%` section. */
export function seedDocumentText(index: number, random: () => number = () => 0.5): string {
  const title = `${pick(WORDS, random)} ${index}`;
  const folder = `${pick(WORDS, random)}/${pick(WORDS, random)}`;
  const day = 1 + (index % 28);
  return [
    "---",
    `title: ${title}`,
    `path: ${folder}`,
    `date: 2026-09-${String(day).padStart(2, "0")}`,
    `status: ${STATUSES[index % STATUSES.length]}`,
    "tags: [harness, seed]",
    `priority: ${index % 5}`,
    "---",
    "",
    `# ${title}`,
    "",
    `Seeded document ${index} for the M2 gate. It carries all three regions of`,
    "SPEC §3.1 so materialization has something real to derive.",
    "",
    "- [ ] first task",
    "- [x] second task",
    "- [ ] third task",
    "",
    "%%% calendar",
    `source-uid: seed-${index}@harness`,
    "revision: 1",
    "%%%",
    "",
  ].join("\n");
}

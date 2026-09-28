/**
 * Task markers: the registry, the parser, and the toggle rule (SPEC §6.6).
 *
 * > `markdown.taskState` (marker → `{icon, label, menu order, done?}`) … Built-in task
 * > states (`[ ]`, `[x]`) are default `taskState` contributions.
 * > Accepted & documented: marker semantics come from the client registry, so a client
 * > without a plugin sees its markers as literal text.
 *
 * **Why the parser reads the source instead of trusting mdast.** `remark-gfm` recognises
 * exactly three checkboxes — `[ ]`, `[x]`, `[X]` — sets `listItem.checked` and *removes*
 * the marker from the paragraph. Everything else (`[/]`, `[-]`, `[?]`) stays literal text
 * in the paragraph with `checked: null`. Neither half is what SPEC §6.6 asks for: the
 * parser must accept **any registered marker**, and an **unregistered** one must render
 * literally — including `[X]`, which GFM happily eats even though nothing registers it.
 *
 * So the marker is located in the source by offset, from the list item's own start, and
 * the registry decides what it means:
 *
 * | marker | registered | GFM ate it | rendered as |
 * |---|---|---|---|
 * | `[ ]` | yes (built-in) | yes | checkbox |
 * | `[x]` | yes (built-in) | yes | checkbox |
 * | `[X]` | no | yes | literal `[X]`, re-inserted |
 * | `[/]` | only with a plugin | no | checkbox, marker stripped from the text |
 * | `[/]` | no | no | literal `[/]`, already in the text |
 *
 * The offset that comes out of this is what a click splices into (SPEC §3.3: minimal
 * text splices, never a re-serialize), which is the other reason mdast is not enough —
 * GFM's node has no record of where the marker was.
 */

import type { MarkdownTaskState } from "@protocols/lm/markdown.taskState";

import { spanOf, walk, type MdNode } from "./mdast.js";

/** GFM requires a space or tab after the checkbox; so does this parser, deliberately. */
const AFTER_MARKER = new Set([" ", "\t"]);
/** An ordered list bullet: `1.` / `1)`, up to nine digits (CommonMark's cap). */
const ORDERED_BULLET = /^\d{1,9}[.)]/;

export interface TaskRegistry {
  /** Every registered state in **menu order** — what the right-click menu lists. */
  readonly states: readonly MarkdownTaskState[];
  readonly byMarker: ReadonlyMap<string, MarkdownTaskState>;
  /** The "off" state a left-click falls back to. */
  readonly off: MarkdownTaskState | undefined;
  /** The "on" state a left-click moves to from off. */
  readonly on: MarkdownTaskState | undefined;
}

/**
 * Build the lookup from the `tasks` port's current items, **in seat order** — that is
 * the menu order (PLUGIN-PROTOCOLS §6a: hosts do not sort).
 *
 * `off`/`on` are resolved rather than hard-coded, because `markdown.taskState` is
 * replaceable like everything else (SPEC §6.1) and a workspace that replaced the
 * built-ins must still get a sensible left-click:
 *
 * - **off** — `" "` if it is registered, else the first state in menu order that is not
 *   `done`. That is the state a click on anything else lands on.
 * - **on** — the first `done: true` state in menu order, else the first state that is not
 *   `off`. That is where a click on `off` goes.
 *
 * Both are `undefined` only when the point is empty, in which case nothing renders as a
 * task at all and every marker is literal — which is exactly the documented consequence
 * of registry-driven semantics.
 */
export function buildTaskRegistry(contributions: readonly MarkdownTaskState[]): TaskRegistry {
  const seen = new Map<string, MarkdownTaskState>();
  // The host's own de-duplication: the protocol's key is the marker and the host already
  // enforces first-wins, so this only guards a caller passing a raw array.
  for (const state of contributions) {
    if (!seen.has(state.marker)) seen.set(state.marker, state);
  }
  const states = [...seen.values()];
  const off = seen.get(" ") ?? states.find((state) => state.done !== true);
  const on = states.find((state) => state.done === true) ?? states.find((state) => state !== off);
  return { states, byMarker: seen, off, on };
}

/**
 * The marker a left-click writes, given the current one (SPEC §6.6: "left-click toggles
 * non-off → off, off → on"). `null` when there is nothing to toggle to.
 */
export function toggleMarker(current: string, registry: TaskRegistry): string | null {
  const off = registry.off?.marker;
  if (off === undefined) return null;
  if (current !== off) return off;
  return registry.on?.marker ?? null;
}

/** How much of a task's own line is kept as its identity. */
const LABEL_LENGTH = 48;

/** One task marker located in the parsed text. */
export interface TaskLocation {
  /** The character between the brackets. */
  readonly marker: string;
  /** Offset of that character, relative to the text that was parsed. */
  readonly offset: number;
  /** `true` when `remark-gfm` already removed `[m] ` from the item's first paragraph. */
  readonly consumedByGfm: boolean;
  /** `true` when a `markdown.taskState` contribution claims this marker. */
  readonly registered: boolean;
  /**
   * The start of the task's own line after the checkbox, trimmed and capped.
   *
   * This is the task's *identity* across a re-parse, and it exists because the ordinal
   * alone is not one: insert a task above and every ordinal below it shifts by one, so
   * `locations[ordinal]` can be a different task that happens to carry the same marker.
   * Comparing the text as well turns "probably the same checkbox" into "the same
   * checkbox", which for a blind write into someone's prose is the difference that matters.
   */
  readonly label: string;
}

/**
 * Find the checkbox of one list item by scanning its source from the item's start.
 *
 * Shape accepted, matching CommonMark + GFM: optional indent, one bullet (`-`, `*`, `+`,
 * or `<digits>.`/`<digits>)`), at least one space or tab, `[`, exactly one character,
 * `]`, then a space or tab. That last requirement is GFM's, and keeping it means
 * `- [ ]` on its own line is *not* a task on either path — the alternative is a marker
 * this plugin renders as a checkbox and every other GFM renderer shows as literal text.
 *
 * A multi-character marker is out of scope by construction: `MarkdownTaskState.marker` is
 * documented as "the single character inside the brackets", and `[ab]` is a link
 * reference to markdown, not a checkbox.
 */
export function markerAt(source: string, itemStart: number): { marker: string; offset: number } | null {
  let index = itemStart;
  while (index < source.length && AFTER_MARKER.has(source[index] ?? "")) index += 1;

  const bullet = source[index];
  if (bullet === undefined) return null;
  if (bullet === "-" || bullet === "*" || bullet === "+") {
    index += 1;
  } else {
    const ordered = ORDERED_BULLET.exec(source.slice(index, index + 11));
    if (!ordered) return null;
    index += ordered[0].length;
  }

  let spaces = 0;
  while (index < source.length && AFTER_MARKER.has(source[index] ?? "")) {
    index += 1;
    spaces += 1;
  }
  if (spaces === 0) return null;

  if (source[index] !== "[") return null;
  const marker = source[index + 1];
  if (marker === undefined || marker === "\n" || marker === "\r") return null;
  if (source[index + 2] !== "]") return null;
  if (!AFTER_MARKER.has(source[index + 3] ?? "")) return null;

  return { marker, offset: index + 1 };
}

export interface TaskScan {
  /** Every located marker in document order — the ordinal a click writes against. */
  readonly locations: readonly TaskLocation[];
  /** `listItem` node → its index in {@link locations}. Identity-keyed, one parse only. */
  readonly ordinals: ReadonlyMap<MdNode, number>;
}

/**
 * Locate every task marker in a parsed tree, in document order.
 *
 * One pass, two consumers: the renderer looks items up by identity, and the click path
 * re-runs the scan against the *current* text and looks the same task up by ordinal. That
 * ordinal is the recovery path for the case that matters — the document changed between
 * render and click (someone else typed a line above, CRDT-style), so the offset captured
 * at render time now points at the wrong character. Validating the character and falling
 * back to the ordinal is what keeps a click from corrupting a document.
 */
export function scanTasks(tree: MdNode, source: string, registry: TaskRegistry): TaskScan {
  const locations: TaskLocation[] = [];
  const ordinals = new Map<MdNode, number>();
  walk(tree, (node) => {
    if (node.type !== "listItem") return;
    const span = spanOf(node);
    if (!span) return;
    const found = markerAt(source, span.start);
    if (!found) return;
    ordinals.set(node, locations.length);
    const lineEnd = source.indexOf("\n", found.offset);
    locations.push({
      marker: found.marker,
      offset: found.offset,
      consumedByGfm: node.checked === true || node.checked === false,
      registered: registry.byMarker.has(found.marker),
      label: source
        .slice(found.offset + 3, lineEnd === -1 ? source.length : lineEnd)
        .trim()
        .slice(0, LABEL_LENGTH),
    });
  });
  return { locations, ordinals };
}

/**
 * Resolve the absolute offset a click should splice, against the text as it is *now*.
 *
 * **The re-scan is authoritative, not a fallback.** The tempting version of this function
 * trusts the offset captured at render time and only re-scans when the character there
 * looks wrong — and it is subtly, dangerously broken: markdown documents are full of
 * checkboxes, so a stale offset very often still points at `[ ]`, just a *different* one.
 * Insert one line above a two-item list and a click on the second item ticks the first.
 * That was caught by `tasks.test.ts`, not by reasoning, which is why the cheap path is
 * gone rather than merely guarded.
 *
 * So the current text is re-parsed and the task is identified by **ordinal and label**:
 *
 * 1. the same ordinal, if its marker *and* its line text still match ⇒ that offset;
 * 2. otherwise, the single task anywhere in the document with that marker and that label
 *    ⇒ that offset (this is the ordinal-shifted case);
 * 3. otherwise `null`.
 *
 * A `null` is a refusal, not an error: the checkbox the user looked at is no longer
 * identifiable, and a splice is a blind write — getting it wrong does not throw, it edits
 * the wrong character of someone's sentence.
 *
 * Known limit, honestly: two tasks with the same marker *and* the same text are
 * indistinguishable, so a shifted ordinal between them may resolve to the other one. The
 * write still lands on a checkbox reading the same thing in the same state, so the user
 * cannot tell — but it is not the line they pointed at.
 * INTEGRATION (kernel-runtime): the real fix is a sticky anchor — Yjs has
 * `createRelativePositionFromTypeIndex`, which survives concurrent edits by construction.
 * Exposing relative positions on `OpenDocument` (or a `splice.anchor(target, index)`)
 * would let the renderer capture a position instead of an integer and delete this whole
 * identification problem, for every plugin that wants to write at a place a user pointed at.
 */
export function resolveMarkerOffset(
  currentText: string,
  base: number,
  expected: TaskLocation,
  ordinal: number,
  rescan: () => TaskScan,
): number | null {
  const { locations } = rescan();

  const sameOrdinal = locations[ordinal];
  if (sameOrdinal && matches(sameOrdinal, expected)) {
    return validated(currentText, base + sameOrdinal.offset, expected.marker);
  }

  const candidates = locations.filter((location) => matches(location, expected));
  const only = candidates.length === 1 ? candidates[0] : undefined;
  return only ? validated(currentText, base + only.offset, expected.marker) : null;
}

/** Same marker and same line text ⇒ the same task. */
function matches(candidate: TaskLocation, expected: TaskLocation): boolean {
  return candidate.marker === expected.marker && candidate.label === expected.label;
}

/** Last line of defence: the offset really does hold `[<marker>]`. */
function validated(text: string, offset: number, marker: string): number | null {
  return holdsMarker(text, offset, marker) ? offset : null;
}

/** `text[offset]` is `marker` and it sits inside brackets. */
function holdsMarker(text: string, offset: number, marker: string): boolean {
  return text[offset - 1] === "[" && text[offset] === marker && text[offset + 1] === "]";
}

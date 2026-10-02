import type { MarkdownTaskState } from "./api.js";

import { spanOf, walk, type MdNode } from "./mdast.js";

const AFTER_MARKER = new Set([" ", "\t"]);
const ORDERED_BULLET = /^\d{1,9}[.)]/;

export interface TaskRegistry {
  readonly states: readonly MarkdownTaskState[];
  readonly byMarker: ReadonlyMap<string, MarkdownTaskState>;
  readonly off: MarkdownTaskState | undefined;
  readonly on: MarkdownTaskState | undefined;
}

export function buildTaskRegistry(contributions: readonly MarkdownTaskState[]): TaskRegistry {
  const seen = new Map<string, MarkdownTaskState>();
  for (const state of contributions) {
    if (!seen.has(state.marker)) seen.set(state.marker, state);
  }
  const states = [...seen.values()];
  const off = seen.get(" ") ?? states.find((state) => state.done !== true);
  const on = states.find((state) => state.done === true) ?? states.find((state) => state !== off);
  return { states, byMarker: seen, off, on };
}

export function toggleMarker(current: string, registry: TaskRegistry): string | null {
  const off = registry.off?.marker;
  if (off === undefined) return null;
  if (current !== off) return off;
  return registry.on?.marker ?? null;
}

const LABEL_LENGTH = 48;

export interface TaskLocation {
  readonly marker: string;
  readonly offset: number;
  readonly consumedByGfm: boolean;
  readonly registered: boolean;
  readonly label: string;
}

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
  readonly locations: readonly TaskLocation[];
  readonly ordinals: ReadonlyMap<MdNode, number>;
}

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

function matches(candidate: TaskLocation, expected: TaskLocation): boolean {
  return candidate.marker === expected.marker && candidate.label === expected.label;
}

function validated(text: string, offset: number, marker: string): number | null {
  return holdsMarker(text, offset, marker) ? offset : null;
}

function holdsMarker(text: string, offset: number, marker: string): boolean {
  return text[offset - 1] === "[" && text[offset] === marker && text[offset + 1] === "]";
}

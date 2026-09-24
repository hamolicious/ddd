/**
 * Task scanning: the pure half of `agenda`, and the part worth testing.
 *
 * # Why a line scanner and not an mdast walk
 *
 * The agenda reads the **projection** — `content` as replicated text, for every document in
 * the workspace, offline included (SPEC §4.1). A glance at 5 000 documents must not build
 * 5 000 unified ASTs, and it does not have to: a task list item is a *line* shape, and the
 * only thing that decides whether a marker means something is the registry
 * (`markdown.taskState`), which this file takes as an argument.
 *
 * The line grammar is GFM's, matched deliberately character for character against
 * `markdown`'s own parser (`plugins/base/markdown/src/tasks.ts`, `markerAt`): optional
 * indent, one bullet (`-`, `*`, `+`, or `<digits>.` / `<digits>)`), at least one space or
 * tab, `[`, exactly one character, `]`, then a space or tab. That last requirement is GFM's
 * and keeping it matters — `- [ ]` alone on a line is not a task for the renderer, so it
 * must not be one here either, or the count in the sidebar disagrees with the checkboxes on
 * screen.
 *
 * INTEGRATION (base-markdown): the duplication above is the honest cost of "no direct
 * imports between plugins" (SPEC §6.1), and it is one function wide. If `markdown`'s service
 * grew a `scanTasks(text)` returning located markers, `agenda` would consume the same parser
 * the renderer uses and this file would shrink to grouping. Worth doing the next time either
 * side of the grammar moves, because a divergence here shows up as a count that is wrong by
 * one and nothing else.
 *
 * # Unregistered markers are not tasks
 *
 * SPEC §6.6, stated as a known consequence (SPEC §11.7): marker semantics come from the
 * *client* registry, so a marker no plugin registered renders as **literal text**. The
 * agenda therefore does not count it. {@link scanTasks} still reports it with
 * `registered: false`, and {@link groupTasks} keeps that list on the document it came from —
 * "this document also has two markers this client does not understand" is the one sentence
 * that makes a count differing from another client's explainable rather than a bug.
 */

/**
 * A `markdown.taskState` contribution, structurally.
 *
 * Declared locally rather than imported from `_shared/points.ts` so this file stays free of
 * React: `MarkdownTaskState.icon` is a `ReactNode`, and the scanner has no business knowing
 * what one is. The registry arrives through `markdown`'s service at runtime and the shape is
 * a subset, so the real contributions satisfy it.
 */
export interface TaskStateLike {
  readonly marker: string;
  readonly label: string;
  /** `true` ⇒ counts as completed (SPEC §6.6). */
  readonly done?: boolean;
  readonly order?: number;
}

/** A half-open offset range — UTF-16 code units, the same units `Y.Text` indexes in. */
export interface Region {
  readonly start: number;
  readonly end: number;
}

/** One task marker found in a document's text. */
export interface ScannedTask {
  /** The single character between the brackets; `" "` for unchecked. */
  readonly marker: string;
  /** Offset of that character in the **whole document text**, not the region. */
  readonly offset: number;
  /** 1-based line number in the whole document text — what a "jump to line" needs. */
  readonly line: number;
  /** Leading whitespace before the bullet, in characters: a sub-task is indented. */
  readonly indent: number;
  /** The task's own text after the checkbox, trimmed. Empty for a bare checkbox. */
  readonly text: string;
  /** `true` when a `markdown.taskState` contribution claims this marker. */
  readonly registered: boolean;
  /** The registry's `done` for this marker; `false` when unregistered. */
  readonly done: boolean;
  /** The state's label, for the icon and the tooltip. `undefined` when unregistered. */
  readonly label?: string;
}

/** GFM requires a space or tab after the checkbox; so does this scanner, deliberately. */
const AFTER_MARKER = new Set([" ", "\t"]);
/** An ordered list bullet: `1.` / `1)`, up to nine digits (CommonMark's cap). */
const ORDERED_BULLET = /^\d{1,9}[.)]/;
/** How much of a task's line is kept. Long enough to identify, short enough to render. */
export const TASK_TEXT_LIMIT = 160;

/**
 * Every task marker in `text`, in document order.
 *
 * `region` bounds the scan — pass `markdown.regions(text).body` so the frontmatter block and
 * the trailing `%%%` machine sections are skipped (SPEC §3.1). A `%%% ` section is YAML a
 * plugin owns; a line in it that happens to look like a checkbox is not a user's task, and
 * the renderer would not draw one either. Offsets and line numbers stay relative to the
 * **whole** text so a caller can splice or jump without adding a base back.
 */
export function scanTasks(
  text: string,
  states: readonly TaskStateLike[],
  region?: Region,
): readonly ScannedTask[] {
  const byMarker = new Map<string, TaskStateLike>();
  for (const state of states) if (!byMarker.has(state.marker)) byMarker.set(state.marker, state);

  const start = Math.max(0, region?.start ?? 0);
  const end = Math.min(text.length, region?.end ?? text.length);

  const found: ScannedTask[] = [];
  // Line numbers are of the whole document, so the lines before the region still count.
  let line = 1;
  for (let index = 0; index < start; index += 1) if (text[index] === "\n") line += 1;

  let cursor = start;
  while (cursor < end) {
    const newline = text.indexOf("\n", cursor);
    const lineEnd = newline === -1 || newline > end ? end : newline;
    const task = taskOnLine(text, cursor, lineEnd, line, byMarker);
    if (task) found.push(task);
    cursor = lineEnd + 1;
    line += 1;
  }
  return found;
}

/** The GFM task-item shape, matched from the start of one line. `null` when it is prose. */
function taskOnLine(
  text: string,
  lineStart: number,
  lineEnd: number,
  line: number,
  byMarker: ReadonlyMap<string, TaskStateLike>,
): ScannedTask | null {
  let index = lineStart;
  while (index < lineEnd && AFTER_MARKER.has(text[index] ?? "")) index += 1;
  const indent = index - lineStart;

  const bullet = text[index];
  if (bullet === undefined) return null;
  if (bullet === "-" || bullet === "*" || bullet === "+") {
    index += 1;
  } else {
    const ordered = ORDERED_BULLET.exec(text.slice(index, Math.min(index + 11, lineEnd)));
    if (!ordered) return null;
    index += ordered[0].length;
  }

  let spaces = 0;
  while (index < lineEnd && AFTER_MARKER.has(text[index] ?? "")) {
    index += 1;
    spaces += 1;
  }
  if (spaces === 0) return null;

  if (text[index] !== "[") return null;
  const marker = text[index + 1];
  if (marker === undefined || marker === "\n" || marker === "\r") return null;
  if (text[index + 2] !== "]") return null;
  // The checkbox must be followed by a space or a tab *on this line*.
  if (index + 3 >= lineEnd || !AFTER_MARKER.has(text[index + 3] ?? "")) return null;

  const state = byMarker.get(marker);
  return {
    marker,
    offset: index + 1,
    line,
    indent,
    // `\r` is stripped: a CRLF document's last character is not part of the task's text.
    text: text.slice(index + 4, lineEnd).replace(/\r$/, "").trim().slice(0, TASK_TEXT_LIMIT),
    registered: state !== undefined,
    done: state?.done === true,
    label: state?.label,
  };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * The projection row shape the grouping needs.
 *
 * A structural subset of `DocumentRow` (`@kernel`), so the tests can build one in three
 * lines instead of thirteen and the function keeps working when the row grows a field.
 */
export interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly content?: string;
  readonly fm: Readonly<Record<string, unknown>>;
}

/** One document's tasks, as the dashboard lists them. */
export interface DocumentTasks {
  readonly id: string;
  readonly title: string;
  /** Normalized `fm.path`, `""` when the document is not in a folder. */
  readonly folder: string;
  /** Registered, not-done tasks, in document order. */
  readonly open: readonly ScannedTask[];
  readonly doneCount: number;
  /** Registered tasks, done included. */
  readonly total: number;
  /** Markers nothing registered — reported, never counted (SPEC §6.6). */
  readonly unrecognized: readonly ScannedTask[];
}

/** One folder's documents. The dashboard's top level. */
export interface FolderTasks {
  readonly folder: string;
  /** `"/"`-joined path, or `"Not in a folder"`. */
  readonly label: string;
  readonly documents: readonly DocumentTasks[];
  readonly openCount: number;
  readonly doneCount: number;
}

export interface GroupOptions {
  /** Include documents whose registered tasks are all done. Default `false`. */
  readonly includeCompleted?: boolean;
  /** The body region of one document's text, if the caller can compute it. */
  readonly regionOf?: (text: string) => Region | undefined;
}

/**
 * Scan every row and group it by folder, then by document.
 *
 * Ordering is deterministic and not by relevance: folders alphabetically with the unfiled
 * bucket last, documents by title inside each. An agenda that reorders itself as tasks are
 * ticked is one a user loses their place in.
 */
export function groupTasks(
  rows: readonly TaskRow[],
  states: readonly TaskStateLike[],
  options: GroupOptions = {},
): readonly FolderTasks[] {
  const byFolder = new Map<string, DocumentTasks[]>();

  for (const row of rows) {
    const text = row.content ?? "";
    if (text === "") continue;
    const scanned = scanTasks(text, states, options.regionOf?.(text));
    const registered = scanned.filter((task) => task.registered);
    // A document whose only markers are unregistered has no tasks *on this client*: the
    // renderer shows them as literal text, so an agenda entry would promise a checkbox
    // that is not there.
    if (registered.length === 0) continue;

    const open = registered.filter((task) => !task.done);
    if (open.length === 0 && options.includeCompleted !== true) continue;

    const folder = normalizeFolder(row.fm["path"]);
    const entry: DocumentTasks = {
      id: row.id,
      title: row.title,
      folder,
      open,
      doneCount: registered.length - open.length,
      total: registered.length,
      unrecognized: scanned.filter((task) => !task.registered),
    };
    const bucket = byFolder.get(folder);
    if (bucket) bucket.push(entry);
    else byFolder.set(folder, [entry]);
  }

  return [...byFolder.entries()]
    .map(([folder, documents]) => ({
      folder,
      label: folder === "" ? "Not in a folder" : folder,
      documents: [...documents].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)),
      openCount: documents.reduce((sum, entry) => sum + entry.open.length, 0),
      doneCount: documents.reduce((sum, entry) => sum + entry.doneCount, 0),
    }))
    .sort((a, b) => {
      // Unfiled last: it is the bucket a user is least likely to be looking for.
      if (a.folder === "") return b.folder === "" ? 0 : 1;
      if (b.folder === "") return -1;
      return a.folder.localeCompare(b.folder);
    });
}

/**
 * `fm.path` as `folders` normalizes it (SPEC §6.5): `/`-separated segments with `.`, `..`
 * and empty segments stripped, case preserved. Anything that is not a string is no folder.
 */
export function normalizeFolder(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..")
    .join("/");
}

/** Totals across every folder — the navbar badge and the empty-state sentence. */
export function countTasks(groups: readonly FolderTasks[]): {
  readonly open: number;
  readonly done: number;
  readonly documents: number;
} {
  return groups.reduce(
    (totals, group) => ({
      open: totals.open + group.openCount,
      done: totals.done + group.doneCount,
      documents: totals.documents + group.documents.length,
    }),
    { open: 0, done: 0, documents: 0 },
  );
}

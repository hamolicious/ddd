/**
 * `folders` — a real file tree over `fm.path` (SPEC §6.5).
 *
 * There are no folder objects. A "folder" is a prefix of the `fm.path` values that exist
 * in the projection, derived on the fly — which is why moving a document is a
 * *frontmatter splice* and nothing else, why renaming a folder is a splice per document
 * inside it, and why there is no rename transaction, no folder table, and nothing to
 * migrate. **Every write in this plugin is one `kernel.documents.splice` call** (SPEC
 * §3.3). If a folder move is interrupted, half the documents moved: recoverable, visible,
 * and vastly preferable to a second source of truth about where a document lives. The
 * tree's "Try again" re-plans against the live projection, so the retry writes only what
 * is still in the old place.
 *
 * Path normalization is fixed by SPEC §6.5 and implemented exactly, in `path.ts`, with a
 * test per clause: `/` segments, `.`/`..`/empty segments **stripped** (not resolved),
 * **case-sensitive**, duplicate names allowed (documents are id-addressed, so two
 * `home/lists` differing in case are two folders and that is intended).
 *
 * ## The one thing that is not derived
 *
 * A folder nobody has filed anything into has nowhere to live — that is what "there are
 * no folder objects" costs. So "New folder" writes the path into **this plugin's
 * per-user settings** (`kernel.settings`, SPEC §6.4) and stops counting it the moment a
 * document lands inside: from then on `fm.path` is the truth, and a second record of the
 * same fact could only ever disagree with it. `empty-folders.ts` is that bookkeeping, and
 * every function in it exists to make the list shrink.
 *
 * The stored line catches up at the **next write** rather than the instant the document
 * moves, because "the instant the document moves" is a subscription callback that fires
 * on every client at once — see `pruneEmptyFolders` for what that cost when it did write
 * there. Nothing visible depends on the difference: the tree merges tracked folders with
 * the folders `fm.path` implies, so a stale entry is a folder that now exists anyway.
 *
 * ## Per-user state, all of it in settings
 *
 * | Key | What it is |
 * |---|---|
 * | `defaultLocation` | Where "New document" files a note. Rendered as a picker in Settings. |
 * | `emptyFolders` | Folders created but not yet used. Dropped as soon as a document lands. |
 * | `collapsedFolders` | The folders this user closed. The negative is stored so an untouched tree is open. |
 * | `folderOrder` | The user's own order for folders, set by dragging (`order.ts`). Unlisted folders sort by name. |
 *
 * Settings are per user and, as SPEC §6.4 states plainly, readable by other users of the
 * shared workspace. Folder names are not secrets and nothing else is kept here.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { CoreValue, DocumentRow, Kernel, SettingsValue, Unsubscribe } from "@kernel";

import type { ContextMenuApi } from "../../_shared/context-menu-api.js";
import {
  EXCLUDE_MACHINE_DOCUMENTS,
  isMachineDocument,
  isMachinePath,
} from "../../_shared/machine-docs.js";

import { DefaultLocation } from "./DefaultLocation.js";
import { renameInOrder } from "./order.js";
import {
  EMPTY_FOLDERS_KEY,
  mergeTracked,
  pruneTracked,
  readTracked,
  renameTracked,
  sameTracked,
  withFolder,
  withoutFolder,
} from "./empty-folders.js";
import { FolderContents } from "./FolderContents.js";
import { FolderTree, type TreeRequest } from "./FolderTree.js";
import { documentsUnder, planFolderMove } from "./moves.js";
import { buildTree, isRecursiveRename, normalizePath, parentOf, type PathRow } from "./path.js";
import { settledMoves, withPendingPaths } from "./pending.js";
import {
  POINTS,
  type Command,
  type MainView,
  type Route,
  type SettingsSection,
  type SidebarPanel,
} from "../../_shared/points.js";

/** A workspace bigger than this needs paging in the tree; say so rather than truncate quietly. */
const TREE_ROW_LIMIT = 20_000;

/**
 * How many documents a folder move splices at once.
 *
 * Small on purpose: every splice hydrates a document and waits for a sync round trip, so
 * serial is slow (hundreds of sequential round trips for one rename) while unbounded is
 * worse — the in-memory replica LRU holds ~20 documents and the persisted set 50 (SPEC
 * §4.1), so a wide fan-out evicts the user's editable working set to move metadata.
 */
const MOVE_CONCURRENCY = 6;

/**
 * How long a move is drawn ahead of the projection. The echo normally takes about a
 * second (the server's 500 ms materialization debounce plus the feed); offline, the
 * kernel's own local row lands within a quarter of that.
 */
const PENDING_MOVE_TTL_MS = 15_000;

/** Collapsing a folder is a settings splice; a burst of clicks should not be a burst of them. */
const SETTINGS_DEBOUNCE_MS = 400;

/** The event other plugins can listen to without depending on this one (see below). */
export const DEFAULT_LOCATION_EVENT = "folders:default-location";

export const SETTINGS_KEYS = {
  defaultLocation: "defaultLocation",
  emptyFolders: EMPTY_FOLDERS_KEY,
  collapsedFolders: "collapsedFolders",
  folderOrder: "folderOrder",
} as const;

export interface MoveOptions {
  /** Called after each document, including the ones that failed. */
  readonly onProgress?: (done: number, total: number) => void;
}

export interface FoldersApi {
  /** Normalize a raw `fm.path` value the way the tree does. */
  normalize(path: string): string;
  /** Every folder path in the workspace, sorted, with document counts. */
  tree(): Promise<readonly { readonly path: string; readonly documents: number }[]>;
  /** Move one document: a single `fm.path` splice (SPEC §3.3). */
  move(documentId: string, path: string): Promise<void>;
  /**
   * Move every document under `from` to `to` — a rename, a re-parent and a "move the
   * contents out" are all this one operation. One splice per document, run through a
   * small pool; `onProgress` fires after each one so a caller can show how far it got.
   */
  renameFolder(from: string, to: string, options?: MoveOptions): Promise<number>;
  /** Remember an empty folder until a document lands in it. */
  createFolder(path: string): Promise<void>;
  /** `parent` moves the contents up a level; `trash` tombstones them (SPEC §3.5). */
  deleteFolder(path: string, mode: "parent" | "trash", options?: MoveOptions): Promise<number>;
  /** The folder currently shown, or `undefined` when another view is. */
  current(): string | undefined;
  /**
   * Where a new document should be filed when the caller has no folder of its own —
   * the "New notes go to" setting, `""` for root.
   */
  defaultLocation(): string;
  setDefaultLocation(path: string): Promise<void>;
  /** Fires when {@link defaultLocation} changes, here or on another device. */
  onDefaultLocationChange(listener: (path: string) => void): Unsubscribe;
}

interface DocListService {
  createDocument(options?: { readonly path?: string; readonly title?: string }): Promise<string>;
  /** Creates and reports its own failures (offline, above all). */
  newDocument(options?: { readonly path?: string; readonly title?: string }): void;
}

interface RouterService {
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  onChange(listener: (path: string) => void): () => void;
  current(): string;
}

/** `#/folder?path=home/lists` — a query string, because `:name` matches one segment. */
const folderPath = (folder: string): string => {
  const path = normalizePath(folder);
  return path === "" ? "/folder?path=" : `/folder?path=${encodeURIComponent(path)}`;
};

const folderFromHash = (hash: string): string => {
  const route = hash.replace(/^#/, "");
  const index = route.indexOf("?");
  if (index === -1) return "";
  return normalizePath(new URLSearchParams(route.slice(index + 1)).get("path") ?? "");
};

/** `#/doc/<id>` → the id, for the commands that act on the document on screen. */
const documentFromRoute = (route: string): string | undefined => {
  const [path] = route.split("?");
  const match = /^\/doc\/([^/]+)$/.exec(path ?? "");
  return match?.[1];
};

export default function activate(kernel: Kernel): FoldersApi {
  const docs = kernel.services.require<DocListService>("doc-list");
  const router = kernel.services.require<RouterService>("router");
  const menu = kernel.services.require<ContextMenuApi>("context-menu");

  kernel.settings.defineSchema({
    [SETTINGS_KEYS.defaultLocation]: {
      type: "string",
      label: "New notes go to",
      description: "The folder a new document is filed in. Empty means the root.",
      default: "",
    },
    // Bookkeeping, not preferences: both are rendered by the tree rather than by a
    // settings row, and they are declared here for their defaults (the runtime lays
    // declared defaults under the stored values) and so a reader of the settings
    // document knows what wrote these lines.
    [SETTINGS_KEYS.emptyFolders]: { type: "list", default: [] },
    [SETTINGS_KEYS.collapsedFolders]: { type: "list", default: [] },
    [SETTINGS_KEYS.folderOrder]: { type: "list", default: [] },
  });

  // ---------------------------------------------------------------------------
  // Live state: one subscription, shared by the tree, the settings section and the API
  // ---------------------------------------------------------------------------

  const listeners = new Set<() => void>();
  /** What the projection says — `rows` is this with the moves in flight applied. */
  let projected: readonly PathRow[] = [];
  let rows: readonly PathRow[] = [];
  /** Moves written and not yet echoed by the projection (`pending.ts`). */
  const pendingPaths = new Map<string, string>();
  const derive = (): void => {
    for (const id of settledMoves(projected, pendingPaths)) pendingPaths.delete(id);
    rows = withPendingPaths(projected, pendingPaths);
  };
  let loading = true;
  let loadError: string | undefined;
  let emptyFolders = readTracked(kernel.settings.get(SETTINGS_KEYS.emptyFolders));
  let collapsed: ReadonlySet<string> = new Set(
    readTracked(kernel.settings.get(SETTINGS_KEYS.collapsedFolders)),
  );
  let folderOrder = readTracked(kernel.settings.get(SETTINGS_KEYS.folderOrder));
  /** A local order write in flight; adopting the stored value meanwhile would undo it. */
  let orderWriting = 0;

  const publish = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const readDefaultLocation = (): string =>
    normalizePath(kernel.settings.get<string>(SETTINGS_KEYS.defaultLocation) ?? "");
  let announced = readDefaultLocation();
  const defaultLocationListeners = new Set<(path: string) => void>();

  /**
   * Tell everyone where new notes go.
   *
   * **INTEGRATION (`doc-list`).** `doc-list` creates documents from four places and is a
   * *dependency* of this plugin, so it cannot call `kernel.services.get("folders")` —
   * that would be a cycle, and the registry refuses an undeclared id anyway. The event
   * bus is the way round it with no dependency in either direction: this fires once at
   * activation (after `doc-list` has already activated and subscribed) and again on every
   * change, here or on another device. The consumer is six lines:
   *
   * ```ts
   * let defaultPath = "";
   * kernel.events.on<{ path: string }>("folders:default-location", (event) => {
   *   defaultPath = event.payload.path;
   * });
   * // in createDocument, when the caller named no path of its own:
   * const path = options?.path ?? defaultPath;
   * ```
   *
   * "New document here" in the tree still passes its own folder, which wins — an explicit
   * location always beats a default.
   */
  const announceDefaultLocation = (): void => {
    const path = readDefaultLocation();
    announced = path;
    kernel.events.emit(DEFAULT_LOCATION_EVENT, { path });
    for (const listener of [...defaultLocationListeners]) listener(path);
  };

  /**
   * A tracked folder a document has moved into is not "empty" any more — so it stops
   * being one *here*, and the stored list catches up at the next write.
   *
   * **Nothing is written from this path, deliberately, and it is not laziness.** This
   * runs from inside a `documents.subscribe` callback, which fires on every change to
   * every document in the workspace — on **every connected client at once**. A write
   * here would mean N clients splicing the same settings line in response to one drop,
   * for a value that changes nothing anyone can see: the tree merges tracked folders
   * with the folders `fm.path` implies, so a stale entry is invisible the moment its
   * folder exists on its own. Consolidating at the next real write is the same rule the
   * kernel's own settings host uses for duplicate keys, and the list still only shrinks.
   *
   * There is a second, sharper reason not to write from here, found the hard way: the
   * write is itself a document splice, so it re-enters the query engine that is
   * mid-notification. In that state the splice **resolved and then vanished** — the
   * settings document on the server never got it, and every later settings write in the
   * session was lost with it. That is a kernel-level fault (see the summary for the
   * repro); this path is also the only place in the base distribution that provoked it.
   */
  const pruneEmptyFolders = (): void => {
    const pruned = pruneTracked(emptyFolders, rows);
    if (sameTracked(emptyFolders, pruned)) return;
    emptyFolders = pruned;
  };

  /**
   * Every settings write this plugin makes, one at a time.
   *
   * `kernel.settings.set` is a line splice into a document that has to be found (or
   * created) first, and this plugin writes three keys from four places — a drop can
   * land at the same moment the user is changing a preference. Queueing is cheap (a
   * settings write is on no hot path) and it means this plugin can never be the cause
   * of two writes racing for the same section.
   */
  let settingsWrites: Promise<unknown> = Promise.resolve();
  const writeSetting = (key: string, value: SettingsValue): Promise<void> => {
    const write = settingsWrites.then(
      () => kernel.settings.set(key, value),
      () => kernel.settings.set(key, value),
    );
    settingsWrites = write.catch(() => undefined);
    return write;
  };

  /**
   * Empty-folder entries this device has written and not yet read back.
   *
   * The whole list is one settings key, so two devices creating a folder at the same
   * moment write `emptyFolders:` concurrently and the host keeps one line (SPEC §3.3,
   * last occurrence wins) — silently dropping the folder made on the losing device.
   * An entry stays in this set from the write that added it until a *stored* value
   * contains it; while it is in the set, a stored list that lacks it is a lost race and
   * is merged rather than adopted (`mergeTracked`). After it has round-tripped once the
   * entry is the shared list's to remove, which is what keeps a deliberate delete on
   * another device deleted instead of resurrecting it.
   */
  const unconfirmed = new Set<string>();

  /** Store the empty-folder list, pruned — this is the "next write" that consolidates. */
  const writeTracked = async (next: readonly string[]): Promise<void> => {
    const pruned = pruneTracked(next, rows);
    const stored = readTracked(kernel.settings.get(EMPTY_FOLDERS_KEY));
    for (const entry of pruned) if (!stored.includes(entry)) unconfirmed.add(entry);
    // An entry this write drops (deleted, renamed away, or filled) is no longer ours to
    // defend — otherwise "delete an empty folder" would re-add it on the next merge.
    for (const entry of [...unconfirmed]) if (!pruned.includes(entry)) unconfirmed.delete(entry);
    emptyFolders = pruned;
    try {
      await writeSetting(EMPTY_FOLDERS_KEY, [...pruned] as readonly CoreValue[]);
    } catch (cause) {
      // Losing the note of an empty folder is a cosmetic failure — the folders that hold
      // documents are unaffected — so it is logged rather than raised over the tree.
      kernel.log.warn("could not store the empty-folder list", cause);
    }
  };

  void (async () => {
    try {
      // One live query for the whole tree. `subscribe` re-runs only when a change can
      // alter the result (SPEC §4.2), so this is one subscription, not one per folder.
      //
      // **Machine-owned documents are excluded here rather than in the tree widget**
      // (`_shared/machine-docs.ts`), so every consumer of `rows` inherits it: the
      // counts, the root rows, *and* the rename walk. A folder rename splices `fm.path`
      // on every row it matches, and the kernel's settings documents are machine-owned
      // (SPEC §3.3): a tree that listed `.settings` would offer a rename on it and
      // rewrite frontmatter the kernel authors.
      //
      // **This protects what the tree draws, and nothing else.** Two entry points reach
      // the write path with ids that never came from here — the `folders.moveDocument`
      // command (a URL) and a drop (`text/plain` off a `DataTransfer` any plugin may
      // have filled in) — so the write path carries its own check; see
      // `refuseMachineWrite`. Reading this exclusion as a guarantee about writes is
      // exactly the mistake that moved a settings document out of `.settings`.
      //
      // No toggle here, deliberately. A hidden folder in a tree is a control that looks
      // like every other folder and behaves differently; `doc-list`'s "show machine
      // documents" is where the escape hatch belongs, because a list can hold a mixed set
      // without implying that a dotted folder is yours to reorganise.
      const subscription = await kernel.documents.subscribe({
        filter: EXCLUDE_MACHINE_DOCUMENTS,
        limit: TREE_ROW_LIMIT,
      });
      const take = (result: { rows: readonly DocumentRow[] }): void => {
        projected = result.rows.map((row) => ({ id: row.id, title: row.title, fm: row.fm }));
        derive();
        loading = false;
        pruneEmptyFolders();
        publish();
      };
      take(subscription.result);
      subscription.onChange(take);
    } catch (cause) {
      loading = false;
      loadError = cause instanceof Error ? cause.message : String(cause);
      publish();
    }
  })();

  let collapsedTimer: ReturnType<typeof setTimeout> | undefined;
  const setCollapsed = (next: ReadonlySet<string>): void => {
    collapsed = next;
    publish();
    if (collapsedTimer !== undefined) clearTimeout(collapsedTimer);
    collapsedTimer = setTimeout(() => {
      collapsedTimer = undefined;
      void writeSetting(SETTINGS_KEYS.collapsedFolders, [...collapsed] as readonly CoreValue[]).catch(
        (cause: unknown) => kernel.log.warn("could not store the collapsed folders", cause),
      );
    }, SETTINGS_DEBOUNCE_MS);
  };

  const setFolderOrder = async (next: readonly string[]): Promise<void> => {
    folderOrder = next;
    publish();
    orderWriting += 1;
    try {
      await writeSetting(SETTINGS_KEYS.folderOrder, [...next] as readonly CoreValue[]);
    } finally {
      orderWriting -= 1;
    }
  };

  // Settings change under us: another tab, another device, or our own write coming back
  // through sync. Guarded, because a throw from `activate` skips every dependent
  // (SPEC §6.4) and this is a convenience, not the feature.
  try {
    kernel.settings.subscribe(() => {
      const stored = readTracked(kernel.settings.get(SETTINGS_KEYS.emptyFolders));
      for (const entry of [...unconfirmed]) if (stored.includes(entry)) unconfirmed.delete(entry);
      // A stored list missing something this device wrote is a lost same-key race, not
      // an instruction. Merge it back, show the union immediately, and push it out so
      // the other device converges on the union rather than on its own half.
      //
      // Only when something was actually lost. Re-deriving and re-writing on every
      // settings change would put every connected client into the same splice at once,
      // which is the cost `pruneEmptyFolders` exists to avoid.
      const lost = [...unconfirmed].filter((entry) => !stored.includes(entry));
      const merged = lost.length === 0 ? stored : pruneTracked(mergeTracked(stored, lost), rows);
      emptyFolders = merged;
      if (lost.length > 0 && !sameTracked(stored, merged)) {
        // Never from inside the callback: a settings write is a document splice, and
        // this plugin has already paid once for re-entering a notification (see
        // `pruneEmptyFolders`). One turn of the event loop costs nothing here.
        setTimeout(() => void writeTracked(merged), 0);
      }
      // A pending local write would be clobbered by adopting the remote value mid-flight.
      if (collapsedTimer === undefined) {
        collapsed = new Set(readTracked(kernel.settings.get(SETTINGS_KEYS.collapsedFolders)));
      }
      if (orderWriting === 0) folderOrder = readTracked(kernel.settings.get(SETTINGS_KEYS.folderOrder));
      if (readDefaultLocation() !== announced) announceDefaultLocation();
      publish();
    });
  } catch (cause) {
    kernel.log.warn("settings changes will not be followed", cause);
  }

  const useStore = (): {
    rows: readonly PathRow[];
    loading: boolean;
    error?: string;
    emptyFolders: readonly string[];
    collapsed: ReadonlySet<string>;
    folderOrder: readonly string[];
  } => {
    const [, setRevision] = useState(0);
    useEffect(() => {
      const listener = (): void => setRevision((value) => value + 1);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []);
    return {
      rows,
      loading,
      emptyFolders,
      collapsed,
      folderOrder,
      ...(loadError !== undefined ? { error: loadError } : {}),
    };
  };

  // ---------------------------------------------------------------------------
  // Writes — all of them one splice per document
  // ---------------------------------------------------------------------------

  /**
   * Run `work` over `items` through a bounded pool, reporting progress and collecting
   * failures rather than abandoning the rest at the first one.
   *
   * A move is a set of *independent* splices: one document failing (offline, a conflict,
   * a document deleted under us) says nothing about the next, and the user has to be told
   * how far it got — which is also what makes running it again the whole recovery story.
   */
  const pool = async <T,>(
    items: readonly T[],
    work: (item: T) => Promise<void>,
    options?: MoveOptions,
  ): Promise<{ done: number; failures: readonly string[] }> => {
    let done = 0;
    let succeeded = 0;
    const failures: string[] = [];
    options?.onProgress?.(0, items.length);

    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(MOVE_CONCURRENCY, items.length) },
      async (): Promise<void> => {
        for (;;) {
          const item = items[cursor++];
          if (item === undefined) return;
          try {
            await work(item);
            succeeded += 1;
          } catch (cause) {
            failures.push(cause instanceof Error ? cause.message : String(cause));
          } finally {
            done += 1;
            options?.onProgress?.(done, items.length);
          }
        }
      },
    );
    await Promise.all(workers);
    return { done: succeeded, failures };
  };

  /**
   * **The write-path half of `_shared/machine-docs.ts`, and the only place it holds.**
   *
   * Excluding machine-owned documents from the tree's `rows` protects what the tree
   * *draws*. It does not protect what this plugin *writes*, and those are two different
   * sets: `rows` is the only place the exclusion was applied, while `setPath` is reached
   * from entry points that never consult `rows` at all — the `folders.moveDocument`
   * command takes its id from the URL (`#/doc/<any id>`), and a drop reads
   * `text/plain` off a `DataTransfer` that any draggable row in any plugin may have
   * filled in (`doc-list` marks every row draggable and its filter bar has a "show
   * machine documents" toggle).
   *
   * Handed the kernel's per-user settings document, the old code spliced `fm.path` on
   * it exactly as it would on a note — moving it out of `.settings`, where
   * `settingsFilter()` (`kernel/src/runtime/settings.ts`) is looking for it. Every
   * stored setting for that user then reads as its schema default, with the only
   * recovery being to hand-edit `path` back in edit mode. So the check lives here,
   * where the write is, and it is made against the document's **stored** `fm.path`
   * rather than against tree membership: a document past {@link TREE_ROW_LIMIT} is
   * absent from `rows` and is still perfectly movable.
   *
   * Refusal is a thrown `Error`, which is what every caller already renders — the
   * tree's problem row with a "Try again", or the command's own notice.
   */
  /**
   * The destination half, synchronous so a folder move can refuse before it splices
   * anything. `normalizePath` strips `.` and `..` as *segments* but `.settings` is an
   * ordinary one (see `machine-docs.ts`), so an inline rename typing `.hidden` would
   * otherwise file real notes where three plugins have agreed not to look.
   */
  const refuseMachineFolder = (path: string): void => {
    if (!isMachinePath(path)) return;
    throw new Error(
      `“${path}” is a machine-owned folder. Names starting with “.” belong to plugins, ` +
        `so a document filed there would vanish from the tree, the list and search.`,
    );
  };

  const refuseMachineWrite = async (documentId: string, path: string): Promise<void> => {
    refuseMachineFolder(path);
    const row = await kernel.documents.get(documentId);
    // Only a *positive* answer refuses. A row the projection has never heard of cannot
    // be spliced anyway (the splice opens it and fails), and guessing "machine-owned"
    // from an absent row would block the one case worth allowing.
    if (row !== undefined && isMachineDocument(row)) {
      throw new Error(
        "That document is maintained by the app, not by you, and cannot be moved into a folder.",
      );
    }
  };

  const setPath = async (documentId: string, path: string): Promise<void> => {
    await refuseMachineWrite(documentId, path);
    // Drawn where it is going from now, not a feed round trip from now (`pending.ts`).
    pendingPaths.set(documentId, path);
    rows = withPendingPaths(projected, pendingPaths);
    publish();
    try {
      // The whole feature, in one call: no re-serialization of the frontmatter block.
      if (path === "") await kernel.documents.splice.removeFrontmatterKey(documentId, "path");
      else await kernel.documents.splice.setFrontmatterValue(documentId, "path", path);
      // A move the projection never echoes must not be drawn forever: that would hide
      // exactly the lost write this tree once suffered from. After the grace period
      // the projection is the truth again, whatever it says.
      setTimeout(() => {
        if (pendingPaths.get(documentId) !== path) return;
        pendingPaths.delete(documentId);
        derive();
        publish();
      }, PENDING_MOVE_TTL_MS);
    } catch (cause) {
      // Only if this is still the move on record: a later one owns the entry now.
      if (pendingPaths.get(documentId) === path) pendingPaths.delete(documentId);
      derive();
      publish();
      throw cause;
    }
  };

  const move = async (documentId: string, path: string): Promise<void> => {
    await setPath(documentId, normalizePath(path));
  };

  const failed = (moved: number, failures: readonly string[]): Error =>
    new Error(
      `moved ${moved} document${moved === 1 ? "" : "s"}; ${failures.length} failed: ${failures[0] ?? ""}`,
    );

  const renameFolder = async (
    from: string,
    to: string,
    options?: MoveOptions,
  ): Promise<number> => {
    const source = normalizePath(from);
    const target = normalizePath(to);
    if (source === "") throw new Error("the root cannot be renamed");
    // Before the plan, not per document: a rename into a dotted folder is refused once
    // rather than N times with half the folder already moved.
    refuseMachineFolder(target);
    if (isRecursiveRename(source, target)) {
      throw new Error(`Cannot move “${source}” into itself.`);
    }

    // The documents that actually move, decided before any write, so there is a total to
    // report progress against and a plan to re-compute if this has to be run again.
    const plan = planFolderMove(rows, source, target);
    const { done, failures } = await pool(plan, (entry) => setPath(entry.id, entry.next), options);

    // An empty folder that was only ever a settings line moves the same way — and a
    // folder that held documents may *also* have tracked descendants that hold none.
    const tracked = renameTracked(emptyFolders, source, target);
    if (!sameTracked(emptyFolders, tracked)) {
      emptyFolders = tracked;
      await writeTracked(tracked);
    }
    // Its place in the user's order goes with it.
    const reordered = renameInOrder(folderOrder, source, target);
    if (!sameTracked(folderOrder, reordered)) await setFolderOrder(reordered);

    if (failures.length > 0) throw failed(done, failures);
    return done;
  };

  const createFolder = async (path: string): Promise<void> => {
    const target = normalizePath(path);
    if (target === "") throw new Error("a folder needs a name");
    refuseMachineFolder(target);
    // A folder that already holds documents exists on its own; tracking it would be a
    // second record of the same fact, and `pruneTracked` would drop it again anyway.
    if (documentsUnder(rows, target).length > 0) return;
    const tracked = withFolder(emptyFolders, target);
    if (sameTracked(emptyFolders, tracked)) return;
    emptyFolders = tracked;
    await writeTracked(tracked);
    publish();
  };

  const deleteFolder = async (
    path: string,
    mode: "parent" | "trash",
    options?: MoveOptions,
  ): Promise<number> => {
    const target = normalizePath(path);
    if (target === "") throw new Error("the root cannot be deleted");

    // An empty folder is *only* a settings line, so deleting it is only that line going
    // away — no splices, and nothing to ask the user about. Handled before the two real
    // modes because "move the contents to the parent" would otherwise re-file the entry
    // under the parent rather than removing it: a folder deleted by name would come back
    // one level up, which is exactly the kind of ghost the empty-folder list exists to
    // avoid.
    const contents = documentsUnder(rows, target);
    if (contents.length === 0) {
      await forget(target);
      return 0;
    }

    let moved = 0;
    if (mode === "trash") {
      const ids = contents;
      const { done, failures } = await pool(ids, (id) => kernel.documents.delete(id), options);
      moved = done;
      if (failures.length > 0) {
        await forget(target);
        throw failed(done, failures);
      }
    } else {
      moved = await renameFolder(target, parentOf(target), options);
    }
    await forget(target);
    return moved;
  };

  /** Drop a folder and its descendants from the empty-folder list. */
  const forget = async (path: string): Promise<void> => {
    const tracked = withoutFolder(emptyFolders, path);
    if (sameTracked(emptyFolders, tracked)) return;
    emptyFolders = tracked;
    await writeTracked(tracked);
    publish();
  };

  // ---------------------------------------------------------------------------
  // Requests from outside the panel (commands, keybindings)
  // ---------------------------------------------------------------------------

  const requestListeners = new Set<(request: TreeRequest) => void>();
  const request = (next: TreeRequest): void => {
    if (requestListeners.size === 0) {
      // The panel is the only thing that knows what a folder dialog looks like. If no
      // shell is drawing it, say so rather than failing silently.
      kernel.ui.notify({
        id: "folders.no-panel",
        level: "warning",
        message: "The folder tree is not on screen, so that action has nowhere to happen.",
      });
      return;
    }
    for (const listener of [...requestListeners]) listener(next);
  };

  // ---------------------------------------------------------------------------
  // Contributions
  // ---------------------------------------------------------------------------

  const TreeHost = (): ReactElement => {
    const live = useStore();
    return (
      <FolderTree
        menu={menu}
        rows={live.rows}
        loading={live.loading}
        {...(live.error !== undefined ? { error: live.error } : {})}
        emptyFolders={live.emptyFolders}
        collapsed={live.collapsed}
        onCollapsedChange={setCollapsed}
        order={live.folderOrder}
        onReorder={setFolderOrder}
        requests={(listener) => {
          requestListeners.add(listener);
          return () => {
            requestListeners.delete(listener);
          };
        }}
        onMoveDocument={move}
        onMoveFolder={renameFolder}
        onCreateFolder={createFolder}
        onDeleteFolder={deleteFolder}
        onNewDocumentHere={(folder) => docs.newDocument({ path: folder })}
        onSelectFolder={(folder) => router.navigate(folderPath(folder))}
        onOpenDocument={(id) => router.navigate(`/doc/${id}`)}
      />
    );
  };

  const ContentsHost = (): ReactElement => {
    const [folder, setFolder] = useState(() => folderFromHash(location.hash));
    useEffect(() => router.onChange(() => setFolder(folderFromHash(location.hash))), []);
    return (
      <FolderContents
        documents={kernel.documents}
        folder={folder}
        onOpen={(id) => router.navigate(`/doc/${id}`)}
        onNewDocumentHere={(target) => docs.newDocument({ path: target })}
      />
    );
  };

  const SettingsHost = (): ReactElement => {
    const live = useStore();
    return (
      <DefaultLocation
        folders={buildTree(live.rows).flat.map((node) => node.path)}
        extraFolders={live.emptyFolders}
        value={readDefaultLocation()}
        onChange={(next) => api.setDefaultLocation(next)}
      />
    );
  };

  kernel.extensions.contribute<SidebarPanel>(POINTS.sidebarPanel, {
    id: "folders.tree",
    title: "Folders",
    order: 20,
    defaultOpen: true,
    component: TreeHost,
  });

  kernel.extensions.contribute<Route>(POINTS.route, { path: "/folder", view: "folders.contents" });
  kernel.extensions.contribute<MainView>(POINTS.mainView, {
    id: "folders.contents",
    title: "Folder",
    component: ContentsHost,
  });

  kernel.extensions.contribute<SettingsSection>(POINTS.settingsSection, {
    id: "folders",
    title: "Folders",
    order: 30,
    description: "Where a new document is filed when nothing else says.",
    component: SettingsHost,
  });

  for (const command of [
    {
      id: "folders.newFolder",
      title: "New folder",
      category: "Folders",
      run: () => request({ kind: "create-folder", parent: api.current() ?? "" }),
    },
    {
      id: "folders.newDocumentHere",
      title: "New document in this folder",
      category: "Folders",
      run: () => docs.newDocument({ path: api.current() ?? readDefaultLocation() }),
    },
    {
      id: "folders.renameFolder",
      title: "Rename this folder",
      category: "Folders",
      when: () => (api.current() ?? "") !== "",
      run: () => request({ kind: "rename-folder", path: api.current() ?? "" }),
    },
    {
      id: "folders.moveFolder",
      title: "Move this folder",
      category: "Folders",
      when: () => (api.current() ?? "") !== "",
      run: () =>
        request({ kind: "move", target: { kind: "folder", path: api.current() ?? "" } }),
    },
    {
      id: "folders.deleteFolder",
      title: "Delete this folder",
      category: "Folders",
      when: () => (api.current() ?? "") !== "",
      run: () => request({ kind: "delete-folder", path: api.current() ?? "" }),
    },
    {
      /*
       * The keyboard-and-touch answer to "a document can only be moved by dragging"
       * (`POLISH-BACKLOG.md` §3). It reads the document id out of the route rather than
       * asking `document-surface` for it: `folders` does not depend on the document
       * surface and has no business knowing that modes exist — a URL is a URL.
       */
      id: "folders.moveDocument",
      title: "Move this document to a folder",
      category: "Folders",
      when: () => documentFromRoute(router.current()) !== undefined,
      run: () => {
        const id = documentFromRoute(router.current());
        if (id === undefined) return;
        /*
         * The route says "a document", not "a document of yours". `#/doc/<id>` reaches
         * the kernel's own per-user settings document as readily as a note, and a move
         * sheet opened over one would offer a splice that `setPath` now refuses — so it
         * is refused *here* instead, where there is still something to say about it.
         * `documents.get` rather than `rows`, for the reason given at `refuseMachineWrite`.
         */
        void (async () => {
          const stored = await kernel.documents.get(id);
          if (stored !== undefined && isMachineDocument(stored)) {
            kernel.ui.notify({
              id: "folders.machine-document",
              level: "warning",
              message:
                "This document is maintained by the app and is not filed in a folder you own.",
            });
            return;
          }
          const row = rows.find((candidate) => candidate.id === id);
          request({
            kind: "move",
            target: {
              kind: "document",
              id,
              title: row?.title ?? stored?.title ?? "this document",
              path: normalizePath(row?.fm["path"] ?? stored?.fm["path"]),
            },
          });
        })();
      },
    },
    {
      id: "folders.showUnfiled",
      title: "Show the documents at the root",
      category: "Folders",
      run: () => router.navigate(folderPath("")),
    },
  ] satisfies Command[]) {
    kernel.extensions.contribute<Command>(POINTS.command, command);
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  const api: FoldersApi = {
    normalize: (path) => normalizePath(path),
    tree: async () =>
      buildTree(rows).flat.map((node) => ({ path: node.path, documents: node.documents })),
    move,
    renameFolder,
    createFolder,
    deleteFolder,
    current: () => {
      const route = router.current();
      return route.split("?")[0] === "/folder" ? folderFromHash(route) : undefined;
    },
    defaultLocation: readDefaultLocation,
    setDefaultLocation: async (path) => {
      await writeSetting(SETTINGS_KEYS.defaultLocation, normalizePath(path));
      announceDefaultLocation();
      publish();
    },
    onDefaultLocationChange: (listener) => {
      defaultLocationListeners.add(listener);
      return () => {
        defaultLocationListeners.delete(listener);
      };
    },
  };

  // Announce once, now that everything is wired: `doc-list` activated before this plugin
  // (it is a dependency), so anything listening is already listening.
  announceDefaultLocation();

  return api;
}

/**
 * The file tree, in the sidebar.
 *
 * **Folders and documents in one tree.** A document with no `fm.path` is a row at root
 * next to the top-level folders — the owner's words, *"notes with no folder just sit in
 * root"* — and a document inside a folder is a leaf under it. The model is
 * `tree.ts`; this file draws it and owns the gestures.
 *
 * **Every move is still one splice.** Dropping a document on a folder is one
 * `setFrontmatterValue` on its `path` key; dropping it on Root is one
 * `removeFrontmatterKey`; dropping a *folder* somewhere is one splice per document
 * inside it, run through a bounded pool with a progress row (SPEC §3.3, §6.5). There are
 * no folder records to keep in step, which is why a half-finished folder move is
 * recoverable by simply doing it again: re-planning reads the live projection, and the
 * documents that already moved are not in the second plan.
 *
 * **Three ways to do everything, because one of them is a mouse gesture.** Dragging is
 * a mouse and pen gesture, so every drag has a keyboard and a touch equivalent that ends
 * in the same call: the row's ⋯ button, a long-press, a right-click, or `M` on the active
 * row opens a `context-menu` with Move / Rename / Delete in it. This is
 * `POLISH-BACKLOG.md` §3 — "a document can only be moved by dragging" — closed from the
 * folders side.
 *
 * **A drag lifts the row.** The tree's own drags are pointer-driven, not HTML5: the
 * browser draws an HTML5 drag as a translucent ghost that no style can make solid, and a
 * row should look picked up — an opaque, shadowed, slightly tilted copy under the
 * pointer, with a faded slot where it came from. Dropping a folder on the top or bottom
 * edge of another folder puts it before or after that one (the user's order, `order.ts`,
 * joining that folder's parent if it has to); on the middle, inside it. HTML5 drops are
 * still accepted, for rows other plugins make draggable (`doc-list`).
 *
 * **Keyboard-operable, as a real tree.** `role="tree"` with one tab stop and
 * `aria-activedescendant`: Arrow keys move and expand, `Home`/`End` jump, `Enter` opens
 * (a folder filters the list to it, a document opens it), `Shift+→`/`Shift+←` expand or
 * collapse a folder and everything inside it, `F2` renames, `M` moves,
 * `Delete` deletes the active folder or document. The active row's actions are the one thing Tab may enter.
 *
 * **No `window.prompt` anywhere.** Renaming is an inline field in the row it renames;
 * `POLISH-BACKLOG.md` §4 has the three reasons, of which the first is that the Flutter
 * shell pins no `onJsPrompt` handler, so on a phone the old rename button may have done
 * nothing at all.
 *
 * The HTML5 payload a document row from elsewhere sets is a plain `text/plain` document
 * id, deliberately: `doc-list` rows and anything else that wants to be draggable into a
 * folder only has to set that, with no shared type and no import between plugins.
 * `application/x-lm-folder` is still read, for a folder dragged from an older build.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from "react";

import { documentsUnder, planDocumentMove } from "./moves.js";
import {
  isRecursiveRename,
  isWithin,
  nameOf,
  joinPath,
  normalizePath,
  parentOf,
  renameTarget,
  reparentTarget,
  type PathRow,
} from "./path.js";
import type { ConfirmRequest, ContextMenuApi, MenuItem } from "../../_shared/context-menu-api.js";

import { MovePicker } from "./MovePicker.js";
import { placeAmong, pruneOrder, withSiblings } from "./order.js";
import { ancestorsOf, buildFileTree, type TreeRow } from "./tree.js";

/** The drag type a draggable document row should set. */
export const DOCUMENT_DRAG_TYPE = "text/plain";
/** Set only by this plugin: a folder being dragged, by path. */
export const FOLDER_DRAG_TYPE = "application/x-lm-folder";

/** How long a collapsed folder must be hovered during a drag before it opens. */
const AUTO_EXPAND_MS = 650;
/** How long a touch must rest on a row before the sheet opens. */
const LONG_PRESS_MS = 500;
/** A touch that travels this far was a scroll, not a press. */
const LONG_PRESS_SLOP = 12;
/** A mouse press that travels this far is a drag, not a click. */
const DRAG_THRESHOLD = 5;
/** The top and bottom share of a folder row that mean "before" / "after" rather than "into". */
const EDGE = 0.3;

/** Where a drag would land. `target` is the folder row a before/after is relative to. */
type Drop =
  | { readonly mode: "into"; readonly folder: string }
  | { readonly mode: "before" | "after"; readonly folder: string; readonly target: string };

/** The row being carried: what it is, and where to draw it. */
interface Lift {
  readonly target: TreeTarget;
  readonly x: number;
  readonly y: number;
  /** Where in the row it was grabbed, so it does not jump to the pointer. */
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
}

const NODE_CLASSES =
  "folders-node folders:group folders:flex folders:min-h-[calc(var(--lm-tap-target)/2)] folders:items-center folders:gap-0.5 folders:rounded folders:pr-0.5 folders:pl-[calc(var(--lm-space)*0.5+var(--folders-indent)*min(var(--folders-depth,0),var(--folders-indent-cap)))] folders:hover:bg-bg-subtle folders:compact:min-h-[var(--lm-tap-target)]";
// On a touch screen the twisty is a full tap target that reaches left into the indent,
// with the chevron drawn at its right edge: 44 px to hit, 24 px of row, and no gap
// between the chevron and its name.
const TWISTY_CLASSES =
  "folders-twisty folders:box-border folders:flex folders:w-[1.25rem] folders:min-h-[1.375rem]! folders:shrink-0 folders:cursor-pointer folders:items-center folders:justify-center folders:border-0! folders:bg-transparent! folders:p-0! folders:text-text-muted folders:compact:w-[var(--lm-tap-target)] folders:compact:ml-[calc(1.5rem-var(--lm-tap-target))] folders:compact:justify-end folders:compact:pr-[0.45rem]! folders:compact:min-h-[var(--lm-tap-target)]! folders:touch:w-[var(--lm-tap-target)] folders:touch:ml-[calc(1.5rem-var(--lm-tap-target))] folders:touch:justify-end folders:touch:pr-[0.45rem]! folders:touch:min-h-[var(--lm-tap-target)]!";
const ROW_LABEL_CLASSES =
  "folders:min-w-0 folders:flex-1 folders:cursor-pointer folders:overflow-hidden folders:text-ellipsis folders:whitespace-nowrap folders:border-0! folders:bg-transparent! folders:p-0! folders:text-left folders:font-sans folders:text-inherit";
// The app gives every <button> a tap-target height; on a pointer screen that made a
// folder row (its name is a button) half again as tall as a document row (a span).
const LABEL_BUTTON_CLASSES = `${ROW_LABEL_CLASSES} folders:min-h-0! folders:compact:min-h-[var(--lm-tap-target)]! folders:touch:min-h-[var(--lm-tap-target)]!`;
const ACTIONS_CLASSES =
  "folders-actions folders:invisible folders:flex folders:shrink-0 folders:gap-0.5 folders:group-hover:visible folders:group-focus-within:visible folders:compact:visible folders:[&>button]:box-border folders:[&>button]:min-h-[1.375rem] folders:[&>button]:min-w-[1.375rem] folders:[&>button]:cursor-pointer folders:[&>button]:rounded folders:[&>button]:border folders:[&>button]:border-transparent folders:[&>button]:bg-transparent folders:[&>button]:p-0 folders:[&>button]:text-text-muted folders:hover:[&>button]:border-border folders:hover:[&>button]:text-text folders:compact:[&>button]:min-h-[var(--lm-tap-target)] folders:compact:[&>button]:min-w-[var(--lm-tap-target)] folders:touch:visible folders:touch:[&>button]:min-h-[var(--lm-tap-target)] folders:touch:[&>button]:min-w-[var(--lm-tap-target)]";

export interface MoveProgress {
  readonly onProgress?: (done: number, total: number) => void;
}

/** An action asked for from outside the panel (a command, a keybinding). */
export type TreeRequest =
  | { readonly kind: "create-folder"; readonly parent: string }
  | { readonly kind: "rename-folder"; readonly path: string }
  | { readonly kind: "delete-folder"; readonly path: string }
  /** Expand or collapse a folder and every folder inside it; `""` is the whole tree. */
  | { readonly kind: "fold"; readonly path: string; readonly expanded: boolean }
  | {
      readonly kind: "delete-document";
      readonly target: Extract<TreeTarget, { kind: "document" }>;
    }
  | { readonly kind: "move"; readonly target: TreeTarget };

/** What a sheet, a drag or a key is acting on. */
export type TreeTarget =
  | { readonly kind: "folder"; readonly path: string }
  | {
      readonly kind: "document";
      readonly id: string;
      readonly title: string;
      readonly path: string;
    };

export interface FolderTreeProps {
  /** `context-menu`'s service: every sheet this tree opens goes through it. */
  readonly menu: ContextMenuApi;
  readonly rows: readonly PathRow[];
  readonly loading: boolean;
  readonly error?: string;
  /** Folders that exist only in this user's settings, having never held a document. */
  readonly emptyFolders: readonly string[];
  /** Collapsed folder paths; persisted by the caller (per user, through settings). */
  readonly collapsed: ReadonlySet<string>;
  readonly onCollapsedChange: (next: ReadonlySet<string>) => void;
  /** The user's folder order (`order.ts`), and how to store a new one. */
  readonly order: readonly string[];
  readonly onReorder: (next: readonly string[]) => Promise<void>;
  /**
   * Commands arriving from outside the panel — the palette's "New folder", "Move this
   * document to a folder…", and the keybindings on them. Subscribing rather than
   * prop-drilling one flag per action keeps the panel the only place that knows what a
   * folder dialog looks like, and it works with the drawer shut: the sheet is a portal
   * into `document.body`, so `shell-ui` hiding the sidebar does not hide it.
   */
  readonly requests?: (listener: (request: TreeRequest) => void) => () => void;
  /** Move one document (one `fm.path` splice; `""` removes the key). */
  readonly onMoveDocument: (
    documentId: string,
    folder: string,
  ) => Promise<void>;
  /** Move or rename a folder: one splice per document inside it, with progress. */
  readonly onMoveFolder: (
    from: string,
    to: string,
    options?: MoveProgress,
  ) => Promise<number>;
  /** Remember a folder that holds nothing yet. */
  readonly onCreateFolder: (path: string) => Promise<void>;
  /** `parent` moves the contents up one level; `trash` tombstones them (SPEC §3.5). */
  readonly onDeleteFolder: (
    path: string,
    mode: "parent" | "trash",
    options?: MoveProgress,
  ) => Promise<number>;
  /** Tombstone one document (SPEC §3.5): restorable from Trash. */
  readonly onDeleteDocument: (documentId: string) => Promise<void>;
  readonly onNewDocumentHere: (folder: string) => void;
  /** Show the documents in a folder (`""` = the root view). */
  readonly onSelectFolder: (folder: string) => void;
  readonly onOpenDocument: (documentId: string) => void;
  /**
   * The document open in the main view, however it was opened — a link, the graph, the
   * palette. The tree expands its folders, makes it the active row and scrolls it into
   * view, once each time it changes.
   */
  readonly openDocument?: string;
}

type SheetState =
  | { readonly kind: "actions"; readonly target: TreeTarget; readonly anchor?: HTMLElement }
  | { readonly kind: "move"; readonly target: TreeTarget }
  | {
      readonly kind: "delete";
      readonly path: string;
      readonly documents: number;
    }
  /** The "are you sure?" every delete ends in, whatever was chosen before it. */
  | { readonly kind: "confirm"; readonly action: DeleteAction };

type DeleteAction =
  | {
      readonly kind: "folder";
      readonly path: string;
      readonly mode: "parent" | "trash";
      readonly documents: number;
    }
  | { readonly kind: "document"; readonly id: string; readonly title: string };

type EditState =
  | { readonly kind: "rename"; readonly path: string }
  | { readonly kind: "create"; readonly parent: string };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const labelOf = (target: TreeTarget): string =>
  target.kind === "folder" ? target.path : target.title;

export function FolderTree({
  menu,
  rows,
  loading,
  error,
  emptyFolders,
  collapsed,
  onCollapsedChange,
  order,
  onReorder,
  requests,
  onMoveDocument,
  onMoveFolder,
  onCreateFolder,
  onDeleteFolder,
  onDeleteDocument,
  onNewDocumentHere,
  onSelectFolder,
  onOpenDocument,
  openDocument,
}: FolderTreeProps): ReactElement {
  const tree = useMemo(
    () =>
      buildFileTree(rows, {
        extraFolders: emptyFolders,
        collapsed,
        order,
        ...(openDocument !== undefined ? { reveal: openDocument } : {}),
      }),
    [collapsed, emptyFolders, openDocument, order, rows],
  );
  const visible = tree.rows;

  const [active, setActive] = useState<string | undefined>(undefined);
  const [drop, setDrop] = useState<Drop | undefined>(undefined);
  const [lift, setLift] = useState<Lift | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<
    { done: number; total: number } | undefined
  >(undefined);
  const [retry, setRetry] = useState<{ run: () => void } | undefined>(
    undefined,
  );
  const [edit, setEdit] = useState<EditState | undefined>(undefined);
  const [sheet, setSheet] = useState<SheetState | undefined>(undefined);

  const dragSource = useRef<TreeTarget | undefined>(undefined);
  const autoExpand = useRef<
    { path: string; timer: ReturnType<typeof setTimeout> } | undefined
  >(undefined);
  const longPress = useRef<
    { timer: ReturnType<typeof setTimeout>; x: number; y: number } | undefined
  >(undefined);
  /** A long-press already acted; the click that follows it must not act again. */
  const pressHandled = useRef(false);

  // Reveal the open document: once per document, as soon as its row has arrived (on a cold
  // start the tree can be drawn before the projection has it).
  const revealed = useRef<string | undefined>(undefined);
  const scrollPending = useRef(false);
  useEffect(() => {
    if (openDocument === undefined || revealed.current === openDocument) return;
    const row = rows.find((candidate) => candidate.id === openDocument);
    if (!row) return;
    revealed.current = openDocument;
    const folder = normalizePath(row.fm["path"]);
    const closed = folder === "" ? [] : [...ancestorsOf(folder), folder].filter((path) => collapsed.has(path));
    if (closed.length > 0) {
      const next = new Set(collapsed);
      for (const path of closed) next.delete(path);
      onCollapsedChange(next);
    }
    setActive(`d:${openDocument}`);
    scrollPending.current = true;
  }, [collapsed, onCollapsedChange, openDocument, rows]);

  const treeElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scrollPending.current || active !== `d:${openDocument}`) return;
    const element = treeElement.current?.querySelector('[role="treeitem"][aria-selected="true"]');
    if (!element) return;
    scrollPending.current = false;
    element.scrollIntoView({ block: "nearest" });
  });

  // An active row that just disappeared (its folder collapsed, its document moved) would
  // leave `aria-activedescendant` pointing at nothing.
  useEffect(() => {
    // …except the open document on its way in: its folders are opening this same moment.
    if (scrollPending.current && active === `d:${openDocument}`) return;
    if (active !== undefined && !visible.some((row) => row.key === active)) {
      setActive(visible[0]?.key);
    }
  }, [active, openDocument, visible]);

  useEffect(
    () => () => {
      if (autoExpand.current) clearTimeout(autoExpand.current.timer);
      if (longPress.current) clearTimeout(longPress.current.timer);
    },
    [],
  );

  // ---------------------------------------------------------------------------
  // Expansion
  // ---------------------------------------------------------------------------

  const setExpanded = useCallback(
    (path: string, next: boolean) => {
      const updated = new Set(collapsed);
      if (next) updated.delete(path);
      else updated.add(path);
      onCollapsedChange(updated);
    },
    [collapsed, onCollapsedChange],
  );

  /**
   * Expand or collapse `path` and every folder below it (`""`: all of them). Collapsing
   * the descendants too is the point: opening the folder again later shows them folded.
   */
  const setExpandedDeep = useCallback(
    (path: string, next: boolean) => {
      const root = normalizePath(path);
      const updated = new Set(collapsed);
      for (const folder of tree.folders) {
        if (root !== "" && folder !== root && !folder.startsWith(`${root}/`)) continue;
        if (next) updated.delete(folder);
        else updated.add(folder);
      }
      onCollapsedChange(updated);
    },
    [collapsed, onCollapsedChange, tree.folders],
  );

  /** Open everything between root and `path`, so a folder just created or moved shows. */
  const revealFolder = useCallback(
    (path: string) => {
      const updated = new Set(collapsed);
      for (const ancestor of ancestorsOf(path)) updated.delete(ancestor);
      updated.delete(normalizePath(path));
      onCollapsedChange(updated);
    },
    [collapsed, onCollapsedChange],
  );

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * One place where a write becomes busy/progress/problem, and where a failure keeps
   * the thing it failed at so it can be run again. Every move in this plugin is a set of
   * independent splices, so "try again" is honest: it re-plans against the live
   * projection and writes only what is still in the old place.
   */
  const run: (operation: () => Promise<unknown>) => void = useCallback(
    (operation) => {
      setBusy(true);
      setProblem(undefined);
      setProgress(undefined);
      setRetry(undefined);
      void operation()
        .catch((cause: unknown) => {
          setProblem(messageOf(cause));
          setRetry({ run: () => run(operation) });
        })
        .finally(() => {
          setBusy(false);
          setProgress(undefined);
        });
    },
    [],
  );

  const onProgress = useCallback((done: number, total: number) => {
    setProgress(total > 1 ? { done, total } : undefined);
  }, []);

  const moveDocument = useCallback(
    (documentId: string, folder: string) => {
      if (documentId === "") return;
      const current = rows.find((row) => row.id === documentId)?.fm["path"];
      // Dropping a document back where it already is writes nothing: a splice that
      // stores the same value is still a CRDT transaction and a sync round trip, and it
      // would show up in the document's history as an edit nobody made.
      const next = planDocumentMove(current, folder);
      if (next === undefined) return;
      run(() => onMoveDocument(documentId, next));
    },
    [onMoveDocument, rows, run],
  );

  const moveFolder = useCallback(
    (from: string, to: string) => {
      const source = normalizePath(from);
      const target = normalizePath(to);
      if (source === "" || source === target) return;
      if (isRecursiveRename(source, target)) {
        setProblem(`“${source}” cannot go inside itself.`);
        return;
      }
      run(async () => {
        await onMoveFolder(source, target, { onProgress });
        revealFolder(target);
      });
    },
    [onMoveFolder, onProgress, revealFolder, run],
  );

  const moveTarget = useCallback(
    (target: TreeTarget, folder: string) => {
      if (target.kind === "document") moveDocument(target.id, folder);
      else moveFolder(target.path, reparentTarget(target.path, folder));
    },
    [moveDocument, moveFolder],
  );

  const commitEdit = useCallback(
    (state: EditState, raw: string) => {
      setEdit(undefined);
      const name = raw.trim();
      if (name === "") return;
      if (state.kind === "create") {
        const path = joinPath(state.parent, name);
        if (path === "") return;
        run(async () => {
          await onCreateFolder(path);
          revealFolder(path);
          setActive(`f:${path}`);
        });
        return;
      }
      const target = renameTarget(state.path, name);
      if (target === "" || target === state.path) return;
      moveFolder(state.path, target);
    },
    [moveFolder, onCreateFolder, revealFolder, run],
  );

  const deleteFolder = useCallback(
    (path: string, mode: "parent" | "trash") => {
      setSheet(undefined);
      run(() => onDeleteFolder(path, mode, { onProgress }));
    },
    [onDeleteFolder, onProgress, run],
  );

  const deleteDocument = useCallback(
    (id: string) => {
      setSheet(undefined);
      run(() => onDeleteDocument(id));
    },
    [onDeleteDocument, run],
  );

  /**
   * A folder with documents in it first asks where they go; every delete then ends in a
   * confirm. An empty folder skips the first question — there is nothing to place.
   */
  const startDelete = useCallback(
    (path: string) => {
      const documents = documentsUnder(rows, path).length;
      if (documents === 0) {
        setSheet({ kind: "confirm", action: { kind: "folder", path, mode: "parent", documents } });
        return;
      }
      setSheet({ kind: "delete", path, documents });
    },
    [rows],
  );

  const startDeleteDocument = useCallback(
    (target: Extract<TreeTarget, { kind: "document" }>) =>
      setSheet({
        kind: "confirm",
        action: { kind: "document", id: target.id, title: target.title },
      }),
    [],
  );

  // A command, a keybinding, or anything else outside this panel.
  useEffect(() => {
    if (!requests) return undefined;
    return requests((request) => {
      switch (request.kind) {
        case "create-folder":
          if (request.parent !== "") revealFolder(request.parent);
          setEdit({ kind: "create", parent: normalizePath(request.parent) });
          return;
        case "rename-folder":
          setEdit({ kind: "rename", path: normalizePath(request.path) });
          return;
        case "delete-folder":
          startDelete(request.path);
          return;
        case "fold":
          setExpandedDeep(request.path, request.expanded);
          return;
        case "delete-document":
          startDeleteDocument(request.target);
          return;
        case "move":
          setSheet({ kind: "move", target: request.target });
          return;
        default:
      }
    });
  }, [requests, revealFolder, setExpandedDeep, startDelete, startDeleteDocument]);

  // ---------------------------------------------------------------------------
  // Drag and drop
  // ---------------------------------------------------------------------------

  const cancelAutoExpand = useCallback(() => {
    if (autoExpand.current) clearTimeout(autoExpand.current.timer);
    autoExpand.current = undefined;
  }, []);

  // Whether a drag from this tree is in flight — it gates the sticky root drop strip,
  // which has to be *rendered* state, not just the `dragSource` ref.
  const [dragging, setDragging] = useState(false);

  const endDrag = useCallback(() => {
    dragSource.current = undefined;
    setDragging(false);
    setDrop(undefined);
    setLift(undefined);
    cancelAutoExpand();
  }, [cancelAutoExpand]);

  /** A folder may not be dropped into itself, into anything it contains, or where it is. */
  const intoAllowed = useCallback((folder: string, source: TreeTarget | undefined): boolean => {
    if (source?.kind !== "folder") return true;
    return !isWithin(normalizePath(folder), source.path) && parentOf(source.path) !== folder;
  }, []);

  /**
   * Auto-expand: a drag that rests on a closed folder is a user trying to get inside it,
   * and on a phone-sized panel there is no second hand to click with.
   */
  const hoverFolder = useCallback(
    (folder: string | undefined, expandable: boolean) => {
      if (folder !== undefined && folder !== "" && expandable && collapsed.has(folder)) {
        if (autoExpand.current?.path === folder) return;
        cancelAutoExpand();
        autoExpand.current = {
          path: folder,
          timer: setTimeout(() => {
            autoExpand.current = undefined;
            setExpanded(folder, true);
          }, AUTO_EXPAND_MS),
        };
      } else {
        cancelAutoExpand();
      }
    },
    [cancelAutoExpand, collapsed, setExpanded],
  );

  /** Put `path` before or after the folder `target`, joining `target`'s parent if need be. */
  const reorderFolder = useCallback(
    (path: string, target: string, where: "before" | "after") => {
      const parent = parentOf(target);
      const next = parentOf(path) === parent ? path : reparentTarget(path, parent);
      const placed = placeAmong(tree.children.get(parent) ?? [], next, target, where);
      const stored = pruneOrder(
        withSiblings(order, placed, [path]),
        new Set([...tree.folders, next]),
      );
      run(async () => {
        await onReorder(stored);
        if (next !== path) {
          await onMoveFolder(path, next, { onProgress });
          revealFolder(next);
        }
      });
    },
    [onMoveFolder, onProgress, onReorder, order, revealFolder, run, tree],
  );

  // --- The tree's own drags: pointer events, a lifted copy under the pointer --------

  /** What lies under the pointer, as a drop. `undefined` where nothing may land. */
  const dropAt = useCallback(
    (x: number, y: number, source: TreeTarget): Drop | undefined => {
      const element = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-drop-kind]");
      if (!element) return undefined;
      const kind = element.dataset["dropKind"];
      const path = element.dataset["dropPath"] ?? "";
      if (kind === "folder" && source.kind === "folder" && path !== source.path) {
        const box = element.getBoundingClientRect();
        const share = (y - box.top) / Math.max(1, box.height);
        const where = share < EDGE ? "before" : share > 1 - EDGE ? "after" : undefined;
        // Next to a folder is inside its parent, which may not be the dragged folder's own
        // subtree either.
        if (where && !isWithin(parentOf(path), source.path)) {
          return { mode: where, folder: parentOf(path), target: path };
        }
      }
      const folder = kind === "root" ? "" : path;
      return intoAllowed(folder, source) ? { mode: "into", folder } : undefined;
    },
    [intoAllowed],
  );

  /** Read by the window listeners of a drag in flight, so they never act on stale state. */
  const latest = useRef({ dropAt, hoverFolder, moveTarget, reorderFolder, visible });
  latest.current = { dropAt, hoverFolder, moveTarget, reorderFolder, visible };

  const liftStart = useCallback(
    (event: ReactPointerEvent<HTMLElement>, target: TreeTarget) => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      // The row's own controls keep their clicks; a field being typed in is not a handle.
      if ((event.target as HTMLElement).closest(".folders-actions, .folders-twisty, input")) {
        return;
      }
      const box = event.currentTarget.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY };
      let lifted = false;
      let last: Drop | undefined;

      const place = (x: number, y: number): void => {
        setLift({ target, x, y, dx: start.x - box.left, dy: start.y - box.top, width: box.width });
        last = latest.current.dropAt(x, y, target);
        setDrop(last);
        const row =
          last?.mode === "into"
            ? latest.current.visible.find((entry) => entry.kind === "folder" && entry.path === last?.folder)
            : undefined;
        latest.current.hoverFolder(
          last?.mode === "into" ? last.folder : undefined,
          row?.kind === "folder" && row.expandable,
        );
      };
      const onMove = (moveEvent: PointerEvent): void => {
        if (!lifted) {
          if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < DRAG_THRESHOLD) {
            return;
          }
          lifted = true;
          dragSource.current = target;
          setDragging(true);
          document.body.style.setProperty("user-select", "none");
          document.body.style.setProperty("cursor", "grabbing");
          window.getSelection()?.removeAllRanges();
        }
        place(moveEvent.clientX, moveEvent.clientY);
      };
      const finish = (landed: boolean): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        if (!lifted) return;
        document.body.style.removeProperty("user-select");
        document.body.style.removeProperty("cursor");
        // The click that ends a drag lands on whatever is under the pointer; it is not
        // a click on that thing.
        const swallow = (click: MouseEvent): void => {
          click.stopPropagation();
          click.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
        endDrag();
        if (!landed || !last) return;
        if (last.mode === "into") latest.current.moveTarget(target, last.folder);
        else if (target.kind === "folder") {
          latest.current.reorderFolder(target.path, last.target, last.mode);
        }
      };
      const onUp = (upEvent: PointerEvent): void => {
        if (lifted) last = latest.current.dropAt(upEvent.clientX, upEvent.clientY, target);
        finish(true);
      };
      const onCancel = (): void => finish(false);
      const onKey = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key !== "Escape" || !lifted) return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        finish(false);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
    },
    [endDrag],
  );

  // --- HTML5 drops, from rows other plugins make draggable (`doc-list`) -------------

  const dragOverFolder = useCallback(
    (event: ReactDragEvent, folder: string, expandable: boolean) => {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDrop({ mode: "into", folder });
      hoverFolder(folder, expandable);
    },
    [hoverFolder],
  );

  const dropOnFolder = useCallback(
    (event: ReactDragEvent, folder: string) => {
      event.preventDefault();
      event.stopPropagation();
      const target = normalizePath(folder);
      endDrag();
      const draggedFolder = normalizePath(event.dataTransfer.getData(FOLDER_DRAG_TYPE));
      if (draggedFolder !== "") {
        moveFolder(draggedFolder, reparentTarget(draggedFolder, target));
        return;
      }
      moveDocument(event.dataTransfer.getData(DOCUMENT_DRAG_TYPE).trim(), target);
    },
    [endDrag, moveDocument, moveFolder],
  );

  const leaveFolder = useCallback((folder: string) => {
    setDrop((current) => (current?.mode === "into" && current.folder === folder ? undefined : current));
  }, []);

  /** The folder an "into" drop is outlining, if any. */
  const intoFolder = drop?.mode === "into" ? drop.folder : undefined;

  // ---------------------------------------------------------------------------
  // Long press → the sheet
  // ---------------------------------------------------------------------------

  const openActions = useCallback((target: TreeTarget, anchor?: HTMLElement) => {
    setActive(target.kind === "folder" ? `f:${target.path}` : `d:${target.id}`);
    setSheet({ kind: "actions", target, ...(anchor ? { anchor } : {}) });
  }, []);

  const cancelLongPress = useCallback(() => {
    if (longPress.current) clearTimeout(longPress.current.timer);
    longPress.current = undefined;
  }, []);

  const pressStart = useCallback(
    (event: ReactPointerEvent, target: TreeTarget) => {
      if (event.pointerType !== "touch") return;
      pressHandled.current = false;
      cancelLongPress();
      const { clientX: x, clientY: y } = event;
      longPress.current = {
        x,
        y,
        timer: setTimeout(() => {
          longPress.current = undefined;
          pressHandled.current = true;
          openActions(target);
        }, LONG_PRESS_MS),
      };
    },
    [cancelLongPress, openActions],
  );

  const pressMove = useCallback(
    (event: ReactPointerEvent) => {
      const press = longPress.current;
      if (!press) return;
      if (
        Math.abs(event.clientX - press.x) > LONG_PRESS_SLOP ||
        Math.abs(event.clientY - press.y) > LONG_PRESS_SLOP
      ) {
        cancelLongPress();
      }
    },
    [cancelLongPress],
  );

  /** `true` when the click that follows a long press should be swallowed. */
  const consumePress = useCallback((): boolean => {
    if (!pressHandled.current) return false;
    pressHandled.current = false;
    return true;
  }, []);

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  const targetOf = useCallback(
    (row: TreeRow | undefined): TreeTarget | undefined => {
      if (row?.kind === "folder") return { kind: "folder", path: row.path };
      if (row?.kind === "document")
        return {
          kind: "document",
          id: row.id,
          title: row.title,
          path: row.path,
        };
      return undefined;
    },
    [],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (visible.length === 0 || edit !== undefined) return;
      const index = visible.findIndex((row) => row.key === active);
      const row = index >= 0 ? visible[index] : undefined;
      const move = (next: number): void => {
        event.preventDefault();
        setActive(
          visible[Math.max(0, Math.min(visible.length - 1, next))]?.key,
        );
      };

      switch (event.key) {
        case "ArrowDown":
          move(index + 1);
          return;
        case "ArrowUp":
          move(index < 0 ? 0 : index - 1);
          return;
        case "Home":
          move(0);
          return;
        case "End":
          move(visible.length - 1);
          return;
        case "ArrowRight":
          if (event.shiftKey && row?.kind === "folder" && row.expandable) {
            event.preventDefault();
            setExpandedDeep(row.path, true);
          } else if (row?.kind === "folder" && row.expandable && !row.expanded) {
            event.preventDefault();
            setExpanded(row.path, true);
          } else if (row?.kind === "folder" && row.expandable) {
            move(index + 1);
          }
          return;
        case "ArrowLeft": {
          if (!row) return;
          event.preventDefault();
          if (event.shiftKey && row.kind === "folder" && row.expandable) {
            setExpandedDeep(row.path, false);
            return;
          }
          if (row.kind === "folder" && row.expandable && row.expanded) {
            setExpanded(row.path, false);
            return;
          }
          const parent = row.kind === "folder" ? parentOf(row.path) : row.path;
          if (parent !== "") setActive(`f:${parent}`);
          return;
        }
        case "Enter":
          if (row?.kind === "folder") {
            event.preventDefault();
            onSelectFolder(row.path);
          } else if (row?.kind === "document") {
            event.preventDefault();
            onOpenDocument(row.id);
          } else if (row?.kind === "more") {
            event.preventDefault();
            onSelectFolder(row.path);
          }
          return;
        case "F2":
          if (row?.kind === "folder") {
            event.preventDefault();
            setEdit({ kind: "rename", path: row.path });
          }
          return;
        case "Delete": {
          const target = targetOf(row);
          if (target?.kind === "folder") {
            event.preventDefault();
            startDelete(target.path);
          } else if (target?.kind === "document") {
            event.preventDefault();
            startDeleteDocument(target);
          }
          return;
        }
        case "m":
        case "M": {
          // The keyboard half of a drag. Named in the hint, because a shortcut nobody
          // is told about is the same as no shortcut.
          const target = targetOf(row);
          if (target) {
            event.preventDefault();
            setSheet({ kind: "move", target });
          }
          return;
        }
        default:
      }
    },
    [
      active,
      edit,
      onOpenDocument,
      onSelectFolder,
      setExpanded,
      setExpandedDeep,
      startDelete,
      startDeleteDocument,
      targetOf,
      visible,
    ],
  );

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------

  const editField = (
    state: EditState,
    initial: string,
    label: string,
  ): ReactElement => (
    <input
      className="folders-rename folders:tap-h folders:min-w-0 folders:flex-1 folders:rounded folders:border folders:border-accent folders:bg-bg-raised folders:px-1 folders:font-sans folders:text-text"
      type="text"
      autoFocus
      defaultValue={initial}
      aria-label={label}
      onKeyDown={(event) => {
        // The tree's own key handling would read this as navigation.
        event.stopPropagation();
        if (event.key === "Enter") commitEdit(state, event.currentTarget.value);
        else if (event.key === "Escape") setEdit(undefined);
      }}
      /*
       * Blur neither commits nor cancels, deliberately: a rename can splice hundreds of
       * documents, and a stray click elsewhere is not consent to start that. The ✓ and ✕
       * next to the field are the two answers, and Enter and Escape are the same two.
       */
    />
  );

  const editControls = (state: EditState): ReactElement => (
    <span className={`${ACTIONS_CLASSES} folders-actions-edit folders:visible`}>
      <button
        type="button"
        aria-label="Save"
        title="Save"
        onClick={(event) => {
          const field = event.currentTarget
            .closest(".folders-node")
            ?.querySelector<HTMLInputElement>(".folders-rename");
          commitEdit(state, field?.value ?? "");
        }}
      >
        ✓
      </button>
      <button
        type="button"
        aria-label="Cancel"
        title="Cancel"
        onClick={() => setEdit(undefined)}
      >
        ✕
      </button>
    </span>
  );

  const creatingRow = (parent: string, depth: number): ReactElement => (
    <div
      key={`new:${parent}`}
      className={`${NODE_CLASSES} folders-node-editing`}
      style={{ "--folders-depth": depth } as CSSProperties}
    >
      <span className={TWISTY_CLASSES} aria-hidden="true" />
      {editField(
        { kind: "create", parent },
        "",
        parent === "" ? "New folder name" : `New folder in ${parent}`,
      )}
      {editControls({ kind: "create", parent })}
    </div>
  );

  const rowElements: ReactElement[] = [];
  if (edit?.kind === "create" && edit.parent === "")
    rowElements.push(creatingRow("", 0));

  visible.forEach((row, index) => {
    const id = `folders-row-${index}`;
    const isActive = row.key === active;
    const common = {
      id,
      role: "treeitem" as const,
      "aria-level": row.depth + 1,
      "aria-selected": isActive,
      style: { "--folders-depth": row.depth } as CSSProperties,
    };

    if (row.kind === "more") {
      rowElements.push(
        <div
          key={row.key}
          {...common}
          className={`${NODE_CLASSES} folders-node-more ${isActive ? " folders-node-active folders:bg-accent-subtle" : ""}`}
          // "…and 37 more" is inside its folder; a drop on it goes there.
          data-drop-kind="document"
          data-drop-path={row.path}
          onMouseDown={() => setActive(row.key)}
        >
          <span className={TWISTY_CLASSES} aria-hidden="true" />
          <button
            type="button"
            className={`folders-more ${LABEL_BUTTON_CLASSES} folders:text-[0.9em] folders:text-text-muted`}
            tabIndex={-1}
            onClick={() => onSelectFolder(row.path)}
          >
            {row.hidden} more…
          </button>
        </div>,
      );
      return;
    }

    if (row.kind === "document") {
      const target: TreeTarget = {
        kind: "document",
        id: row.id,
        title: row.title,
        path: row.path,
      };
      rowElements.push(
        <div
          key={row.key}
          {...common}
          className={[
            NODE_CLASSES,
            "folders-node-leaf folders:cursor-pointer",
            isActive ? "folders-node-active folders:bg-accent-subtle" : "",
            lift?.target.kind === "document" && lift.target.id === row.id ? "folders-node-lifted folders:bg-bg-subtle folders:[&>*]:opacity-40" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          title={row.title}
          // A drop on a document means "put this next to that one" — its folder.
          data-drop-kind="document"
          data-drop-path={row.path}
          onDragOver={(event) => dragOverFolder(event, row.path, false)}
          onDragLeave={() => leaveFolder(row.path)}
          onDrop={(event) => dropOnFolder(event, row.path)}
          onMouseDown={() => setActive(row.key)}
          onPointerDown={(event) => {
            pressStart(event, target);
            liftStart(event, target);
          }}
          onPointerMove={pressMove}
          onPointerUp={cancelLongPress}
          onPointerCancel={cancelLongPress}
          onContextMenu={(event) => {
            event.preventDefault();
            openActions(target);
          }}
          onClick={() => {
            if (consumePress()) return;
            setActive(row.key);
            onOpenDocument(row.id);
          }}
        >
          <span className={TWISTY_CLASSES} aria-hidden="true" />
          <span
            className={`folders-leaf-name ${ROW_LABEL_CLASSES} folders:text-link`}
          >
            {row.title}
          </span>
          <span
            className={`${ACTIONS_CLASSES}${isActive ? " folders:visible" : ""}`}
          >
            <button
              type="button"
              tabIndex={isActive ? 0 : -1}
              /*
               * "Document actions", not "Actions for <title>".
               *
               * The row this button sits in is a `treeitem` whose accessible name is
               * already the document's title, so assistive technology reads the two
               * together and nothing is lost — while a label that *contained* the title
               * would make every "the row called X" query in the workspace ambiguous
               * between this button and `doc-list`'s row of the same name. One title,
               * two controls that answer to it, is a trap for anything that drives this
               * app by accessible name.
               */
              aria-label="Document actions"
              title={`Move or delete ${row.title}`}
              onClick={(event) => {
                event.stopPropagation();
                openActions(target, event.currentTarget);
              }}
            >
              ⋯
            </button>
          </span>
        </div>,
      );
      return;
    }

    const target: TreeTarget = { kind: "folder", path: row.path };
    const renaming = edit?.kind === "rename" && edit.path === row.path;
    rowElements.push(
      <div
        key={row.key}
        {...common}
        {...(row.expandable ? { "aria-expanded": row.expanded } : {})}
        className={[
          NODE_CLASSES,
          isActive ? "folders-node-active folders:bg-accent-subtle" : "",
          row.path === intoFolder
            ? "folders-node-drop folders:outline-2 folders:outline-dashed folders:outline-accent folders:outline-offset-[-2px]"
            : "",
          drop?.mode === "before" && drop.target === row.path
            ? "folders-node-before folders:shadow-[inset_0_2px_0_0_var(--lm-accent)]"
            : "",
          drop?.mode === "after" && drop.target === row.path
            ? "folders-node-after folders:shadow-[inset_0_-2px_0_0_var(--lm-accent)]"
            : "",
          lift?.target.kind === "folder" && lift.target.path === row.path ? "folders-node-lifted folders:bg-bg-subtle folders:[&>*]:opacity-40" : "",
          row.tracked
            ? "folders-node-empty folders:italic folders:text-text-muted"
            : "",
          renaming ? "folders-node-editing" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-drop-kind="folder"
        data-drop-path={row.path}
        onDragOver={(event) => dragOverFolder(event, row.path, row.expandable)}
        onDragLeave={() => leaveFolder(row.path)}
        onDrop={(event) => dropOnFolder(event, row.path)}
        onMouseDown={() => setActive(row.key)}
        onPointerDown={(event) => {
          pressStart(event, target);
          if (!renaming) liftStart(event, target);
        }}
        onPointerMove={pressMove}
        onPointerUp={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onContextMenu={(event) => {
          event.preventDefault();
          openActions(target);
        }}
        /*
         * The row itself has no action, and consumes the click anyway.
         *
         * `pressHandled` is set by the long-press timer and cleared by `consumePress`,
         * which only the *document* row and the folder *name* hang off. A long press on
         * the blank part of a folder row — right of the name, left of the actions — is
         * a real gesture (it opens the sheet) whose click has nothing to land on, so the
         * flag was left standing on a path where nothing was going to take it down.
         * Every touch `pressStart` also resets it, which is why this is a latent edge
         * rather than a swallowed tap today; making the row's own click consume its own
         * press is what stops it depending on that.
         */
        onClick={() => void consumePress()}
      >
        {row.expandable ? (
          <button
            type="button"
            className={TWISTY_CLASSES}
            tabIndex={-1}
            aria-label={
              row.expanded ? `Collapse ${row.name}` : `Expand ${row.name}`
            }
            title="Alt-click to include every folder inside"
            onClick={(event) => {
              event.stopPropagation();
              // Alt (Option) or Shift: the folder and everything under it, as in VS Code.
              if (event.altKey || event.shiftKey) setExpandedDeep(row.path, !row.expanded);
              else setExpanded(row.path, !row.expanded);
            }}
          >
            {row.expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className={TWISTY_CLASSES} aria-hidden="true" />
        )}

        {renaming ? (
          /*
           * "Rename or move", because it is both: the field holds the folder's *name*,
           * and a name with a `/` in it is a path, so typing `archive/2026` moves the
           * folder there. Same words as the button that opens it.
           */
          editField(
            { kind: "rename", path: row.path },
            row.name,
            `Rename or move ${row.path}`,
          )
        ) : (
          <button
            type="button"
            className={`folders-name ${LABEL_BUTTON_CLASSES}`}
            tabIndex={-1}
            onClick={() => {
              if (consumePress()) return;
              onSelectFolder(row.path);
            }}
          >
            {row.name}
          </button>
        )}

        {!renaming && (
          <span
            className="folders-count folders:shrink-0 folders:text-[0.8em] folders:tabular-nums folders:text-text-muted"
            aria-label={`${row.documents} documents`}
          >
            {row.documents}
          </span>
        )}

        {renaming ? (
          editControls({ kind: "rename", path: row.path })
        ) : (
          /*
           * The row actions are the one part of this tree that Tab may enter.
           *
           * The tree itself is a roving-tabindex widget — the container holds the only
           * tab stop and arrows move the active row — which leaves these buttons
           * unreachable by key unless the *active* row's become a tab stop. That keeps
           * exactly one tab stop per tree plus the actions of the row the user is
           * standing on, and it follows the visible affordance: the row that shows its
           * buttons is the row whose buttons Tab reaches.
           */
          <span
            className={`${ACTIONS_CLASSES}${isActive ? " folders:visible" : ""}`}
          >
            <button
              type="button"
              tabIndex={isActive ? 0 : -1}
              aria-label={`Actions for ${row.path}`}
              title="Move, new folder, delete"
              onClick={(event) => {
                event.stopPropagation();
                openActions(target, event.currentTarget);
              }}
            >
              ⋯
            </button>
          </span>
        )}
      </div>,
    );

    if (edit?.kind === "create" && edit.parent === row.path) {
      rowElements.push(creatingRow(row.path, row.depth + 1));
    }
  });

  // ---------------------------------------------------------------------------
  // The sheet
  // ---------------------------------------------------------------------------

  // Every sheet goes through `context-menu`. Opened when `sheet` changes (not on every
  // render: replacing an open menu closes the previous one, which would clear `sheet`).
  useEffect(() => {
    if (!sheet) {
      menu.close();
      return;
    }
    const onClose = (): void => setSheet(undefined);

    if (sheet.kind === "move") {
      const target = sheet.target;
      menu.openSheet({
        title: `Move ${labelOf(target)} to…`,
        onClose,
        render: () => (
          <MovePicker
            folders={tree.folders}
            subject={labelOf(target)}
            currentFolder={target.kind === "folder" ? parentOf(target.path) : target.path}
            {...(target.kind === "folder" ? { excludeSubtree: target.path } : {})}
            onChoose={(folder) => {
              setSheet(undefined);
              moveTarget(target, folder);
            }}
          />
        ),
      });
      return;
    }

    if (sheet.kind === "delete") {
      const parent = parentOf(sheet.path);
      menu.open({
        title: `Delete ${sheet.path}?`,
        description: (
          <>
            A folder is only a <code>path:</code> line, so its {sheet.documents} document
            {sheet.documents === 1 ? "" : "s"} have to go somewhere.
          </>
        ),
        onClose,
        sections: [
          {
            items: [
              {
                id: "parent",
                label: parent === "" ? "Move them to Root" : `Move them to ${parent}`,
                hint: "One path splice per document; nothing is deleted.",
                run: () =>
                  setSheet({
                    kind: "confirm",
                    action: { kind: "folder", path: sheet.path, mode: "parent", documents: sheet.documents },
                  }),
              },
              {
                id: "trash",
                label: "Move them to Trash",
                hint: "Restorable for 30 days, like any deleted document.",
                danger: true,
                run: () =>
                  setSheet({
                    kind: "confirm",
                    action: { kind: "folder", path: sheet.path, mode: "trash", documents: sheet.documents },
                  }),
              },
            ],
          },
        ],
      });
      return;
    }

    if (sheet.kind === "confirm") {
      const action = sheet.action;
      let live = true;
      void menu.confirm(confirmRequest(action)).then((confirmed) => {
        if (!live) return;
        setSheet(undefined);
        if (!confirmed) return;
        if (action.kind === "document") deleteDocument(action.id);
        else deleteFolder(action.path, action.mode);
      });
      return () => {
        live = false;
      };
    }

    const target = sheet.target;
    const items: MenuItem[] =
      target.kind === "folder"
        ? [
            { id: "open", label: "Show this folder", run: () => onSelectFolder(target.path) },
            {
              id: "new-document",
              label: "New document here",
              run: () => onNewDocumentHere(target.path),
            },
            {
              id: "new-folder",
              label: "New folder inside",
              run: () => {
                revealFolder(target.path);
                setEdit({ kind: "create", parent: target.path });
              },
            },
            {
              id: "expand-all",
              label: "Expand all inside",
              run: () => setExpandedDeep(target.path, true),
            },
            {
              id: "collapse-all",
              label: "Collapse all inside",
              run: () => setExpandedDeep(target.path, false),
            },
            {
              id: "rename",
              label: "Rename",
              run: () => setEdit({ kind: "rename", path: target.path }),
            },
            { id: "move", label: "Move to…", run: () => setSheet({ kind: "move", target }) },
            {
              id: "delete",
              label: "Delete folder",
              danger: true,
              run: () => startDelete(target.path),
            },
          ]
        : [
            { id: "open", label: "Open", run: () => onOpenDocument(target.id) },
            {
              id: "move",
              label: "Move to…",
              hint: target.path === "" ? "Currently at root" : `Currently in ${target.path}`,
              run: () => setSheet({ kind: "move", target }),
            },
            {
              id: "delete",
              label: "Delete",
              hint: "Restorable from Trash for 30 days.",
              danger: true,
              run: () => startDeleteDocument(target),
            },
          ];
    menu.open({
      title: labelOf(target),
      ...(sheet.anchor ? { anchor: sheet.anchor } : {}),
      onClose,
      sections: [{ items }],
    });
    // Only `sheet` opens or replaces the menu; the handlers above are read when it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, menu]);

  if (loading) {
    return (
      <p
        className="folders-empty folders:m-0 folders:flex folders:flex-col folders:gap-1 folders:text-[0.85em] folders:text-text-muted"
        role="status"
      >
        Loading folders…
      </p>
    );
  }

  return (
    <div className="folders folders:flex folders:flex-col folders:gap-0.5 folders:font-sans folders:text-text">
      {error && (
        <p
          className="folders-error folders:m-0 folders:rounded folders:border folders:border-danger folders:p-1.5 folders:text-[0.9em]"
          role="alert"
        >
          {error}
        </p>
      )}
      {problem && (
        <p
          className="folders-error folders:m-0 folders:rounded folders:border folders:border-danger folders:p-1.5 folders:text-[0.9em]"
          role="alert"
        >
          {problem}{" "}
          {retry && (
            <button
              type="button"
              className="folders-retry folders:min-h-[calc(var(--lm-tap-target)-12px)] folders:cursor-pointer folders:rounded folders:border folders:border-border-strong folders:bg-bg-raised folders:px-1.5 folders:font-sans"
              onClick={retry.run}
            >
              Try again
            </button>
          )}
        </p>
      )}
      {progress && (
        <p
          className="folders-progress folders:m-0 folders:rounded folders:border folders:border-border folders:p-1.5 folders:text-[0.9em] folders:text-text-muted"
          role="status"
        >
          Moving documents… {progress.done} of {progress.total}
        </p>
      )}

      {visible.length === 0 && edit === undefined ? (
        <div className="folders-empty folders:m-0 folders:flex folders:flex-col folders:gap-1 folders:text-[0.85em] folders:text-text-muted">
          <p>No documents yet.</p>
        </div>
      ) : (
        <div
          className={`folders-tree folders:flex folders:min-h-[calc(var(--lm-tap-target)*1.5)] folders:flex-col folders:pb-3 folders:[--folders-indent:calc(var(--lm-space)*1.5)] folders:[--folders-indent-cap:6] folders:focus-visible:outline-2 folders:focus-visible:outline-offset-[-2px] folders:focus-visible:outline-focus folders:compact:[--folders-indent:calc(var(--lm-space)*0.75)] folders:compact:[--folders-indent-cap:4] ${intoFolder === "" ? " folders-tree-root-drop folders:rounded folders:outline-2 folders:outline-dashed folders:outline-accent folders:outline-offset-[-2px]" : ""}`}
          ref={treeElement}
          role="tree"
          // Blank space in the tree is root, the way it is in every file manager.
          data-drop-kind="root"
          aria-label="Folders"
          aria-busy={busy}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (active === undefined) setActive(visible[0]?.key);
          }}
          // A drop on the tree's own background is a drop on root — the way dropping
          // into blank space works in every file manager. `currentTarget` only: a drop
          // a row *refused* (a folder onto its own descendant) must not fall through to
          // root and move it somewhere nobody asked for.
          onDragOver={(event) => {
            if (event.target === event.currentTarget)
              dragOverFolder(event, "", false);
          }}
          onDrop={(event) => {
            if (event.target === event.currentTarget) dropOnFolder(event, "");
          }}
          {...(active !== undefined
            ? {
                "aria-activedescendant": `folders-row-${visible.findIndex((row) => row.key === active)}`,
              }
            : {})}
        >
          {rowElements}
          {dragging ? (
            // Only while dragging, and pinned to the bottom of whatever part of the
            // tree is on screen: the "move to root" target is reachable no matter how
            // tall the tree has grown (a document leaves its folder; a folder becomes
            // top-level).
            <div
              className={`folders-root-dropzone folders:sticky folders:bottom-0 folders:z-[1] folders:mt-0.5 folders:rounded folders:border folders:border-dashed folders:border-border-strong folders:bg-bg-raised folders:p-1.5 folders:text-center folders:text-[0.85rem] folders:text-text-muted ${intoFolder === "" ? " folders-node-drop folders:outline-2 folders:outline-dashed folders:outline-accent folders:outline-offset-[-2px]" : ""}`}
              onDragOver={(event) => dragOverFolder(event, "", false)}
              data-drop-kind="root"
              onDragLeave={() => leaveFolder("")}
              onDrop={(event) => dropOnFolder(event, "")}
            >
              Drop here to move to root
            </div>
          ) : null}
        </div>
      )}
      {lift ? <Lifted lift={lift} /> : null}
    </div>
  );
}

const plural = (count: number): string => `${count} document${count === 1 ? "" : "s"}`;

/** The last question before a delete goes through. */
function confirmRequest(action: DeleteAction): ConfirmRequest {
  if (action.kind === "document") {
    return {
      title: `Delete “${action.title}”?`,
      description: "It goes to Trash, where it can be restored for 30 days.",
      confirmLabel: "Move to Trash",
      danger: true,
    };
  }
  if (action.documents === 0) {
    return {
      title: `Delete “${action.path}”?`,
      description: "The folder is empty; nothing else changes.",
      confirmLabel: "Delete folder",
      danger: true,
    };
  }
  if (action.mode === "trash") {
    return {
      title: `Delete “${action.path}” and its ${plural(action.documents)}?`,
      description: "They go to Trash, where they can be restored for 30 days.",
      confirmLabel: "Move to Trash",
      danger: true,
    };
  }
  const parent = parentOf(action.path);
  return {
    title: `Delete “${action.path}”?`,
    description: `Its ${plural(action.documents)} move to ${parent === "" ? "Root" : parent}.`,
    confirmLabel: "Delete folder",
    danger: true,
  };
}

/**
 * The row being carried: opaque, raised and a little tilted, under the pointer where it
 * was grabbed. A portal, because the sidebar's `container-type` would otherwise make it
 * the containing block of anything `position: fixed` inside it.
 */
function Lifted({ lift }: { readonly lift: Lift }): ReactElement {
  const label = lift.target.kind === "folder" ? nameOf(lift.target.path) : lift.target.title;
  return createPortal(
    <div
      className="folders-lifted folders:pointer-events-none folders:fixed folders:z-[1000] folders:flex folders:min-h-[calc(var(--lm-tap-target)/2)] folders:items-center folders:gap-1.5 folders:overflow-hidden folders:rounded folders:border folders:border-border-strong folders:bg-bg-raised folders:px-2 folders:font-sans folders:text-text folders:shadow-2"
      style={{
        left: lift.x - lift.dx,
        top: lift.y - lift.dy,
        width: lift.width,
        transform: "rotate(1.5deg) scale(1.03)",
      }}
      aria-hidden="true"
    >
      <span className="folders:shrink-0 folders:text-text-muted">
        {lift.target.kind === "folder" ? "▸" : "·"}
      </span>
      <span className="folders:min-w-0 folders:flex-1 folders:overflow-hidden folders:text-ellipsis folders:whitespace-nowrap">
        {label}
      </span>
    </div>,
    document.body,
  );
}

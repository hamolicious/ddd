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
 * **Three ways to do everything, because one of them is a mouse gesture.** HTML5 drag
 * and drop does not exist on touch, so every drag has a keyboard and a touch equivalent
 * that ends in the same call: the row's ⋯ button, a long-press, a right-click, or `M` on
 * the active row opens the sheet (`Sheet.tsx`) with Move / Rename / Delete in it. This is
 * `POLISH-BACKLOG.md` §3 — "a document can only be moved by dragging" — closed from the
 * folders side.
 *
 * **Keyboard-operable, as a real tree.** `role="tree"` with one tab stop and
 * `aria-activedescendant`: Arrow keys move and expand, `Home`/`End` jump, `Enter` opens
 * (a folder filters the list to it, a document opens it), `F2` renames, `M` moves,
 * `Delete` deletes a folder. The active row's actions are the one thing Tab may enter.
 *
 * **No `window.prompt` anywhere.** Renaming is an inline field in the row it renames;
 * `POLISH-BACKLOG.md` §4 has the three reasons, of which the first is that the Flutter
 * shell pins no `onJsPrompt` handler, so on a phone the old rename button may have done
 * nothing at all.
 *
 * The drag payload for a document is a plain `text/plain` document id, unchanged and
 * deliberately: `doc-list` rows and anything else that wants to be draggable into a
 * folder only has to set that, with no shared type and no import between plugins. A
 * *folder* drag adds `application/x-lm-folder` — a type nothing outside this plugin
 * sets, so a folder can never be mistaken for a document id.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from "react";

import { useTouchOnly } from "../../_shared/compact.js";
import { documentsUnder, planDocumentMove } from "./moves.js";
import {
  isRecursiveRename,
  isWithin,
  joinPath,
  normalizePath,
  parentOf,
  renameTarget,
  reparentTarget,
  type PathRow,
} from "./path.js";
import { MovePicker, Sheet, SheetActions } from "./Sheet.js";
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

const NODE_CLASSES =
  "folders-node group flex min-h-[calc(var(--lm-tap-target)/2)] items-center gap-0.5 rounded pr-0.5 pl-[calc(var(--lm-space)*0.5+var(--folders-indent)*min(var(--folders-depth,0),var(--folders-indent-cap)))] hover:bg-bg-subtle compact:min-h-[var(--lm-tap-target)]";
const TWISTY_CLASSES =
  "folders-twisty box-border flex w-[1.5rem] min-h-[1.5rem]! shrink-0 cursor-pointer items-center justify-center border-0! bg-transparent! p-0! text-text-muted compact:w-[var(--lm-tap-target)] compact:min-h-[var(--lm-tap-target)]!";
const ROW_LABEL_CLASSES =
  "min-w-0 flex-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap border-0! bg-transparent! p-0! text-left font-sans text-inherit";
const ACTIONS_CLASSES =
  "folders-actions invisible flex shrink-0 gap-0.5 group-hover:visible group-focus-within:visible compact:visible [&>button]:box-border [&>button]:min-h-[1.75rem] [&>button]:min-w-[1.75rem] [&>button]:cursor-pointer [&>button]:rounded [&>button]:border [&>button]:border-transparent [&>button]:bg-transparent [&>button]:p-0 [&>button]:text-text-muted hover:[&>button]:border-border hover:[&>button]:text-text compact:[&>button]:min-h-[var(--lm-tap-target)] compact:[&>button]:min-w-[var(--lm-tap-target)]";

export interface MoveProgress {
  readonly onProgress?: (done: number, total: number) => void;
}

/** An action asked for from outside the panel (a command, a keybinding). */
export type TreeRequest =
  | { readonly kind: "create-folder"; readonly parent: string }
  | { readonly kind: "rename-folder"; readonly path: string }
  | { readonly kind: "delete-folder"; readonly path: string }
  | { readonly kind: "move"; readonly target: TreeTarget };

/** What a sheet, a drag or a key is acting on. */
export type TreeTarget =
  | { readonly kind: "folder"; readonly path: string }
  | { readonly kind: "document"; readonly id: string; readonly title: string; readonly path: string };

export interface FolderTreeProps {
  readonly rows: readonly PathRow[];
  readonly loading: boolean;
  readonly error?: string;
  /** Folders that exist only in this user's settings, having never held a document. */
  readonly emptyFolders: readonly string[];
  /** Collapsed folder paths; persisted by the caller (per user, through settings). */
  readonly collapsed: ReadonlySet<string>;
  readonly onCollapsedChange: (next: ReadonlySet<string>) => void;
  /**
   * Commands arriving from outside the panel — the palette's "New folder", "Move this
   * document to a folder…", and the keybindings on them. Subscribing rather than
   * prop-drilling one flag per action keeps the panel the only place that knows what a
   * folder dialog looks like, and it works with the drawer shut: the sheet is a portal
   * into `document.body`, so `shell-ui` hiding the sidebar does not hide it.
   */
  readonly requests?: (listener: (request: TreeRequest) => void) => () => void;
  /** Move one document (one `fm.path` splice; `""` removes the key). */
  readonly onMoveDocument: (documentId: string, folder: string) => Promise<void>;
  /** Move or rename a folder: one splice per document inside it, with progress. */
  readonly onMoveFolder: (from: string, to: string, options?: MoveProgress) => Promise<number>;
  /** Remember a folder that holds nothing yet. */
  readonly onCreateFolder: (path: string) => Promise<void>;
  /** `parent` moves the contents up one level; `trash` tombstones them (SPEC §3.5). */
  readonly onDeleteFolder: (
    path: string,
    mode: "parent" | "trash",
    options?: MoveProgress,
  ) => Promise<number>;
  readonly onNewDocumentHere: (folder: string) => void;
  /** Show the documents in a folder (`""` = the root view). */
  readonly onSelectFolder: (folder: string) => void;
  readonly onOpenDocument: (documentId: string) => void;
}

type SheetState =
  | { readonly kind: "actions"; readonly target: TreeTarget }
  | { readonly kind: "move"; readonly target: TreeTarget }
  | { readonly kind: "delete"; readonly path: string; readonly documents: number };

type EditState =
  | { readonly kind: "rename"; readonly path: string }
  | { readonly kind: "create"; readonly parent: string };

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const labelOf = (target: TreeTarget): string =>
  target.kind === "folder" ? target.path : target.title;

export function FolderTree({
  rows,
  loading,
  error,
  emptyFolders,
  collapsed,
  onCollapsedChange,
  requests,
  onMoveDocument,
  onMoveFolder,
  onCreateFolder,
  onDeleteFolder,
  onNewDocumentHere,
  onSelectFolder,
  onOpenDocument,
}: FolderTreeProps): ReactElement {
  const touchOnly = useTouchOnly();
  const tree = useMemo(
    () => buildFileTree(rows, { extraFolders: emptyFolders, collapsed }),
    [collapsed, emptyFolders, rows],
  );
  const visible = tree.rows;

  const [active, setActive] = useState<string | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>(undefined);
  const [retry, setRetry] = useState<{ run: () => void } | undefined>(undefined);
  const [edit, setEdit] = useState<EditState | undefined>(undefined);
  const [sheet, setSheet] = useState<SheetState | undefined>(undefined);

  const dragSource = useRef<TreeTarget | undefined>(undefined);
  const autoExpand = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | undefined>(
    undefined,
  );
  const longPress = useRef<
    { timer: ReturnType<typeof setTimeout>; x: number; y: number } | undefined
  >(undefined);
  /** A long-press already acted; the click that follows it must not act again. */
  const pressHandled = useRef(false);

  // An active row that just disappeared (its folder collapsed, its document moved) would
  // leave `aria-activedescendant` pointing at nothing.
  useEffect(() => {
    if (active !== undefined && !visible.some((row) => row.key === active)) {
      setActive(visible[0]?.key);
    }
  }, [active, visible]);

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
  const run: (operation: () => Promise<unknown>) => void = useCallback((operation) => {
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
  }, []);

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

  /** Deleting an empty folder asks nothing: nothing but a settings line goes away. */
  const startDelete = useCallback(
    (path: string) => {
      const documents = documentsUnder(rows, path).length;
      if (documents === 0) {
        deleteFolder(path, "parent");
        return;
      }
      setSheet({ kind: "delete", path, documents });
    },
    [deleteFolder, rows],
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
        case "move":
          setSheet({ kind: "move", target: request.target });
          return;
        default:
      }
    });
  }, [requests, revealFolder, startDelete]);

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
    setDropTarget(undefined);
    cancelAutoExpand();
  }, [cancelAutoExpand]);

  /** A folder may not be dropped into itself or into anything it contains. */
  const dropAllowed = useCallback((folder: string): boolean => {
    const source = dragSource.current;
    if (source?.kind !== "folder") return true;
    return !isWithin(normalizePath(folder), source.path) && parentOf(source.path) !== folder;
  }, []);

  const dragOverFolder = useCallback(
    (event: ReactDragEvent, folder: string, expandable: boolean) => {
      if (!dropAllowed(folder)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDropTarget(folder);
      // Auto-expand: a drag that rests on a closed folder is a user trying to get
      // inside it, and on a phone-sized panel there is no second hand to click with.
      if (folder !== "" && expandable && collapsed.has(folder)) {
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
    [cancelAutoExpand, collapsed, dropAllowed, setExpanded],
  );

  const dropOnFolder = useCallback(
    (event: ReactDragEvent, folder: string) => {
      event.preventDefault();
      event.stopPropagation();
      const target = normalizePath(folder);
      const source = dragSource.current;
      endDrag();
      // The payload is read back rather than trusted from `dragSource` alone: a drag can
      // start in another plugin's row (`doc-list` sets the document id and nothing else),
      // and then there is no source here to consult.
      const draggedFolder = normalizePath(event.dataTransfer.getData(FOLDER_DRAG_TYPE));
      const folderPath = draggedFolder !== "" ? draggedFolder : source?.kind === "folder" ? source.path : "";
      if (folderPath !== "") {
        moveFolder(folderPath, reparentTarget(folderPath, target));
        return;
      }
      moveDocument(event.dataTransfer.getData(DOCUMENT_DRAG_TYPE).trim(), target);
    },
    [endDrag, moveDocument, moveFolder],
  );

  const startDrag = useCallback((event: ReactDragEvent, target: TreeTarget) => {
    dragSource.current = target;
    setDragging(true);
    event.dataTransfer.effectAllowed = "move";
    if (target.kind === "folder") event.dataTransfer.setData(FOLDER_DRAG_TYPE, target.path);
    else event.dataTransfer.setData(DOCUMENT_DRAG_TYPE, target.id);
  }, []);

  // ---------------------------------------------------------------------------
  // Long press → the sheet
  // ---------------------------------------------------------------------------

  const openActions = useCallback((target: TreeTarget) => {
    setActive(target.kind === "folder" ? `f:${target.path}` : `d:${target.id}`);
    setSheet({ kind: "actions", target });
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

  const targetOf = useCallback((row: TreeRow | undefined): TreeTarget | undefined => {
    if (row?.kind === "folder") return { kind: "folder", path: row.path };
    if (row?.kind === "document")
      return { kind: "document", id: row.id, title: row.title, path: row.path };
    return undefined;
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (visible.length === 0 || edit !== undefined) return;
      const index = visible.findIndex((row) => row.key === active);
      const row = index >= 0 ? visible[index] : undefined;
      const move = (next: number): void => {
        event.preventDefault();
        setActive(visible[Math.max(0, Math.min(visible.length - 1, next))]?.key);
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
          if (row?.kind === "folder" && row.expandable && !row.expanded) {
            event.preventDefault();
            setExpanded(row.path, true);
          } else if (row?.kind === "folder" && row.expandable) {
            move(index + 1);
          }
          return;
        case "ArrowLeft": {
          if (!row) return;
          event.preventDefault();
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
        case "Delete":
          if (row?.kind === "folder") {
            event.preventDefault();
            startDelete(row.path);
          }
          return;
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
    [active, edit, onOpenDocument, onSelectFolder, setExpanded, startDelete, targetOf, visible],
  );

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------

  const editField = (state: EditState, initial: string, label: string): ReactElement => (
    <input
      className="folders-rename tap-h min-w-0 flex-1 rounded border border-accent bg-bg-raised px-1 font-sans text-text"
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
    <span className={`${ACTIONS_CLASSES} folders-actions-edit visible`}>
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
      <button type="button" aria-label="Cancel" title="Cancel" onClick={() => setEdit(undefined)}>
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
      {editField({ kind: "create", parent }, "", parent === "" ? "New folder name" : `New folder in ${parent}`)}
      {editControls({ kind: "create", parent })}
    </div>
  );

  const rowElements: ReactElement[] = [];
  if (edit?.kind === "create" && edit.parent === "") rowElements.push(creatingRow("", 0));

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
          className={`${NODE_CLASSES} folders-node-more ${isActive ? " folders-node-active bg-accent-subtle" : ""}`}
          onMouseDown={() => setActive(row.key)}
        >
          <span className={TWISTY_CLASSES} aria-hidden="true" />
          <button
            type="button"
            className={`folders-more ${ROW_LABEL_CLASSES} text-[0.9em] text-text-muted`}
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
      const target: TreeTarget = { kind: "document", id: row.id, title: row.title, path: row.path };
      rowElements.push(
        <div
          key={row.key}
          {...common}
          className={[
            NODE_CLASSES,
            "folders-node-leaf cursor-pointer",
            isActive ? "folders-node-active bg-accent-subtle" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          draggable
          title={row.title}
          onDragStart={(event) => startDrag(event, target)}
          onDragEnd={endDrag}
          // A drop on a document means "put this next to that one" — its folder.
          onDragOver={(event) => dragOverFolder(event, row.path, false)}
          onDragLeave={() => setDropTarget((current) => (current === row.path ? undefined : current))}
          onDrop={(event) => dropOnFolder(event, row.path)}
          onMouseDown={() => setActive(row.key)}
          onPointerDown={(event) => pressStart(event, target)}
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
          <span className={`folders-leaf-name ${ROW_LABEL_CLASSES} text-link`}>{row.title}</span>
          <span className={`${ACTIONS_CLASSES}${isActive ? " visible" : ""}`}>
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
              title={`Move ${row.title}`}
              onClick={(event) => {
                event.stopPropagation();
                openActions(target);
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
          isActive ? "folders-node-active bg-accent-subtle" : "",
          row.path === dropTarget ? "folders-node-drop outline-2 outline-dashed outline-accent outline-offset-[-2px]" : "",
          row.tracked ? "folders-node-empty italic text-text-muted" : "",
          renaming ? "folders-node-editing" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        draggable={!renaming}
        onDragStart={(event) => startDrag(event, target)}
        onDragEnd={endDrag}
        onDragOver={(event) => dragOverFolder(event, row.path, row.expandable)}
        onDragLeave={() => setDropTarget((current) => (current === row.path ? undefined : current))}
        onDrop={(event) => dropOnFolder(event, row.path)}
        onMouseDown={() => setActive(row.key)}
        onPointerDown={(event) => pressStart(event, target)}
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
            aria-label={row.expanded ? `Collapse ${row.name}` : `Expand ${row.name}`}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded(row.path, !row.expanded);
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
          editField({ kind: "rename", path: row.path }, row.name, `Rename or move ${row.path}`)
        ) : (
          <button
            type="button"
            className={`folders-name ${ROW_LABEL_CLASSES}`}
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
          <span className="folders-count shrink-0 text-[0.8em] tabular-nums text-text-muted" aria-label={`${row.documents} documents`}>
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
          <span className={`${ACTIONS_CLASSES}${isActive ? " visible" : ""}`}>
            <button
              type="button"
              tabIndex={isActive ? 0 : -1}
              aria-label={`Actions for ${row.path}`}
              title="Move, new folder, delete"
              onClick={(event) => {
                event.stopPropagation();
                openActions(target);
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


  const renderSheet = (): ReactElement | null => {
    if (!sheet) return null;
    if (sheet.kind === "move") {
      const target = sheet.target;
      return (
        <Sheet title={`Move ${labelOf(target)} to…`} onClose={() => setSheet(undefined)}>
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
        </Sheet>
      );
    }

    if (sheet.kind === "delete") {
      const parent = parentOf(sheet.path);
      return (
        <Sheet
          title={`Delete ${sheet.path}?`}
          description={
            <>
              A folder is only a <code>path:</code> line, so its {sheet.documents} document
              {sheet.documents === 1 ? "" : "s"} have to go somewhere.
            </>
          }
          onClose={() => setSheet(undefined)}
        >
          <SheetActions
            actions={[
              {
                id: "parent",
                label: parent === "" ? "Move them to Root" : `Move them to ${parent}`,
                hint: "One path splice per document; nothing is deleted.",
                run: () => deleteFolder(sheet.path, "parent"),
              },
              {
                id: "trash",
                label: "Move them to Trash",
                hint: "Restorable for 30 days, like any deleted document.",
                danger: true,
                run: () => deleteFolder(sheet.path, "trash"),
              },
            ]}
          />
        </Sheet>
      );
    }

    const target = sheet.target;
    const actions =
      target.kind === "folder"
        ? [
            {
              id: "open",
              label: "Show this folder",
              run: () => {
                setSheet(undefined);
                onSelectFolder(target.path);
              },
            },
            {
              id: "new-document",
              label: "New document here",
              run: () => {
                setSheet(undefined);
                onNewDocumentHere(target.path);
              },
            },
            {
              id: "new-folder",
              label: "New folder inside",
              run: () => {
                setSheet(undefined);
                revealFolder(target.path);
                setEdit({ kind: "create", parent: target.path });
              },
            },
            {
              id: "rename",
              label: "Rename",
              run: () => {
                setSheet(undefined);
                setEdit({ kind: "rename", path: target.path });
              },
            },
            {
              id: "move",
              label: "Move to…",
              run: () => setSheet({ kind: "move", target }),
            },
            {
              id: "delete",
              label: "Delete folder",
              danger: true,
              run: () => {
                setSheet(undefined);
                startDelete(target.path);
              },
            },
          ]
        : [
            {
              id: "open",
              label: "Open",
              run: () => {
                setSheet(undefined);
                onOpenDocument(target.id);
              },
            },
            {
              id: "move",
              label: "Move to…",
              hint: target.path === "" ? "Currently at root" : `Currently in ${target.path}`,
              run: () => setSheet({ kind: "move", target }),
            },
          ];

    return (
      <Sheet title={labelOf(target)} onClose={() => setSheet(undefined)}>
        <SheetActions actions={actions} />
      </Sheet>
    );
  };

  if (loading) {
    return (
      <p className="folders-empty m-0 flex flex-col gap-1 text-[0.85em] text-text-muted" role="status">
        Loading folders…
      </p>
    );
  }

  return (
    <div className="folders flex flex-col gap-0.5 font-sans text-text">
      {error && (
        <p className="folders-error m-0 rounded border border-danger p-1.5 text-[0.9em]" role="alert">
          {error}
        </p>
      )}
      {problem && (
        <p className="folders-error m-0 rounded border border-danger p-1.5 text-[0.9em]" role="alert">
          {problem}{" "}
          {retry && (
            <button type="button" className="folders-retry min-h-[calc(var(--lm-tap-target)-12px)] cursor-pointer rounded border border-border-strong bg-bg-raised px-1.5 font-sans" onClick={retry.run}>
              Try again
            </button>
          )}
        </p>
      )}
      {progress && (
        <p className="folders-progress m-0 rounded border border-border p-1.5 text-[0.9em] text-text-muted" role="status">
          Moving documents… {progress.done} of {progress.total}
        </p>
      )}

      {visible.length === 0 && edit === undefined ? (
        <div className="folders-empty m-0 flex flex-col gap-1 text-[0.85em] text-text-muted">
          <p>No documents yet.</p>
        </div>
      ) : (
        <div
          className={`folders-tree flex min-h-[calc(var(--lm-tap-target)*1.5)] flex-col pb-3 [--folders-indent:calc(var(--lm-space)*1.5)] [--folders-indent-cap:6] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus compact:[--folders-indent:calc(var(--lm-space)*0.75)] compact:[--folders-indent-cap:4] ${dropTarget === "" ? " folders-tree-root-drop rounded outline-2 outline-dashed outline-accent outline-offset-[-2px]" : ""}`}
          role="tree"
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
            if (event.target === event.currentTarget) dragOverFolder(event, "", false);
          }}
          onDrop={(event) => {
            if (event.target === event.currentTarget) dropOnFolder(event, "");
          }}
          {...(active !== undefined
            ? { "aria-activedescendant": `folders-row-${visible.findIndex((row) => row.key === active)}` }
            : {})}
        >
          {rowElements}
          {dragging ? (
            // Only while dragging, and pinned to the bottom of whatever part of the
            // tree is on screen: the "move to root" target is reachable no matter how
            // tall the tree has grown (a document leaves its folder; a folder becomes
            // top-level).
            <div
              className={`folders-root-dropzone sticky bottom-0 z-[1] mt-0.5 rounded border border-dashed border-border-strong bg-bg-raised p-1.5 text-center text-[0.85rem] text-text-muted ${dropTarget === "" ? " folders-node-drop outline-2 outline-dashed outline-accent outline-offset-[-2px]" : ""}`}
              onDragOver={(event) => dragOverFolder(event, "", false)}
              onDragLeave={() =>
                setDropTarget((current) => (current === "" ? undefined : current))
              }
              onDrop={(event) => dropOnFolder(event, "")}
            >
              Drop here to move to root
            </div>
          ) : null}
        </div>
      )}

      {/*
        Two hints, and the device decides which one is true. Describing a drag to a
        screen that cannot drag (HTML5 drag and drop does not fire from touch) was three
        sentences about gestures the reader does not have.
      */}
      <p className="folders-hint m-0 text-[0.85em] text-text-muted [&_code]:font-mono">
        {touchOnly ? (
          <>
            Long-press a row to move, rename or delete it. Moving a folder rewrites{" "}
            <code>path</code> in every document inside it.
          </>
        ) : (
          <>
            Drag a document or a folder onto another folder — or onto Root — to move it.{" "}
            F2 renames; <span aria-hidden="true">⋯</span> or M moves. Moving a folder rewrites <code>path</code> in every document inside
            it.
          </>
        )}
      </p>

      {renderSheet()}
    </div>
  );
}

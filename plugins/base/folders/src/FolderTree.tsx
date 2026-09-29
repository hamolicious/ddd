/**
 * The file tree, in the sidebar.
 *
 * **Every row is a note.** A note that lists children (`hierarchy.ts`) has a chevron and
 * is a folder; one that lists none is a leaf. Clicking a row opens the note; the chevron
 * opens and closes it. The model is `tree.ts`; this file draws it and owns the gestures.
 *
 * **Every move is a list splice.** Dropping a note on another files it last under that
 * one; dropping it on the top or bottom edge of a row puts it before or after that row,
 * under the same parent; dropping it on the root takes it out of every list. The writes
 * are `index.tsx`'s (one `sectionList` action per note touched), so two devices moving
 * notes into the same folder at once both land.
 *
 * **Three ways to do everything, because one of them is a mouse gesture.** Dragging is
 * a mouse and pen gesture, so every drag has a keyboard and a touch equivalent that ends
 * in the same call: the row's ⋯ button (not on a phone), a long-press, a right-click, or
 * `M` on the active row opens a `context-menu` with Move / Rename / Delete in it.
 *
 * **A drag lifts the row.** The tree's own drags are pointer-driven, not HTML5: the
 * browser draws an HTML5 drag as a translucent ghost that no style can make solid, and a
 * row should look picked up — an opaque, shadowed, slightly tilted copy under the
 * pointer, with a faded slot where it came from. HTML5 drops are still accepted, for rows
 * other plugins make draggable (`doc-list`): their payload is a plain `text/plain` id.
 *
 * **Keyboard-operable, as a real tree.** `role="tree"` with one tab stop and
 * `aria-activedescendant`: Arrow keys move and expand, `Home`/`End` jump, `Enter` opens,
 * `Shift+→`/`Shift+←` expand or collapse a note and everything inside it, `F2` renames,
 * `M` moves, `Delete` deletes. The active row's actions are the one thing Tab may enter.
 *
 * **Virtual, in a box of its own.** Only the rows on screen are in the DOM
 * (`_shared/virtual-list.ts`), so a tree of thousands of notes costs what a screenful
 * does, and every child of every note is drawn — no "N more" row. The tree scrolls inside
 * the Folders panel, in a box that ends at the bottom of the sidebar. Anything that moves the active
 * row — a key, the open note, a rename — scrolls it into view, which is also what draws
 * it, so `aria-activedescendant` never points at a row that is not there.
 *
 * **No `window.prompt` anywhere.** Renaming is an inline field in the row it renames: the
 * Flutter shell pins no `onJsPrompt` handler, so on a phone a prompt may do nothing.
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

import type { ConfirmRequest, ContextMenu, MenuItem } from "@protocols/lm/context-menu";

import { useFitToScreen, useVirtualList } from "../../_shared/virtual-list.js";

import { ancestorsOf, isWithin, type Hierarchy } from "./hierarchy.js";
import { MovePicker } from "./MovePicker.js";
import { placeAmong, pruneOrder } from "./order.js";
import { buildFileTree, type NoteTreeRow, type TreeRow } from "./tree.js";

/** The drag type a draggable note row elsewhere should set: the note's id. */
export const DOCUMENT_DRAG_TYPE = "text/plain";

/** How long a collapsed note must be hovered during a drag before it opens. */
const AUTO_EXPAND_MS = 650;
/** How long a touch must rest on a row before the sheet opens. */
const LONG_PRESS_MS = 500;
/** A touch that travels this far was a scroll, not a press. */
const LONG_PRESS_SLOP = 12;
/** A mouse press that travels this far is a drag, not a click. */
const DRAG_THRESHOLD = 5;
/** The least the tree's scroll box shrinks to when the sidebar is crowded, in pixels. */
const MIN_TREE_HEIGHT = 160;
/** The top and bottom share of a row that mean "before" / "after" rather than "into". */
const EDGE = 0.3;

/** Where a drag would land. `target` is the row a before/after is relative to. */
type Drop =
  | { readonly mode: "into"; readonly parent: string }
  | { readonly mode: "before" | "after"; readonly parent: string; readonly target: string };

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
const ACTIONS_CLASSES =
  "folders-actions folders:invisible folders:flex folders:shrink-0 folders:gap-0.5 folders:group-hover:visible folders:group-focus-within:visible folders:compact:visible folders:[&>button]:box-border folders:[&>button]:min-h-[1.375rem] folders:[&>button]:min-w-[1.375rem] folders:[&>button]:cursor-pointer folders:[&>button]:rounded folders:[&>button]:border folders:[&>button]:border-transparent folders:[&>button]:bg-transparent folders:[&>button]:p-0 folders:[&>button]:text-text-muted folders:hover:[&>button]:border-border folders:hover:[&>button]:text-text folders:compact:[&>button]:min-h-[var(--lm-tap-target)] folders:compact:[&>button]:min-w-[var(--lm-tap-target)] folders:touch:visible folders:touch:[&>button]:min-h-[var(--lm-tap-target)] folders:touch:[&>button]:min-w-[var(--lm-tap-target)]";

export interface MoveProgress {
  readonly onProgress?: (done: number, total: number) => void;
}

/** An action asked for from outside the panel (a command, a keybinding). */
export type TreeRequest =
  /** Expand or collapse a note and every note inside it; `""` is the whole tree. */
  | { readonly kind: "fold"; readonly id: string; readonly expanded: boolean }
  | { readonly kind: "rename"; readonly target: TreeTarget }
  | { readonly kind: "delete"; readonly target: TreeTarget }
  | { readonly kind: "move"; readonly target: TreeTarget };

/** What a sheet, a drag or a key is acting on. */
export interface TreeTarget {
  readonly id: string;
  readonly title: string;
}

export interface FolderTreeProps {
  /** The `menu` port (`lm/context-menu`): every sheet this tree opens goes through it. */
  readonly menu: Pick<ContextMenu, "open" | "openSheet" | "confirm" | "close">;
  readonly hierarchy: Hierarchy;
  readonly loading: boolean;
  readonly error?: string;
  /** Collapsed note ids; persisted by the caller (per user, through settings). */
  readonly collapsed: ReadonlySet<string>;
  readonly onCollapsedChange: (next: ReadonlySet<string>) => void;
  /** The user's order for root notes (`order.ts`), and how to store a new one. */
  readonly rootOrder: readonly string[];
  readonly onRootOrder: (next: readonly string[]) => Promise<void>;
  /**
   * Commands arriving from outside the panel — the palette's "Move this note…" and the
   * keybindings on it. Subscribing rather than prop-drilling one flag per action keeps
   * the panel the only place that knows what a dialog looks like, and it works with the
   * drawer shut: the sheet is a portal into `document.body`.
   */
  readonly requests?: (listener: (request: TreeRequest) => void) => () => void;
  /** File `id` under `parent` (`""`: the root), before `before` or last. */
  readonly onMove: (id: string, parent: string, before?: string) => Promise<void>;
  readonly onRename: (id: string, title: string) => Promise<void>;
  /** `parent` moves its children up a level; `trash` sends them to Trash with it. */
  readonly onDelete: (id: string, mode: "parent" | "trash", options?: MoveProgress) => Promise<number>;
  /** A new note, filed last under `parent`. */
  readonly onNewNoteInside: (parent: string) => void;
  readonly onOpen: (id: string) => void;
  /**
   * The note open in the main view, however it was opened — a link, the graph, the
   * palette. The tree expands the notes above it, makes it the active row and scrolls it
   * into view, once each time it changes.
   */
  readonly openDocument?: string;
  /** Another plugin's colour and icon for a row (`lm/folders.decoration`). */
  readonly look?: (id: string) => FolderRowLook | undefined;
  /** Other plugins' entries for a row's menu (`lm/folders.menu-item`), before "Delete". */
  readonly extraActions?: (id: string, anchor?: HTMLElement) => readonly MenuItem[];
}

/**
 * How a row is dressed: `icon` is drawn before the name, both in `color`, on a pill
 * of `background`.
 */
export interface FolderRowLook {
  readonly background?: string;
  readonly color?: string;
  readonly icon?: ReactElement;
}

type SheetState =
  | { readonly kind: "actions"; readonly target: TreeTarget; readonly anchor?: HTMLElement }
  | { readonly kind: "move"; readonly target: TreeTarget }
  | { readonly kind: "delete"; readonly target: TreeTarget; readonly inside: number }
  /** The "are you sure?" every delete ends in, whatever was chosen before it. */
  | { readonly kind: "confirm"; readonly action: DeleteAction };

interface DeleteAction {
  readonly target: TreeTarget;
  readonly mode: "parent" | "trash";
  /** Notes anywhere below it. */
  readonly inside: number;
  /** Where "parent" moves them, as a title; `undefined` for the root. */
  readonly parentTitle?: string;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export function FolderTree({
  menu,
  hierarchy,
  loading,
  error,
  collapsed,
  onCollapsedChange,
  rootOrder,
  onRootOrder,
  requests,
  onMove,
  onRename,
  onDelete,
  onNewNoteInside,
  onOpen,
  openDocument,
  look,
  extraActions,
}: FolderTreeProps): ReactElement {
  /*
   * Notes opened only to reveal the open document. Shown open, never stored: opening a
   * note is not a change, and writing `collapsedFolders` for it made every open inside a
   * closed folder a settings write — a "Saving 1 change…" on a note nobody had touched.
   * The first expand or collapse the user makes stores what is on screen and clears it.
   */
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const shown = useMemo(
    () => (opened.size === 0 ? collapsed : new Set([...collapsed].filter((id) => !opened.has(id)))),
    [collapsed, opened],
  );
  const changeCollapsed = useCallback(
    (next: ReadonlySet<string>) => {
      setOpened(new Set());
      onCollapsedChange(next);
    },
    [onCollapsedChange],
  );
  const tree = useMemo(
    () => buildFileTree(hierarchy, { collapsed: shown, rootOrder }),
    [shown, hierarchy, rootOrder],
  );
  const visible = tree.rows;
  const virtual = useVirtualList({
    count: visible.length,
    keyOf: (index) => visible[index]?.key ?? String(index),
    estimate: 24,
  });
  const scrollToRow = virtual.scrollToIndex;
  // The tree scrolls in a box of its own, ending at the bottom of the sidebar, so the
  // panels around it stay put while it scrolls.
  const [scrollBox, setScrollBox] = useState<HTMLDivElement | null>(null);
  const boxHeight = useFitToScreen(scrollBox, MIN_TREE_HEIGHT);

  const [active, setActive] = useState<string | undefined>(undefined);
  const [drop, setDrop] = useState<Drop | undefined>(undefined);
  const [lift, setLift] = useState<Lift | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>(undefined);
  const [retry, setRetry] = useState<{ run: () => void } | undefined>(undefined);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [sheet, setSheet] = useState<SheetState | undefined>(undefined);

  const autoExpand = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const longPress = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | undefined>(
    undefined,
  );
  /** A long-press already acted; the click that follows it must not act again. */
  const pressHandled = useRef(false);

  const titleOf = useCallback((id: string): string => hierarchy.notes.get(id)?.title ?? "Untitled", [hierarchy]);
  const parentOf = useCallback((id: string): string => hierarchy.parentOf.get(id) ?? "", [hierarchy]);

  // Reveal the open note: once per note, as soon as its row has arrived (on a cold start
  // the tree can be drawn before the projection has it).
  const revealed = useRef<string | undefined>(undefined);
  const scrollPending = useRef(false);
  useEffect(() => {
    if (openDocument === undefined || revealed.current === openDocument) return;
    if (!hierarchy.notes.has(openDocument)) return;
    revealed.current = openDocument;
    const closed = ancestorsOf(hierarchy, openDocument).filter((id) => shown.has(id));
    if (closed.length > 0) setOpened((previous) => new Set([...previous, ...closed]));
    setActive(`n:${openDocument}`);
    scrollPending.current = true;
  }, [shown, hierarchy, openDocument]);

  useEffect(() => {
    if (!scrollPending.current || active !== `n:${openDocument}`) return;
    const index = visible.findIndex((row) => row.key === active);
    if (index < 0) return;
    scrollPending.current = false;
    scrollToRow(index);
  });

  // A rename can start on a row scrolled out of the DOM (the palette, a keybinding): the
  // field is in the row, so the row has to be drawn.
  useEffect(() => {
    if (renaming === undefined) return;
    const index = visible.findIndex((row) => row.key === `n:${renaming}`);
    if (index >= 0) scrollToRow(index);
    // Once per rename, not again as the rows around it change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming]);

  // An active row that just disappeared (its parent collapsed, it moved) would leave
  // `aria-activedescendant` pointing at nothing.
  useEffect(() => {
    // …except the open note on its way in: its ancestors are opening this same moment.
    if (scrollPending.current && active === `n:${openDocument}`) return;
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
    (id: string, next: boolean) => {
      const updated = new Set(shown);
      if (next) updated.delete(id);
      else updated.add(id);
      changeCollapsed(updated);
    },
    [shown, changeCollapsed],
  );

  /**
   * Expand or collapse `id` and every note below it (`""`: all of them). Collapsing the
   * descendants too is the point: opening the note again later shows them folded.
   */
  const setExpandedDeep = useCallback(
    (id: string, next: boolean) => {
      const updated = new Set(shown);
      const stack = id === "" ? [...(tree.siblings.get("") ?? [])] : [id];
      while (stack.length > 0) {
        const current = stack.pop() as string;
        const children = hierarchy.childrenOf.get(current);
        if (children === undefined) continue;
        if (next) updated.delete(current);
        else updated.add(current);
        stack.push(...children);
      }
      changeCollapsed(updated);
    },
    [shown, hierarchy, changeCollapsed, tree.siblings],
  );

  /** Open everything above `id`, and `id` itself, so a note just moved there shows. */
  const reveal = useCallback(
    (id: string) => {
      if (id === "") return;
      const updated = new Set(shown);
      for (const ancestor of ancestorsOf(hierarchy, id)) updated.delete(ancestor);
      updated.delete(id);
      changeCollapsed(updated);
    },
    [shown, hierarchy, changeCollapsed],
  );

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * One place where a write becomes busy/progress/problem, and where a failure keeps
   * the thing it failed at so it can be run again. A retry re-plans against the live
   * lists, so it writes only what did not land.
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

  /** Into `parent` (last), or next to `target` under `parent`. */
  const place = useCallback(
    (id: string, where: Drop) => {
      if (id === "") return;
      if (where.parent !== "" && isWithin(hierarchy, where.parent, id)) {
        setProblem(`“${titleOf(id)}” cannot go inside itself.`);
        return;
      }
      if (where.mode === "into") {
        if (parentOf(id) === where.parent && where.parent !== "") return;
        run(async () => {
          await onMove(id, where.parent);
          reveal(where.parent);
        });
        return;
      }
      const siblings = tree.siblings.get(where.parent) ?? [];
      if (where.parent === "") {
        // The root has no note to hold a list: its order is this user's setting.
        const placed = placeAmong(siblings, id, where.target, where.mode);
        const stored = pruneOrder(placed, new Set([...(tree.siblings.get("") ?? []), id]));
        run(async () => {
          await onRootOrder(stored);
          if (parentOf(id) !== "") await onMove(id, "");
        });
        return;
      }
      const rest = siblings.filter((sibling) => sibling !== id);
      const at = rest.indexOf(where.target) + (where.mode === "after" ? 1 : 0);
      const before = rest[at];
      run(() => onMove(id, where.parent, before));
    },
    [hierarchy, onMove, onRootOrder, parentOf, reveal, run, titleOf, tree.siblings],
  );

  const commitRename = useCallback(
    (id: string, raw: string) => {
      setRenaming(undefined);
      const title = raw.trim();
      if (title === "" || title === titleOf(id)) return;
      run(() => onRename(id, title));
    },
    [onRename, run, titleOf],
  );

  /** A note with notes inside first asks where they go; every delete ends in a confirm. */
  const startDelete = useCallback(
    (target: TreeTarget) => {
      const inside = hierarchy.childrenOf.get(target.id)?.length ?? 0;
      if (inside === 0) {
        setSheet({ kind: "confirm", action: { target, mode: "trash", inside: 0 } });
        return;
      }
      setSheet({ kind: "delete", target, inside });
    },
    [hierarchy],
  );

  const targetOf = useCallback(
    (id: string): TreeTarget => ({ id, title: titleOf(id) }),
    [titleOf],
  );

  // A command, a keybinding, or anything else outside this panel.
  useEffect(() => {
    if (!requests) return undefined;
    return requests((request) => {
      switch (request.kind) {
        case "fold":
          setExpandedDeep(request.id, request.expanded);
          return;
        case "rename":
          reveal(parentOf(request.target.id));
          setRenaming(request.target.id);
          return;
        case "delete":
          startDelete(request.target);
          return;
        case "move":
          setSheet({ kind: "move", target: request.target });
          return;
        default:
      }
    });
  }, [parentOf, requests, reveal, setExpandedDeep, startDelete]);

  // ---------------------------------------------------------------------------
  // Drag and drop
  // ---------------------------------------------------------------------------

  const cancelAutoExpand = useCallback(() => {
    if (autoExpand.current) clearTimeout(autoExpand.current.timer);
    autoExpand.current = undefined;
  }, []);

  // Whether a drag from this tree is in flight — it gates the sticky root drop strip,
  // which has to be *rendered* state.
  const [dragging, setDragging] = useState(false);

  const endDrag = useCallback(() => {
    setDragging(false);
    setDrop(undefined);
    setLift(undefined);
    cancelAutoExpand();
  }, [cancelAutoExpand]);

  /**
   * Auto-expand: a drag that rests on a closed note is a user trying to get inside it,
   * and on a phone-sized panel there is no second hand to click with.
   */
  const hoverNote = useCallback(
    (id: string | undefined) => {
      if (id !== undefined && id !== "" && shown.has(id) && hierarchy.childrenOf.has(id)) {
        if (autoExpand.current?.id === id) return;
        cancelAutoExpand();
        autoExpand.current = {
          id,
          timer: setTimeout(() => {
            autoExpand.current = undefined;
            setExpanded(id, true);
          }, AUTO_EXPAND_MS),
        };
      } else {
        cancelAutoExpand();
      }
    },
    [cancelAutoExpand, shown, hierarchy, setExpanded],
  );

  /** What lies under the pointer, as a drop for `source`. `undefined` where it may not land. */
  const dropAt = useCallback(
    (x: number, y: number, source: string): Drop | undefined => {
      const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-kind]");
      if (!element) return undefined;
      const kind = element.dataset["dropKind"];
      if (kind === "root") return { mode: "into", parent: "" };
      const id = element.dataset["dropId"] ?? "";
      if (id === source) return undefined;
      const box = element.getBoundingClientRect();
      const share = (y - box.top) / Math.max(1, box.height);
      const where = share < EDGE ? "before" : share > 1 - EDGE ? "after" : undefined;
      if (where) {
        const parent = parentOf(id);
        return parent === "" || !isWithin(hierarchy, parent, source)
          ? { mode: where, parent, target: id }
          : undefined;
      }
      return isWithin(hierarchy, id, source) ? undefined : { mode: "into", parent: id };
    },
    [hierarchy, parentOf],
  );

  /** Read by the window listeners of a drag in flight, so they never act on stale state. */
  const latest = useRef({ dropAt, hoverNote, place });
  latest.current = { dropAt, hoverNote, place };

  const liftStart = useCallback(
    (event: ReactPointerEvent<HTMLElement>, target: TreeTarget) => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      // The row's own controls keep their clicks; a field being typed in is not a handle.
      if ((event.target as HTMLElement).closest(".folders-actions, .folders-twisty, input")) return;
      const box = event.currentTarget.getBoundingClientRect();
      const start = { x: event.clientX, y: event.clientY };
      let lifted = false;
      let last: Drop | undefined;

      const at = (x: number, y: number): void => {
        setLift({ target, x, y, dx: start.x - box.left, dy: start.y - box.top, width: box.width });
        last = latest.current.dropAt(x, y, target.id);
        setDrop(last);
        latest.current.hoverNote(last?.mode === "into" ? last.parent : undefined);
      };
      const onMove = (moveEvent: PointerEvent): void => {
        if (!lifted) {
          if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < DRAG_THRESHOLD) return;
          lifted = true;
          setDragging(true);
          document.body.style.setProperty("user-select", "none");
          document.body.style.setProperty("cursor", "grabbing");
          window.getSelection()?.removeAllRanges();
        }
        at(moveEvent.clientX, moveEvent.clientY);
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
        if (landed && last) latest.current.place(target.id, last);
      };
      const onUp = (upEvent: PointerEvent): void => {
        if (lifted) last = latest.current.dropAt(upEvent.clientX, upEvent.clientY, target.id);
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

  const dragOver = useCallback(
    (event: ReactDragEvent, parent: string) => {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setDrop({ mode: "into", parent });
      hoverNote(parent);
    },
    [hoverNote],
  );

  const dropInto = useCallback(
    (event: ReactDragEvent, parent: string) => {
      event.preventDefault();
      event.stopPropagation();
      endDrag();
      place(event.dataTransfer.getData(DOCUMENT_DRAG_TYPE).trim(), { mode: "into", parent });
    },
    [endDrag, place],
  );

  const leave = useCallback((parent: string) => {
    setDrop((current) => (current?.mode === "into" && current.parent === parent ? undefined : current));
  }, []);

  /** The note an "into" drop is outlining, if any (`""`: the root). */
  const intoNote = drop?.mode === "into" ? drop.parent : undefined;

  // ---------------------------------------------------------------------------
  // Long press → the sheet
  // ---------------------------------------------------------------------------

  const openActions = useCallback((target: TreeTarget, anchor?: HTMLElement) => {
    setActive(`n:${target.id}`);
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
      if (Math.abs(event.clientX - press.x) > LONG_PRESS_SLOP || Math.abs(event.clientY - press.y) > LONG_PRESS_SLOP) {
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

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (visible.length === 0 || renaming !== undefined) return;
      const index = visible.findIndex((row) => row.key === active);
      const row: TreeRow | undefined = index >= 0 ? visible[index] : undefined;
      const note = row?.kind === "note" ? row : undefined;
      const go = (next: number): void => {
        event.preventDefault();
        const at = Math.max(0, Math.min(visible.length - 1, next));
        setActive(visible[at]?.key);
        scrollToRow(at);
      };

      switch (event.key) {
        case "ArrowDown":
          go(index + 1);
          return;
        case "ArrowUp":
          go(index < 0 ? 0 : index - 1);
          return;
        case "Home":
          go(0);
          return;
        case "End":
          go(visible.length - 1);
          return;
        case "ArrowRight":
          if (event.shiftKey && note?.expandable) {
            event.preventDefault();
            setExpandedDeep(note.id, true);
          } else if (note?.expandable && !note.expanded) {
            event.preventDefault();
            setExpanded(note.id, true);
          } else if (note?.expandable) {
            go(index + 1);
          }
          return;
        case "ArrowLeft": {
          if (!row) return;
          event.preventDefault();
          if (event.shiftKey && note?.expandable) {
            setExpandedDeep(note.id, false);
            return;
          }
          if (note?.expandable && note.expanded) {
            setExpanded(note.id, false);
            return;
          }
          const parent = visible.findIndex((other) => other.key === `n:${row.parent}`);
          if (parent >= 0) go(parent);
          return;
        }
        case "Enter":
          if (note) {
            event.preventDefault();
            onOpen(note.id);
          }
          return;
        case "F2":
          if (note) {
            event.preventDefault();
            setRenaming(note.id);
          }
          return;
        case "Delete":
          if (note) {
            event.preventDefault();
            startDelete(targetOf(note.id));
          }
          return;
        case "m":
        case "M":
          // The keyboard half of a drag. Named in the hint, because a shortcut nobody is
          // told about is the same as no shortcut.
          if (note) {
            event.preventDefault();
            setSheet({ kind: "move", target: targetOf(note.id) });
          }
          return;
        default:
      }
    },
    [active, onOpen, renaming, setExpanded, setExpandedDeep, startDelete, targetOf, scrollToRow, visible],
  );

  // ---------------------------------------------------------------------------
  // Rows
  // ---------------------------------------------------------------------------

  const renameField = (row: NoteTreeRow): ReactElement => (
    <>
      <input
        className="folders-rename folders:tap-h folders:min-w-0 folders:flex-1 folders:rounded folders:border folders:border-accent folders:bg-bg-raised folders:px-1 folders:font-sans folders:text-text"
        type="text"
        autoFocus
        defaultValue={row.title}
        aria-label={`Rename ${row.title}`}
        onKeyDown={(event) => {
          // The tree's own key handling would read this as navigation.
          event.stopPropagation();
          if (event.key === "Enter") commitRename(row.id, event.currentTarget.value);
          else if (event.key === "Escape") setRenaming(undefined);
        }}
      />
      <span className={`${ACTIONS_CLASSES} folders-actions-edit folders:visible`}>
        <button
          type="button"
          aria-label="Save"
          title="Save"
          onClick={(event) => {
            const field = event.currentTarget.closest(".folders-node")?.querySelector<HTMLInputElement>(".folders-rename");
            commitRename(row.id, field?.value ?? "");
          }}
        >
          ✓
        </button>
        <button type="button" aria-label="Cancel" title="Cancel" onClick={() => setRenaming(undefined)}>
          ✕
        </button>
      </span>
    </>
  );

  const rowElements: ReactElement[] = visible.slice(virtual.first, virtual.end).map((row, offset) => {
    const index = virtual.first + offset;
    const common = {
      id: `folders-row-${index}`,
      "data-virtual-index": index,
      role: "treeitem" as const,
      "aria-level": row.depth + 1,
      "aria-selected": row.key === active,
      style: { "--folders-depth": row.depth } as CSSProperties,
    };
    const isActive = row.key === active;

    const target: TreeTarget = { id: row.id, title: row.title };
    const editing = renaming === row.id;
    const dressed = look?.(row.id);
    return (
      <div
        key={row.key}
        {...common}
        {...(row.expandable ? { "aria-expanded": row.expanded } : {})}
        className={[
          NODE_CLASSES,
          "folders:cursor-pointer",
          isActive ? "folders-node-active folders:bg-accent-subtle" : "",
          row.id === intoNote
            ? "folders-node-drop folders:outline-2 folders:outline-dashed folders:outline-accent folders:outline-offset-[-2px]"
            : "",
          drop?.mode === "before" && drop.target === row.id
            ? "folders-node-before folders:shadow-[inset_0_2px_0_0_var(--lm-accent)]"
            : "",
          drop?.mode === "after" && drop.target === row.id
            ? "folders-node-after folders:shadow-[inset_0_-2px_0_0_var(--lm-accent)]"
            : "",
          lift?.target.id === row.id ? "folders-node-lifted folders:bg-bg-subtle folders:[&>*]:opacity-40" : "",
          editing ? "folders-node-editing" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={row.title}
        data-drop-kind="note"
        data-drop-id={row.id}
        onDragOver={(event) => dragOver(event, row.id)}
        onDragLeave={() => leave(row.id)}
        onDrop={(event) => dropInto(event, row.id)}
        onMouseDown={() => setActive(row.key)}
        onPointerDown={(event) => {
          pressStart(event, target);
          if (!editing) liftStart(event, target);
        }}
        onPointerMove={pressMove}
        onPointerUp={cancelLongPress}
        onPointerCancel={cancelLongPress}
        onContextMenu={(event) => {
          event.preventDefault();
          openActions(target);
        }}
        onClick={() => {
          if (consumePress() || editing) return;
          setActive(row.key);
          onOpen(row.id);
        }}
      >
        {row.expandable ? (
          <button
            type="button"
            className={TWISTY_CLASSES}
            tabIndex={-1}
            aria-label={row.expanded ? `Collapse ${row.title}` : `Expand ${row.title}`}
            title="Alt-click to include every note inside"
            onClick={(event) => {
              event.stopPropagation();
              // Alt (Option) or Shift: the note and everything under it, as in VS Code.
              if (event.altKey || event.shiftKey) setExpandedDeep(row.id, !row.expanded);
              else setExpanded(row.id, !row.expanded);
            }}
          >
            {row.expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className={TWISTY_CLASSES} aria-hidden="true" />
        )}

        {editing ? (
          renameField(row)
        ) : (
          <>
            <span className={`folders-name ${ROW_LABEL_CLASSES}`}>
              {dressed === undefined ? row.title : <Dressed look={dressed} name={row.title} />}
            </span>
            {row.expandable && (
              <span
                className="folders-count folders:shrink-0 folders:text-[0.8em] folders:tabular-nums folders:text-text-muted"
                aria-label={`${row.descendants} notes inside`}
              >
                {row.descendants}
              </span>
            )}
            {/*
             * The row actions are the one part of this tree that Tab may enter: the tree
             * is a roving-tabindex widget, so only the *active* row's buttons become a
             * tab stop — the row that shows its buttons is the row whose buttons Tab
             * reaches.
             *
             * "Note actions", not "Actions for <title>": the row is a `treeitem` whose
             * accessible name is already the title, and a label that contained it would
             * make every "the row called X" query ambiguous with `doc-list`'s row.
             *
             * Not on a phone: there the long-press opens the same menu, and the row's
             * width is worth more to the title than to a button.
             */}
            <span className={`${ACTIONS_CLASSES} folders:compact:hidden ${isActive ? "folders:visible" : ""}`}>
              <button
                type="button"
                tabIndex={isActive ? 0 : -1}
                aria-label="Note actions"
                title={`Move, rename or delete ${row.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  openActions(target, event.currentTarget);
                }}
              >
                ⋯
              </button>
            </span>
          </>
        )}
      </div>
    );
  });

  // ---------------------------------------------------------------------------
  // The sheet
  // ---------------------------------------------------------------------------

  // Every sheet goes through `context-menu`. Opened when `sheet` changes (not on every
  // render: replacing an open menu closes the previous one, which would clear `sheet`).
  //
  // `menu.close()` only when the tree dropped its own sheet. When the menu closed itself
  // it is already shut, and the menu or sheet open now may be someone else's: an entry
  // from `lm/folders.menu-item` opens its own sheet as the actions menu closes, and
  // closing again here would shut that one.
  const closedByMenu = useRef(false);
  useEffect(() => {
    const byMenu = closedByMenu.current;
    closedByMenu.current = false;
    if (!sheet) {
      if (!byMenu) menu.close();
      return;
    }
    const onClose = (): void => {
      closedByMenu.current = true;
      setSheet(undefined);
    };

    if (sheet.kind === "move") {
      const target = sheet.target;
      menu.openSheet({
        title: `Move ${target.title} to…`,
        onClose,
        render: () => (
          <MovePicker
            hierarchy={hierarchy}
            subjects={[target]}
            onChoose={(parent) => {
              setSheet(undefined);
              place(target.id, { mode: "into", parent });
            }}
          />
        ),
      });
      return;
    }

    if (sheet.kind === "delete") {
      const { target, inside } = sheet;
      const parent = parentOf(target.id);
      const parentTitle = parent === "" ? undefined : titleOf(parent);
      const everything = [target.id];
      for (let i = 0; i < everything.length; i += 1) {
        everything.push(...(hierarchy.childrenOf.get(everything[i] as string) ?? []));
      }
      menu.open({
        title: `Delete ${target.title}?`,
        description: `It has ${inside} note${inside === 1 ? "" : "s"} inside.`,
        onClose,
        sections: [
          {
            items: [
              {
                id: "parent",
                label: parentTitle === undefined ? "Keep them, at the root" : `Keep them, in ${parentTitle}`,
                hint: "Only this note goes to Trash.",
                run: () =>
                  setSheet({
                    kind: "confirm",
                    action: { target, mode: "parent", inside, ...(parentTitle !== undefined ? { parentTitle } : {}) },
                  }),
              },
              {
                id: "trash",
                label: "Delete them too",
                hint: "Restorable from Trash for 30 days.",
                danger: true,
                run: () =>
                  setSheet({ kind: "confirm", action: { target, mode: "trash", inside: everything.length - 1 } }),
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
        run(() => onDelete(action.target.id, action.mode, { onProgress }));
      });
      return () => {
        live = false;
      };
    }

    const target = sheet.target;
    const expandable = hierarchy.childrenOf.has(target.id);
    const items: MenuItem[] = [
      { id: "open", label: "Open", run: () => onOpen(target.id) },
      { id: "new-note", label: "New note inside", run: () => onNewNoteInside(target.id) },
      ...(expandable
        ? [
            { id: "expand-all", label: "Expand all inside", run: () => setExpandedDeep(target.id, true) },
            { id: "collapse-all", label: "Collapse all inside", run: () => setExpandedDeep(target.id, false) },
          ]
        : []),
      { id: "rename", label: "Rename", run: () => setRenaming(target.id) },
      {
        id: "move",
        label: "Move to…",
        hint: parentOf(target.id) === "" ? "Now at the root" : `Now in ${titleOf(parentOf(target.id))}`,
        run: () => setSheet({ kind: "move", target }),
      },
      ...(extraActions?.(target.id, sheet.anchor) ?? []),
      { id: "delete", label: "Delete", danger: true, run: () => startDelete(target) },
    ];
    menu.open({
      title: target.title,
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
        Loading notes…
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
          Deleting notes… {progress.done} of {progress.total}
        </p>
      )}

      {visible.length === 0 ? (
        <div className="folders-empty folders:m-0 folders:flex folders:flex-col folders:gap-1 folders:text-[0.85em] folders:text-text-muted">
          <p>No notes yet.</p>
        </div>
      ) : (
        <div
          ref={setScrollBox}
          className="folders-scroll folders:overflow-y-auto folders:overscroll-contain"
          style={boxHeight === undefined ? undefined : { maxHeight: boxHeight }}
        >
          <div
            className={`folders-tree folders:flex folders:min-h-[calc(var(--lm-tap-target)*1.5)] folders:flex-col folders:[--folders-indent:calc(var(--lm-space)*1.5)] folders:[--folders-indent-cap:6] folders:focus-visible:outline-2 folders:focus-visible:outline-offset-[-2px] folders:focus-visible:outline-focus folders:compact:[--folders-indent:calc(var(--lm-space)*0.75)] folders:compact:[--folders-indent-cap:4] ${intoNote === "" ? " folders-tree-root-drop folders:rounded folders:outline-2 folders:outline-dashed folders:outline-accent folders:outline-offset-[-2px]" : ""}`}
            ref={virtual.listRef}
            // The rows not drawn, and the room under the last one (`pb-3`, which an
            // inline padding would otherwise replace).
            style={{ paddingTop: virtual.before, paddingBottom: `calc(${virtual.after}px + 0.75rem)` }}
            role="tree"
            // Blank space in the tree is the root, the way it is in every file manager.
            data-drop-kind="root"
            aria-label="Folders"
            aria-busy={busy}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onFocus={() => {
              if (active === undefined) setActive(visible[0]?.key);
            }}
            // `currentTarget` only: a drop a row *refused* (a note onto its own
            // descendant) must not fall through to the root and move it somewhere nobody
            // asked for.
            onDragOver={(event) => {
              if (event.target === event.currentTarget) dragOver(event, "");
            }}
            onDrop={(event) => {
              if (event.target === event.currentTarget) dropInto(event, "");
            }}
            {...(active !== undefined
              ? { "aria-activedescendant": `folders-row-${visible.findIndex((row) => row.key === active)}` }
              : {})}
          >
            {rowElements}
            {dragging ? (
              // Only while dragging, and pinned to the bottom of whatever part of the tree
              // is on screen: the "move to the root" target is reachable however tall the
              // tree has grown.
              <div
                className={`folders-root-dropzone folders:sticky folders:bottom-0 folders:z-[1] folders:mt-0.5 folders:rounded folders:border folders:border-dashed folders:border-border-strong folders:bg-bg-raised folders:p-1.5 folders:text-center folders:text-[0.85rem] folders:text-text-muted ${intoNote === "" ? " folders-node-drop folders:outline-2 folders:outline-dashed folders:outline-accent folders:outline-offset-[-2px]" : ""}`}
                onDragOver={(event) => dragOver(event, "")}
                data-drop-kind="root"
                onDragLeave={() => leave("")}
                onDrop={(event) => dropInto(event, "")}
              >
                Drop here to move to the root
              </div>
            ) : null}
          </div>
        </div>
      )}
      {lift ? <Lifted lift={lift} /> : null}
    </div>
  );
}

const plural = (count: number): string => `${count} note${count === 1 ? "" : "s"}`;

/** The last question before a delete goes through. */
function confirmRequest(action: DeleteAction): ConfirmRequest {
  const title = action.target.title;
  if (action.inside === 0) {
    return {
      title: `Delete “${title}”?`,
      description: "It goes to Trash, where it can be restored for 30 days.",
      confirmLabel: "Move to Trash",
      danger: true,
    };
  }
  if (action.mode === "trash") {
    return {
      title: `Delete “${title}” and the ${plural(action.inside)} inside it?`,
      description: "They go to Trash, where they can be restored for 30 days.",
      confirmLabel: "Move to Trash",
      danger: true,
    };
  }
  return {
    title: `Delete “${title}”?`,
    description: `The ${plural(action.inside)} inside it move to ${action.parentTitle ?? "the root"}.`,
    confirmLabel: "Move to Trash",
    danger: true,
  };
}

/**
 * A decorated name: the icon and the name side by side, centred on one line, on a pill
 * when there is a background. One flex box for both is what keeps the icon level with
 * the text, whatever the font's line height.
 */
function Dressed({ look, name }: { readonly look: FolderRowLook; readonly name: string }): ReactElement {
  const pill = look.background !== undefined;
  return (
    <span
      className={`folders-dressed folders:inline-flex folders:max-w-full folders:items-center folders:gap-1 folders:align-middle folders:leading-[1.4] ${pill ? "folders-dressed-pill folders:rounded folders:px-1.5" : ""}`}
      style={{
        ...(look.background !== undefined ? { background: look.background } : {}),
        ...(look.color !== undefined ? { color: look.color } : {}),
      }}
    >
      {look.icon}
      <span className="folders:min-w-0 folders:overflow-hidden folders:text-ellipsis">{name}</span>
    </span>
  );
}

/**
 * The row being carried: opaque, raised and a little tilted, under the pointer where it
 * was grabbed. A portal, because the sidebar's `container-type` would otherwise make it
 * the containing block of anything `position: fixed` inside it.
 */
function Lifted({ lift }: { readonly lift: Lift }): ReactElement {
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
      <span className="folders:min-w-0 folders:flex-1 folders:overflow-hidden folders:text-ellipsis folders:whitespace-nowrap">
        {lift.target.title}
      </span>
    </div>,
    document.body,
  );
}

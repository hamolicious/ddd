/**
 * `folders` — a file tree where every folder is a note (SPEC §6.5).
 *
 * A note's children are listed in its own `%%% folders` section, under `children`, one id
 * per line. Any note can hold children; the parent of a note is whichever note lists it,
 * and a note nobody lists sits at the root. `hierarchy.ts` reads the lists and repairs
 * what they can say that a tree cannot (two parents, a loop); `tree.ts` turns that into
 * rows.
 *
 * **Every write is a list action on one note** (`kernel.documents.splice.sectionList`):
 * filing a note pushes or inserts one line into its new parent and removes one line from
 * its old one. Line-sized writes are what let two devices file notes into the same
 * folder at once and keep both — a whole-list rewrite would keep only the later one. A
 * move touches two notes and is not atomic across them; the new parent is written first,
 * so an interruption leaves the note in two lists (drawn once, repaired by its next move)
 * rather than in none.
 *
 * Only this plugin writes its section, so other plugins file notes through the `folders`
 * service (`lm/folders`): the Obsidian importer, and anything else that makes notes in
 * bulk. A note created through `doc-list` is announced on `lm/document-browser.created`
 * and filed here — under the `parent` its creator asked for, or the default location.
 *
 * ## Per-user state, all of it in settings
 *
 * | Key | What it is |
 * |---|---|
 * | `defaultLocation` | The note new notes are filed in; `""` for the root. |
 * | `fileLocation` | The note new file documents (attachment wrappers) are filed in; `""` for the root. |
 * | `collapsedFolders` | The notes this user closed. The negative is stored so an untouched tree is open. |
 * | `rootOrder` | This user's order for the notes at the root, set by dragging (`order.ts`). |
 *
 * Settings are per user and, as SPEC §6.4 states plainly, readable by other users of the
 * shared workspace. Note ids are not secrets and nothing else is kept here.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { CoreValue, DocumentRow, Kernel, SettingsValue } from "@kernel";
import type { Command } from "@protocols/lm/commands.command";
import type { ContextMenu, MenuItem } from "@protocols/lm/context-menu";
import type { DocumentBrowser } from "@protocols/lm/document-browser";
import type { DocumentCreated } from "@protocols/lm/document-browser.created";
import type { Folders } from "@protocols/lm/folders";
import type { FolderDecoration, FolderLook } from "@protocols/lm/folders.decoration";
import type { FolderMenuItem } from "@protocols/lm/folders.menu-item";
import type { Router } from "@protocols/lm/router";
import type { SettingsSection } from "@protocols/lm/settings.section";
import type { SidebarPanel } from "@protocols/lm/sidebar.panel";

import { BoundedIcon, useSlotEntries } from "../../_shared/boundary.js";
import { EXCLUDE_MACHINE_DOCUMENTS, isMachineDocument } from "../../_shared/machine-docs.js";

import { DefaultLocation } from "./DefaultLocation.js";
import { FolderTree, type FolderRowLook, type MoveProgress, type TreeRequest } from "./FolderTree.js";
import { MovePicker } from "./MovePicker.js";
import {
  CHILDREN_KEY,
  buildHierarchy,
  planMove,
  readChildren,
  titlePath,
  type Hierarchy,
  type ListWrite,
  type NoteRow,
} from "./hierarchy.js";
import { settledMoves, withPendingMoves, type PendingPlace } from "./pending.js";
import { compareText } from "./tree.js";

/** A workspace bigger than this needs paging in the tree; say so rather than truncate quietly. */
const TREE_ROW_LIMIT = 20_000;

/**
 * How many notes a delete sends to Trash at once. Small on purpose: each is a request,
 * and a wide fan-out competes with the user's own edits for the connection.
 */
const DELETE_CONCURRENCY = 6;

/**
 * How long a move is drawn ahead of the projection. The echo normally takes about a
 * second (the server's 500 ms materialization debounce plus the feed); offline, the
 * kernel's own local row lands within a quarter of that.
 */
const PENDING_MOVE_TTL_MS = 15_000;

/** Collapsing a note is a settings splice; a burst of clicks should not be a burst of them. */
const SETTINGS_DEBOUNCE_MS = 400;

export const SETTINGS_KEYS = {
  defaultLocation: "defaultLocation",
  fileLocation: "fileLocation",
  collapsedFolders: "collapsedFolders",
  rootOrder: "rootOrder",
} as const;

/** `#/doc/<id>` → the id, for the commands that act on the note on screen. */
const documentFromRoute = (route: string): string | undefined => {
  const [path] = route.split("?");
  const match = /^\/doc\/([^/]+)$/.exec(path ?? "");
  return match?.[1];
};

/** A settings list of ids, cleaned: strings only, de-duplicated, order kept. */
const readIds = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry === "string" && entry !== "" && !out.includes(entry)) out.push(entry);
  }
  return out;
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

export default function activate(kernel: Kernel): void {
  // Each handle is limited to the port's `needs` in the manifest. `newDocument` rather
  // than `createDocument`: it reports its own failures (offline, above all).
  const docs = kernel.ports.use<Pick<DocumentBrowser, "newDocument">>("browser");
  const router = kernel.ports.use<Pick<Router, "navigate" | "current" | "onChange">>("router");
  const menu = kernel.ports.use<Pick<ContextMenu, "open" | "openSheet" | "confirm" | "close">>("menu");
  // Other plugins' colours and icons for rows, and their entries in a row's menu.
  const decorations = kernel.ports.collect<FolderDecoration>("decorations");
  const actions = kernel.ports.collect<FolderMenuItem>("actions");

  kernel.settings.defineSchema({
    // Rendered by this plugin's own section (a note picker), declared for its default.
    [SETTINGS_KEYS.defaultLocation]: { type: "string", default: "" },
    [SETTINGS_KEYS.fileLocation]: { type: "string", default: "" },
    // Bookkeeping, not preferences: rendered by the tree, declared for their defaults and
    // so a reader of the settings document knows what wrote these lines.
    [SETTINGS_KEYS.collapsedFolders]: { type: "list", default: [] },
    [SETTINGS_KEYS.rootOrder]: { type: "list", default: [] },
  });

  // ---------------------------------------------------------------------------
  // Live state: one subscription, shared by the tree, the settings section and the service
  // ---------------------------------------------------------------------------

  const listeners = new Set<() => void>();
  /** What the projection says — `rows` is this with the moves in flight applied. */
  let projected: readonly NoteRow[] = [];
  let hierarchy: Hierarchy = buildHierarchy([]);
  /** Moves written and not yet echoed by the projection (`pending.ts`). */
  const pendingMoves = new Map<string, PendingPlace>();
  const derive = (): void => {
    for (const id of settledMoves(projected, pendingMoves)) pendingMoves.delete(id);
    hierarchy = buildHierarchy(withPendingMoves(projected, pendingMoves));
  };
  let loading = true;
  let loadError: string | undefined;
  let collapsed: ReadonlySet<string> = new Set(readIds(kernel.settings.get(SETTINGS_KEYS.collapsedFolders)));
  let rootOrder = readIds(kernel.settings.get(SETTINGS_KEYS.rootOrder));
  /** A local order write in flight; adopting the stored value meanwhile would undo it. */
  let orderWriting = 0;

  const publish = (): void => {
    for (const listener of [...listeners]) listener();
  };

  /** Where new documents of a kind go: a note id, or `""` for the root. */
  const locationFor = (kind: "note" | "file"): string => {
    const stored = kernel.settings.get<string>(kind === "file" ? SETTINGS_KEYS.fileLocation : SETTINGS_KEYS.defaultLocation);
    return typeof stored === "string" ? stored.trim() : "";
  };

  /**
   * Every settings write this plugin makes, one at a time. `kernel.settings.set` is a
   * line splice into a document that has to be found (or created) first, and this plugin
   * writes three keys from several places; queueing means it can never be the cause of
   * two writes racing for the same section.
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

  void (async () => {
    try {
      // One live query for the whole tree. **Machine-owned documents are excluded here**
      // (`_shared/machine-docs.ts`), so the tree never offers to move, rename or file into
      // one. That protects what the tree draws; the write path checks again
      // (`refuseMachine`), because ids also arrive from URLs and other plugins' drags.
      const subscription = await kernel.documents.subscribe({
        filter: EXCLUDE_MACHINE_DOCUMENTS,
        limit: TREE_ROW_LIMIT,
      });
      const take = (result: { rows: readonly DocumentRow[] }): void => {
        projected = result.rows.map((row) => ({
          id: row.id,
          title: row.title || "Untitled",
          children: readChildren(row.plugins),
        }));
        derive();
        loading = false;
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
  const writeCollapsed = (): void => {
    collapsedTimer = undefined;
    void writeSetting(SETTINGS_KEYS.collapsedFolders, [...collapsed] as readonly CoreValue[]).catch(
      (cause: unknown) => kernel.log.warn("could not store the collapsed notes", cause),
    );
  };
  const setCollapsed = (next: ReadonlySet<string>): void => {
    collapsed = next;
    publish();
    if (collapsedTimer !== undefined) clearTimeout(collapsedTimer);
    collapsedTimer = setTimeout(writeCollapsed, SETTINGS_DEBOUNCE_MS);
  };
  // Unplugged or restarted mid-debounce: the write happens now rather than never (§6c).
  flushOnStop = () => {
    if (collapsedTimer === undefined) return;
    clearTimeout(collapsedTimer);
    writeCollapsed();
  };

  const setRootOrder = async (next: readonly string[]): Promise<void> => {
    if (sameIds(rootOrder, next)) return;
    rootOrder = next;
    publish();
    orderWriting += 1;
    try {
      await writeSetting(SETTINGS_KEYS.rootOrder, [...next] as readonly CoreValue[]);
    } finally {
      orderWriting -= 1;
    }
  };

  // Settings change under us: another tab, another device, or our own write coming back
  // through sync. Guarded, because this is a convenience, not the feature.
  try {
    kernel.settings.subscribe(() => {
      // A pending local write would be clobbered by adopting the remote value mid-flight.
      if (collapsedTimer === undefined) {
        collapsed = new Set(readIds(kernel.settings.get(SETTINGS_KEYS.collapsedFolders)));
      }
      if (orderWriting === 0) rootOrder = readIds(kernel.settings.get(SETTINGS_KEYS.rootOrder));
      publish();
    });
  } catch (cause) {
    kernel.log.warn("settings changes will not be followed", cause);
  }

  const useStore = (): {
    hierarchy: Hierarchy;
    loading: boolean;
    error?: string;
    collapsed: ReadonlySet<string>;
    rootOrder: readonly string[];
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
      hierarchy,
      loading,
      collapsed,
      rootOrder,
      ...(loadError !== undefined ? { error: loadError } : {}),
    };
  };

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * **The write-path half of `_shared/machine-docs.ts`.** The tree never draws a
   * machine-owned document, but ids reach the write path from elsewhere too — the
   * "Move this note" command takes its id from the URL, a drop reads `text/plain` off a
   * `DataTransfer` any plugin may have filled, and the service takes whatever it is given.
   * Filing the kernel's settings document under a note would put app data in a person's
   * tree, and writing a `%%% folders` section into one would edit text the kernel owns.
   */
  const refuseMachine = async (id: string): Promise<void> => {
    if (id === "") return;
    const row = await kernel.documents.get(id);
    // Only a *positive* answer refuses: a note too new for the projection is movable.
    if (row !== undefined && isMachineDocument(row)) {
      throw new Error("That document is maintained by the app, not by you, and cannot be filed in a folder.");
    }
  };

  const write = (step: ListWrite): Promise<unknown> =>
    kernel.documents.splice.sectionList(
      step.note,
      CHILDREN_KEY,
      step.action === "insert"
        ? { action: "insert", index: step.index, value: step.id }
        : { action: step.action, value: step.id },
    );

  /** Put `id` under `parent` (`""`: the root), before `before` or last. */
  const file = async (id: string, parent: string, before?: string): Promise<void> => {
    await refuseMachine(id);
    await refuseMachine(parent);
    const writes = planMove(hierarchy, id, parent, before);
    if (writes.length === 0) return;
    // Drawn where it is going from now, not a feed round trip from now (`pending.ts`).
    const place: PendingPlace = before === undefined ? { parent } : { parent, before };
    pendingMoves.set(id, place);
    derive();
    publish();
    try {
      for (const step of writes) await write(step);
      // A move the projection never echoes must not be drawn forever: that would hide
      // exactly the lost write it exists to paper over. After the grace period the
      // projection is the truth again, whatever it says.
      setTimeout(() => {
        if (pendingMoves.get(id) !== place) return;
        pendingMoves.delete(id);
        derive();
        publish();
      }, PENDING_MOVE_TTL_MS);
    } catch (cause) {
      // Only if this is still the move on record: a later one owns the entry now.
      if (pendingMoves.get(id) === place) pendingMoves.delete(id);
      derive();
      publish();
      throw cause;
    }
  };

  const rename = async (id: string, title: string): Promise<void> => {
    await refuseMachine(id);
    await kernel.documents.splice.setFrontmatterValue(id, "title", title);
  };

  /**
   * Send a note to Trash. `parent`: its children move up into its place first (spliced
   * into its parent's list where it was, or to the root), and its own list is cleared so
   * restoring it later does not claim them back. `trash`: its whole subtree goes, and
   * every list is left as it is, so restoring them from Trash puts them back in place.
   */
  const remove = async (id: string, mode: "parent" | "trash", options?: MoveProgress): Promise<number> => {
    await refuseMachine(id);
    const children = hierarchy.childrenOf.get(id) ?? [];
    const parent = hierarchy.parentOf.get(id) ?? "";

    let doomed = [id];
    if (mode === "parent") {
      if (parent !== "") {
        const raw = hierarchy.notes.get(parent)?.children ?? [];
        const at = raw.indexOf(id);
        // Before `id`, in order: each insert lands where `id` was, pushing it along.
        for (const [offset, child] of children.entries()) {
          await write({ note: parent, action: "insert", id: child, index: at + offset });
        }
      }
      if (children.length > 0) {
        await kernel.documents.splice.spliceSection(id, [{ key: CHILDREN_KEY, value: null, remove: true }]);
      }
      if (parent !== "") await write({ note: parent, action: "remove", id });
    } else {
      for (let index = 0; index < doomed.length; index += 1) {
        doomed.push(...(hierarchy.childrenOf.get(doomed[index] as string) ?? []));
      }
      doomed = [...doomed.slice(1).reverse(), id];
    }

    // Through a small pool: one failure says nothing about the next, and the tree reports
    // how far it got so "Try again" can finish the rest.
    let done = 0;
    const failures: string[] = [];
    options?.onProgress?.(0, doomed.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(DELETE_CONCURRENCY, doomed.length) }, async () => {
        for (;;) {
          const next = doomed[cursor++];
          if (next === undefined) return;
          try {
            await kernel.documents.delete(next);
          } catch (cause) {
            failures.push(cause instanceof Error ? cause.message : String(cause));
          }
          done += 1;
          options?.onProgress?.(done, doomed.length);
        }
      }),
    );
    if (failures.length > 0) {
      throw new Error(`deleted ${done - failures.length} of ${doomed.length}; ${failures.length} failed: ${failures[0] ?? ""}`);
    }
    // The note on screen went to Trash: show the one it was in, or the list.
    const open = documentFromRoute(router.current());
    if (open !== undefined && doomed.includes(open)) router.navigate(parent === "" ? "/" : `/doc/${parent}`);
    return doomed.length;
  };

  // ---------------------------------------------------------------------------
  // The service (`lm/folders`) and notes made elsewhere
  // ---------------------------------------------------------------------------

  /** Notes `ensurePath` made this session, before the projection has them: `parent \0 title`. */
  const made = new Map<string, Promise<string>>();

  /** A note titled `title`, with nothing else in it, created without opening it. */
  const createNote = async (title: string): Promise<string> => {
    const front = kernel.documents.splice.planFrontmatterValue("", "title", title)[0]?.text ?? "";
    return kernel.documents.create({ text: `${front}\n# ${title.replaceAll("\n", " ")}\n` });
  };

  const ensurePath = async (titles: readonly string[]): Promise<string> => {
    let parent = "";
    for (const raw of titles) {
      const title = raw.trim();
      if (title === "") continue;
      const siblings = parent === "" ? hierarchy.roots : (hierarchy.childrenOf.get(parent) ?? []);
      const existing = [...siblings]
        .sort()
        .find((id) => hierarchy.notes.get(id)?.title === title);
      if (existing !== undefined) {
        parent = existing;
        continue;
      }
      const key = `${parent}\u0000${title}`;
      let next = made.get(key);
      if (next === undefined) {
        const under = parent;
        next = (async () => {
          const id = await createNote(title);
          if (under !== "") await file(id, under);
          return id;
        })();
        made.set(key, next);
        next.catch(() => made.delete(key));
      }
      parent = await next;
    }
    return parent;
  };

  // Looks change when a decoration says so, or when decorations come and go.
  const lookListeners = new Set<() => void>();
  const announceLook = (): void => {
    for (const listener of [...lookListeners]) listener();
  };
  let lookStops: (() => void)[] = [];
  const followLooks = (): void => {
    for (const stop of lookStops) stop();
    lookStops = decorations.entries().map(({ value }) => {
      try {
        return value.onChange(announceLook);
      } catch (cause) {
        kernel.log.warn(`folder decoration ${value.id} cannot be followed`, cause);
        return () => undefined;
      }
    });
  };
  followLooks();
  decorations.subscribe(() => {
    followLooks();
    announceLook();
  });

  kernel.ports.serve<Folders>("folders", {
    parentOf: (id) => (hierarchy.notes.has(id) ? (hierarchy.parentOf.get(id) ?? "") : undefined),
    file: async (id, parent, index) => {
      const before = index === undefined ? undefined : (hierarchy.childrenOf.get(parent) ?? [])[index];
      await file(id, parent, before);
    },
    fileNew: async (id, kind) => {
      const parent = locationFor(kind);
      if (parent !== "") await file(id, parent);
    },
    ensurePath,
    look: (id) => lookOf(decorations.entries())(id),
    onLookChange: (listener) => {
      lookListeners.add(listener);
      return () => {
        lookListeners.delete(listener);
      };
    },
  });

  // A note `doc-list` just made: under the parent its creator named, or the default.
  kernel.ports.on<DocumentCreated>("created", (event) => {
    const parent = typeof event.parent === "string" ? event.parent : locationFor("note");
    if (parent === "") return;
    void file(event.id, parent).catch((cause: unknown) => {
      kernel.log.warn(`could not file the new note ${event.id}`, cause);
    });
  });

  // ---------------------------------------------------------------------------
  // Requests from outside the panel (commands, keybindings)
  // ---------------------------------------------------------------------------

  const requestListeners = new Set<(request: TreeRequest) => void>();
  const request = (next: TreeRequest): void => {
    if (requestListeners.size === 0) {
      // The panel is the only thing that knows what a dialog looks like. If no shell is
      // drawing it, say so rather than failing silently.
      kernel.ui.notify({
        id: "folders.no-panel",
        level: "warning",
        message: "The folder tree is not on screen, so that action has nowhere to happen.",
      });
      return;
    }
    for (const listener of [...requestListeners]) listener(next);
  };

  /** The note on screen, as a request target — refused, with a notice, for app data. */
  const onScreen = async (then: (target: { id: string; title: string }) => void): Promise<void> => {
    const id = documentFromRoute(router.current());
    if (id === undefined) return;
    const stored = await kernel.documents.get(id);
    if (stored !== undefined && isMachineDocument(stored)) {
      kernel.ui.notify({
        id: "folders.machine-document",
        level: "warning",
        message: "This document is maintained by the app and is not part of the folder tree.",
      });
      return;
    }
    then({ id, title: hierarchy.notes.get(id)?.title ?? stored?.title ?? "this note" });
  };

  // ---------------------------------------------------------------------------
  // Contributions
  // ---------------------------------------------------------------------------

  /**
   * The decorations, read for one render. `decorate` is another plugin's code on the
   * tree's hottest path, so a throw costs that row its look and nothing else.
   */
  const lookOf = (entries: ReturnType<typeof decorations.entries>) =>
    (id: string): FolderRowLook | undefined => {
      let background: string | undefined;
      let color: string | undefined;
      let icon: ReactElement | undefined;
      for (const { pluginId, value } of entries) {
        if (background !== undefined && color !== undefined && icon !== undefined) break;
        let look: FolderLook | undefined;
        try {
          look = value.decorate(id);
        } catch (cause) {
          kernel.log.warn(`folder decoration ${value.id} failed for ${id}`, cause);
          continue;
        }
        if (background === undefined && typeof look?.background === "string" && look.background !== "") {
          background = look.background;
        }
        if (color === undefined && typeof look?.color === "string" && look.color !== "") color = look.color;
        if (icon === undefined && look?.icon !== undefined && look.icon !== null) {
          icon = (
            <BoundedIcon
              kernel={kernel}
              node={look.icon}
              point="folders.decoration"
              pluginId={pluginId}
              className="folders-icon folders:flex folders:shrink-0 folders:items-center folders:[&_svg]:block folders:[&_svg]:size-[1.05em]"
            />
          );
        }
      }
      return background === undefined && color === undefined && icon === undefined
        ? undefined
        : {
            ...(background !== undefined ? { background } : {}),
            ...(color !== undefined ? { color } : {}),
            ...(icon !== undefined ? { icon } : {}),
          };
    };

  /** Each decoration's `onChange`, followed for as long as the tree is on screen. */
  const useDecorations = (): ReturnType<typeof decorations.entries> => {
    const entries = useSlotEntries(decorations);
    const [, setRevision] = useState(0);
    useEffect(() => {
      const bump = (): void => setRevision((value) => value + 1);
      const stops = entries.map(({ value }) => {
        try {
          return value.onChange(bump);
        } catch (cause) {
          kernel.log.warn(`folder decoration ${value.id} cannot be followed`, cause);
          return () => undefined;
        }
      });
      return () => {
        for (const stop of stops) stop();
      };
    }, [entries]);
    return entries;
  };

  /** Other plugins' entries for a row's menu, in seat order. */
  const extraActionsOf = (entries: ReturnType<typeof actions.entries>) =>
    (id: string, anchor?: HTMLElement): MenuItem[] =>
      entries.flatMap(({ value }) => {
        try {
          if (value.when !== undefined && !value.when(id)) return [];
        } catch (cause) {
          kernel.log.warn(`folder menu item ${value.id} failed its check`, cause);
          return [];
        }
        return [
          {
            id: `extra:${value.id}`,
            label: value.label,
            ...(value.hint !== undefined ? { hint: value.hint } : {}),
            run: () => {
              try {
                value.run(id, anchor);
              } catch (cause) {
                kernel.log.warn(`folder menu item ${value.id} failed`, cause);
              }
            },
          },
        ];
      });

  const TreeHost = (): ReactElement => {
    const live = useStore();
    const look = lookOf(useDecorations());
    const extraActions = extraActionsOf(useSlotEntries(actions));
    // The open note, whatever opened it: the tree reveals it.
    const [openDocument, setOpenDocument] = useState(() => documentFromRoute(router.current()));
    useEffect(() => router.onChange((route) => setOpenDocument(documentFromRoute(route))), []);
    return (
      <FolderTree
        menu={menu}
        hierarchy={live.hierarchy}
        loading={live.loading}
        {...(live.error !== undefined ? { error: live.error } : {})}
        collapsed={live.collapsed}
        onCollapsedChange={setCollapsed}
        rootOrder={live.rootOrder}
        onRootOrder={setRootOrder}
        requests={(listener) => {
          requestListeners.add(listener);
          return () => {
            requestListeners.delete(listener);
          };
        }}
        onMove={file}
        onRename={rename}
        onDelete={remove}
        onNewNoteInside={(parent) => docs.newDocument({ parent })}
        onOpen={(id) => router.navigate(`/doc/${id}`)}
        {...(openDocument !== undefined ? { openDocument } : {})}
        look={look}
        extraActions={extraActions}
      />
    );
  };

  const SettingsHost = (): ReactElement => {
    const live = useStore();
    const notes = [...live.hierarchy.notes.keys()]
      .map((id) => ({ id, path: titlePath(live.hierarchy, id) }))
      .sort((left, right) => compareText(left.path.join(" / "), right.path.join(" / ")));
    const store = (key: string) => async (next: string) => {
      await writeSetting(key, next);
      publish();
    };
    return (
      <div className="folders:flex folders:flex-col folders:gap-6">
        <DefaultLocation
          label="New notes go to"
          hint="A new note is filed inside this one. “New note inside” on a note in the tree still files it there."
          notes={notes}
          value={locationFor("note")}
          onChange={store(SETTINGS_KEYS.defaultLocation)}
        />
        <DefaultLocation
          label="Files go to"
          hint="The note a file added to the workspace is filed inside: an upload, or an attachment turned into a document."
          notes={notes}
          value={locationFor("file")}
          onChange={store(SETTINGS_KEYS.fileLocation)}
        />
      </div>
    );
  };

  kernel.ports.offer<SidebarPanel>("tree", {
    id: "folders.tree",
    title: "Folders",
    order: 20,
    defaultOpen: true,
    component: TreeHost,
  });

  kernel.ports.offer<SettingsSection>("settings", {
    id: "folders",
    title: "Folders",
    order: 30,
    description: "Where new notes and files are filed when nothing else says.",
    component: SettingsHost,
  });

  const onDocument = (): boolean => documentFromRoute(router.current()) !== undefined;

  /**
   * Many notes into one, for the document list's Actions button: the same picker as a
   * single move, in its own sheet — the tree need not be on screen. One at a time, so two
   * moves never race to splice the same list.
   */
  const moveMany = (argument: unknown): void => {
    const ids = (Array.isArray(argument) ? argument : []).filter(
      (id): id is string => typeof id === "string" && hierarchy.notes.has(id),
    );
    if (ids.length === 0) return;
    const subjects = ids.map((id) => ({ id, title: hierarchy.notes.get(id)?.title ?? id }));
    menu.openSheet({
      title: ids.length === 1 ? `Move ${subjects[0]?.title ?? "it"} to…` : `Move ${ids.length.toLocaleString()} notes to…`,
      render: (close) => (
        <MovePicker
          hierarchy={hierarchy}
          subjects={subjects}
          onChoose={(parent) => {
            close();
            void (async () => {
              let failed = 0;
              for (const id of ids) {
                try {
                  await file(id, parent);
                } catch (cause) {
                  failed += 1;
                  kernel.log.warn(`could not move ${id}`, cause);
                }
              }
              if (failed > 0) {
                kernel.ui.notify({
                  id: "folders.move-failed",
                  level: "error",
                  message: `${failed.toLocaleString()} of ${ids.length.toLocaleString()} notes could not be moved.`,
                });
              }
            })();
          }}
        />
      ),
    });
  };

  kernel.ports.offer<Command>("commands", [
    {
      id: "folders.newNoteInside",
      title: "New note inside this note",
      category: "Folders",
      icon: "folder-plus",
      when: onDocument,
      run: () => {
        const id = documentFromRoute(router.current());
        if (id !== undefined) docs.newDocument({ parent: id });
      },
    },
    {
      id: "folders.expandAll",
      title: "Expand all folders",
      category: "Folders",
      icon: "fold-down",
      run: () => request({ kind: "fold", id: "", expanded: true }),
    },
    {
      id: "folders.collapseAll",
      title: "Collapse all folders",
      category: "Folders",
      icon: "fold-up",
      run: () => request({ kind: "fold", id: "", expanded: false }),
    },
    {
      /*
       * The keyboard-and-touch answer to "a note can only be moved by dragging". It reads
       * the note id out of the route rather than asking `document-surface` for it:
       * `folders` has no business knowing that modes exist — a URL is a URL.
       */
      id: "folders.moveDocument",
      title: "Move this note to a folder",
      category: "Folders",
      icon: "folder-symlink",
      when: onDocument,
      run: () => void onScreen((target) => request({ kind: "move", target })),
    },
    {
      id: "folders.renameDocument",
      title: "Rename this note",
      category: "Folders",
      icon: "cursor-text",
      when: onDocument,
      run: () => void onScreen((target) => request({ kind: "rename", target })),
    },
    {
      id: "folders.deleteDocument",
      title: "Delete this note",
      category: "Folders",
      icon: "trash",
      when: onDocument,
      run: () => void onScreen((target) => request({ kind: "delete", target })),
    },
    {
      id: "folders.moveDocuments",
      title: "Move to folder…",
      category: "Folders",
      icon: "folder-symlink",
      takes: "documents",
      run: moveMany,
    },
  ]);
}

/** A pending settings write `activate` started; the kernel withdraws everything else (§6c). */
let flushOnStop: (() => void) | undefined;

export function deactivate(): void {
  flushOnStop?.();
  flushOnStop = undefined;
}

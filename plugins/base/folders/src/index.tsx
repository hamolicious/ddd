import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import { createRegistry } from "@kernel";
import type { CoreValue, DocumentRow, Kernel, SettingsValue, Unsubscribe } from "@kernel";
import { addCommand } from "plugin:commands";
import { addAction, close, confirm, modal, open, openFor, openSheet } from "plugin:context-menu";
import type { MenuItem, Target } from "plugin:context-menu";
import { onCreated } from "plugin:doc-events";
import { newDocument } from "plugin:doc-list";
import { current, navigate, onChange as onRouteChange } from "plugin:router";
import { addSection } from "plugin:settings";
import { addSidebarPanel } from "plugin:shell-ui";

import { BoundedIcon, useRegistry } from "../../_shared/boundary.js";
import { applyEdits, newUlid } from "../../_shared/saved-view.js";
import { EXCLUDE_MACHINE_DOCUMENTS, isMachineDocument } from "../../_shared/machine-docs.js";

import { FOLDER_DECORATION_SHAPE, type FolderDecoration, type FolderLook, type Folders, type NoteLook } from "./api.js";
import { DefaultLocation } from "./DefaultLocation.js";
import { FolderTree, type FolderRowLook, type MoveProgress, type TreeRequest, type TreeTarget } from "./FolderTree.js";
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

const TREE_ROW_LIMIT = 20_000;

const DELETE_CONCURRENCY = 6;

const PENDING_MOVE_TTL_MS = 15_000;

const SETTINGS_DEBOUNCE_MS = 400;

export const SETTINGS_KEYS = {
  defaultLocation: "defaultLocation",
  fileLocation: "fileLocation",
  collapsedFolders: "collapsedFolders",
  rootOrder: "rootOrder",
} as const;

const documentFromRoute = (route: string): string | undefined => {
  const [path] = route.split("?");
  const match = /^\/doc\/([^/]+)$/.exec(path ?? "");
  return match?.[1];
};

interface Copied {
  readonly id: string;
  readonly text: string;
  readonly title: string;
  readonly parent: boolean;
}

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

export type { FolderDecoration, FolderLook, Folders, NoteLook } from "./api.js";
export type FoldersApi = Folders;

const docs = { newDocument };
type SearchModule = typeof import("plugin:search");
let search: SearchModule | undefined;
const router = { navigate, current, onChange: onRouteChange };
const menu = { open, openSheet, confirm, modal, close, openFor };

const decorations = createRegistry<FolderDecoration>({
  key: (decoration) => decoration.id,
  order: (decoration) => decoration.order ?? 0,
  shape: FOLDER_DECORATION_SHAPE,
});

export const addDecoration: (items: FolderDecoration | readonly FolderDecoration[]) => () => void = decorations.add;

const listeners = new Set<() => void>();
const lookListeners = new Set<() => void>();

let service: Omit<Folders, "onChange" | "onLookChange"> | undefined;

const active = (): Omit<Folders, "onChange" | "onLookChange"> => {
  if (!service) throw new Error("folders is not active yet: call it from your plugin's activate() or later");
  return service;
};

export function parentOf(id: string): string | undefined {
  return active().parentOf(id);
}

export function childrenOf(id: string): readonly string[] {
  return active().childrenOf(id);
}

export function onChange(listener: () => void): Unsubscribe {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function file(id: string, parent: string, index?: number): Promise<void> {
  return active().file(id, parent, index);
}

export function fileNew(id: string, kind: "note" | "file"): Promise<void> {
  return active().fileNew(id, kind);
}

export function look(id: string): NoteLook | undefined {
  return active().look(id);
}

export function onLookChange(listener: () => void): Unsubscribe {
  lookListeners.add(listener);
  return () => {
    lookListeners.delete(listener);
  };
}

export function ensurePath(titles: readonly string[]): Promise<string> {
  return active().ensurePath(titles);
}

export default function activate(kernel: Kernel): void {
  void kernel.plugins
    .optional<SearchModule>("search")
    .then((module) => {
      search = module;
      if (module) stops.push(module.setNoteLooks({ look, onLookChange, parentOf, onChange }));
    })
    .catch((cause: unknown) => kernel.log.warn("search unavailable; no “New search” in the menus", cause));
  const newSearch = (parent: string): void => {
    if (!search) return;
    search.save(search.parse(""), { parent }).catch((cause: unknown) =>
      kernel.ui.notify({ id: "folders.new-search-failed", level: "error", message: `Could not create the search: ${String(cause)}` }),
    );
  };

  kernel.settings.defineSchema({
    [SETTINGS_KEYS.defaultLocation]: { type: "string", default: "" },
    [SETTINGS_KEYS.fileLocation]: { type: "string", default: "" },
    [SETTINGS_KEYS.collapsedFolders]: { type: "list", default: [] },
    [SETTINGS_KEYS.rootOrder]: { type: "list", default: [] },
  });

  let projected: readonly NoteRow[] = [];
  let hierarchy: Hierarchy = buildHierarchy([]);
  const pendingMoves = new Map<string, PendingPlace>();
  const derive = (): void => {
    for (const id of settledMoves(projected, pendingMoves)) pendingMoves.delete(id);
    hierarchy = buildHierarchy(withPendingMoves(projected, pendingMoves));
  };
  let loading = true;
  let loadError: string | undefined;
  let collapsed: ReadonlySet<string> = new Set(readIds(kernel.settings.get(SETTINGS_KEYS.collapsedFolders)));
  let rootOrder = readIds(kernel.settings.get(SETTINGS_KEYS.rootOrder));
  let orderWriting = 0;

  const publish = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const locationFor = (kind: "note" | "file"): string => {
    const stored = kernel.settings.get<string>(kind === "file" ? SETTINGS_KEYS.fileLocation : SETTINGS_KEYS.defaultLocation);
    return typeof stored === "string" ? stored.trim() : "";
  };

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

  try {
    kernel.settings.subscribe(() => {
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

  const refuseMachine = async (id: string): Promise<void> => {
    if (id === "") return;
    const row = await kernel.documents.get(id);
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

  const file = async (id: string, parent: string, before?: string): Promise<void> => {
    await refuseMachine(id);
    await refuseMachine(parent);
    const writes = planMove(hierarchy, id, parent, before);
    if (writes.length === 0) return;
    const place: PendingPlace = before === undefined ? { parent } : { parent, before };
    pendingMoves.set(id, place);
    derive();
    publish();
    try {
      for (const step of writes) await write(step);
      setTimeout(() => {
        if (pendingMoves.get(id) !== place) return;
        pendingMoves.delete(id);
        derive();
        publish();
      }, PENDING_MOVE_TTL_MS);
    } catch (cause) {
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

  const remove = async (id: string, mode: "parent" | "trash", options?: MoveProgress): Promise<number> => {
    await refuseMachine(id);
    const children = hierarchy.childrenOf.get(id) ?? [];
    const parent = hierarchy.parentOf.get(id) ?? "";

    let doomed = [id];
    if (mode === "parent") {
      if (parent !== "") {
        const raw = hierarchy.notes.get(parent)?.children ?? [];
        const at = raw.indexOf(id);
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
    const open = documentFromRoute(router.current());
    if (open !== undefined && doomed.includes(open)) router.navigate(parent === "" ? "/" : `/doc/${parent}`);
    return doomed.length;
  };

  const made = new Map<string, Promise<string>>();

  const createNote = async (title: string): Promise<string> => {
    const front = kernel.documents.splice.planFrontmatterValue("", "title", title)[0]?.text ?? "";
    return kernel.documents.create({ text: front });
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
  stops.push(
    decorations.subscribe(() => {
      followLooks();
      announceLook();
    }),
  );
  stops.push(() => {
    for (const stop of lookStops) stop();
    lookStops = [];
  });

  service = {
    parentOf: (id) => (hierarchy.notes.has(id) ? (hierarchy.parentOf.get(id) ?? "") : undefined),
    childrenOf: (id) => hierarchy.childrenOf.get(id) ?? [],
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
  };

  stops.push(onCreated((event) => {
    const parent = typeof event.parent === "string" ? event.parent : locationFor("note");
    if (parent === "") return;
    void file(event.id, parent).catch((cause: unknown) => {
      kernel.log.warn(`could not file the new note ${event.id}`, cause);
    });
  }));

  const requestListeners = new Set<(request: TreeRequest) => void>();
  const request = (next: TreeRequest): void => {
    if (requestListeners.size === 0) {
      kernel.ui.notify({
        id: "folders.no-panel",
        level: "warning",
        message: "The folder tree is not on screen, so that action has nowhere to happen.",
      });
      return;
    }
    for (const listener of [...requestListeners]) listener(next);
  };

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

  const useDecorations = (): ReturnType<typeof decorations.entries> => {
    const entries = useRegistry(decorations);
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

  const TreeHost = (): ReactElement => {
    const live = useStore();
    const look = lookOf(useDecorations());
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
        onOpen={(id) => router.navigate(`/doc/${id}`)}
        {...(openDocument !== undefined ? { openDocument } : {})}
        look={look}
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
          {...(search ? { NoteSelect: search.NoteSelect } : {})}
          value={locationFor("note")}
          onChange={store(SETTINGS_KEYS.defaultLocation)}
        />
        <DefaultLocation
          label="Files go to"
          hint="The note a file added to the workspace is filed inside: an upload, or an attachment turned into a document."
          notes={notes}
          {...(search ? { NoteSelect: search.NoteSelect } : {})}
          value={locationFor("file")}
          onChange={store(SETTINGS_KEYS.fileLocation)}
        />
      </div>
    );
  };

  addSidebarPanel({
    id: "folders.tree",
    title: "Folders",
    order: 20,
    defaultOpen: true,
    component: TreeHost,
    target: { type: "folders/root" },
  });

  addSection({
    id: "folders",
    title: "Folders",
    order: 30,
    description: "Where new notes and files are filed when nothing else says.",
    component: SettingsHost,
  });

  const onDocument = (): boolean => documentFromRoute(router.current()) !== undefined;

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
          {...(search ? { NoteSelect: search.NoteSelect } : {})}
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

  let copied: Copied | undefined;

  const failed = (what: string) => (cause: unknown): undefined => {
    kernel.ui.notify({
      id: "folders.copy-failed",
      level: "error",
      message: `Could not ${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
    return undefined;
  };

  const snapshot = async (id: string): Promise<Copied> => {
    const open = await kernel.documents.open(id);
    const row = hierarchy.notes.get(id);
    try {
      return { id, text: open.text.toString(), title: row?.title ?? "Untitled", parent: (row?.children.length ?? 0) > 0 };
    } finally {
      open.release();
    }
  };

  const pasteCopy = async (
    source: Copied,
    parent: string,
    options: { readonly title?: string; readonly before?: string } = {},
  ): Promise<string> => {
    const { splice } = kernel.documents;
    let text = source.text;
    if (source.parent) {
      text = applyEdits(text, splice.planSection(text, [{ key: CHILDREN_KEY, value: null, remove: true }]));
    }
    if (options.title !== undefined) text = applyEdits(text, splice.planFrontmatterValue(text, "title", options.title));
    const id = newUlid();
    await kernel.documents.create({ id, text: text.replaceAll(source.id, id) });
    if (parent !== "") await file(id, parent, options.before);
    return id;
  };

  const duplicate = async (id: string): Promise<string | undefined> => {
    const source = await snapshot(id);
    const parent = hierarchy.parentOf.get(id) ?? "";
    const siblings = hierarchy.notes.get(parent)?.children ?? [];
    const after = siblings[siblings.indexOf(id) + 1];
    return pasteCopy(source, parent, { title: `${source.title} (copy)`, ...(after !== undefined ? { before: after } : {}) });
  };

  const copy = async (id: string): Promise<void> => {
    copied = await snapshot(id);
    kernel.ui.notify({ id: "folders.copied", level: "info", message: `Copied ${copied.title}.` });
  };

  const paste = (parent: string = locationFor("note")): Promise<string | undefined> =>
    copied === undefined ? Promise.resolve(undefined) : pasteCopy(copied, parent);

  const openNote = (id: string | undefined): void => {
    if (id !== undefined) router.navigate(`/doc/${encodeURIComponent(id)}`);
  };
  const noteOnScreen = (): string | undefined => {
    const id = documentFromRoute(router.current());
    return id !== undefined && hierarchy.notes.has(id) ? id : undefined;
  };
  const onNote = (): boolean => noteOnScreen() !== undefined;

  addCommand([
    {
      id: "folders.duplicateNote",
      title: "Duplicate note",
      category: "Folders",
      icon: "copy-plus",
      when: onNote,
      run: () => {
        const id = noteOnScreen();
        if (id !== undefined) void duplicate(id).then(openNote, failed("duplicate it"));
      },
    },
    {
      id: "folders.copyNote",
      title: "Copy note",
      category: "Folders",
      icon: "copy",
      when: onNote,
      run: () => {
        const id = noteOnScreen();
        if (id !== undefined) void copy(id).catch(failed("copy it"));
      },
    },
    {
      id: "folders.pasteNote",
      title: "Paste note",
      category: "Folders",
      icon: "clipboard-plus",
      when: () => copied !== undefined,
      run: () => void paste().then(openNote, failed("paste it")),
    },
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

  const inTree = (target: Target): boolean => target.element.closest(".folders-tree") !== null;
  const noteTarget = (id: string): TreeTarget => ({ id, title: hierarchy.notes.get(id)?.title ?? "Untitled" });

  const renameElsewhere = async (id: string): Promise<void> => {
    const title = hierarchy.notes.get(id)?.title ?? "";
    const answer = await menu.modal({
      title: "Rename",
      fields: [{ kind: "text", id: "title", label: "Title", value: title, required: true }],
      buttons: [
        { id: "cancel", label: "Cancel", dismiss: true },
        { id: "rename", label: "Rename", tone: "primary" },
      ],
    });
    const next = typeof answer?.values.title === "string" ? answer.values.title.trim() : "";
    if (next === "" || next === title) return;
    await rename(id, next).catch((cause: unknown) => kernel.log.warn(`could not rename ${id}`, cause));
  };

  const deleteNote = async (id: string): Promise<void> => {
    if (requestListeners.size > 0) {
      request({ kind: "delete", target: noteTarget(id) });
      return;
    }
    const inside = hierarchy.childrenOf.get(id)?.length ?? 0;
    const confirmed = await menu.confirm({
      title: `Delete “${noteTarget(id).title}”?`,
      description:
        inside === 0
          ? "It goes to Trash, where it can be restored for 30 days."
          : `The ${inside} note${inside === 1 ? "" : "s"} inside it stay, one level up.`,
      confirmLabel: "Move to Trash",
      danger: true,
    });
    if (!confirmed) return;
    await remove(id, "parent").catch((cause: unknown) =>
      kernel.ui.notify({ id: "folders.delete-failed", level: "error", message: `Could not delete it: ${String(cause)}` }),
    );
  };

  addAction([
    {
      id: "folders.document",
      target: "ddd/document",
      order: 10,
      items: (target): MenuItem[] => {
        const id = target.id;
        if (!hierarchy.notes.has(id)) return [];
        const here = inTree(target);
        const parent = hierarchy.parentOf.get(id) ?? "";
        return [
          { id: "new-note", label: "New note inside", run: () => docs.newDocument({ parent: id }) },
          ...(search ? [{ id: "new-search", label: "New search inside", run: () => newSearch(id) }] : []),
          ...(here && hierarchy.childrenOf.has(id)
            ? [
                { id: "expand-all", label: "Expand all inside", run: () => request({ kind: "fold", id, expanded: true }) },
                { id: "collapse-all", label: "Collapse all inside", run: () => request({ kind: "fold", id, expanded: false }) },
              ]
            : []),
          { id: "duplicate", label: "Duplicate", run: () => void duplicate(id).catch(failed("duplicate it")) },
          { id: "copy", label: "Copy", run: () => void copy(id).catch(failed("copy it")) },
          ...(copied !== undefined
            ? [{ id: "paste", label: "Paste inside", hint: copied.title, run: () => void paste(id).catch(failed("paste it")) }]
            : []),
          {
            id: "rename",
            label: "Rename",
            run: () => (here ? request({ kind: "rename", target: noteTarget(id) }) : void renameElsewhere(id)),
          },
          {
            id: "move",
            label: "Move to…",
            hint: parent === "" ? "Now at the root" : `Now in ${hierarchy.notes.get(parent)?.title ?? "Untitled"}`,
            run: () => (here ? request({ kind: "move", target: noteTarget(id) }) : moveMany([id])),
          },
        ];
      },
    },
    {
      id: "document.trash",
      target: "ddd/document",
      order: 100,
      items: (target): MenuItem[] => [
        hierarchy.notes.has(target.id)
          ? { id: "delete", label: "Delete", danger: true, run: () => void deleteNote(target.id) }
          : {
              id: "delete",
              label: "Move to Trash",
              hint: "Restorable for 30 days.",
              danger: true,
              run: () =>
                void kernel.documents.delete(target.id).catch((cause: unknown) =>
                  kernel.ui.notify({ id: "folders.delete-failed", level: "error", message: `Could not delete it: ${String(cause)}` }),
                ),
            },
      ],
    },
    {
      id: "folders.root",
      target: "folders/root",
      items: (): MenuItem[] => [
        { id: "new-note-root", label: "New note at the root", run: () => docs.newDocument({ parent: "" }) },
        ...(copied !== undefined
          ? [{ id: "paste-root", label: "Paste at the root", hint: copied.title, run: () => void paste("").catch(failed("paste it")) }]
          : []),
        ...(search ? [{ id: "new-search-root", label: "New search at the root", run: () => newSearch("") }] : []),
        { id: "expand-all", label: "Expand all", run: () => request({ kind: "fold", id: "", expanded: true }) },
        { id: "collapse-all", label: "Collapse all", run: () => request({ kind: "fold", id: "", expanded: false }) },
      ],
    },
  ]);
}

let flushOnStop: (() => void) | undefined;
const stops: (() => void)[] = [];

export function deactivate(): void {
  flushOnStop?.();
  flushOnStop = undefined;
  for (const stop of stops.splice(0)) stop();
  service = undefined;
  search = undefined;
}

/**
 * `document-surface` — owns the document route and the **mode registry** (SPEC §6.5).
 *
 * `viewer` and `editor` are symmetric contributions to `document.mode`: this plugin has
 * no built-in favourite and no special case for either. That is what makes M3's
 * acceptance test possible — "the built-in editor replaced by a separately-authored
 * editor plugin" is a different contribution to this point and nothing else. Nothing in
 * this file spells `viewer`, `editor`, `read` or `edit` except {@link DEFAULT_MODE_ID},
 * which is a *fallback preference* and degrades to the lowest-`order` mode registered.
 *
 * The surface owns the three things a mode must not each re-implement:
 *
 * - **The live row.** One `documents.subscribe` per document on screen, so a change
 *   arriving over the feed re-renders every mode (SPEC §4.1).
 * - **Hydration.** It opens the document once (`kernel.documents.open`) and passes the
 *   handle to the active mode, releasing it when the route changes. Two modes opening
 *   the same document would take two handles and hold the replica open twice.
 * - **Mode persistence.** The chosen mode per document is a per-user setting, so
 *   reopening a document returns you to how you were reading it.
 */

import type {
  DocumentId,
  DocumentRow,
  ExtensionPoint,
  Kernel,
  OpenDocument,
  QuerySubscription,
  Unsubscribe,
} from "@kernel";
import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";

import {
  POINTS,
  documentModeShape,
  type Command,
  type DocumentMode,
  type DocumentModeProps,
} from "../../_shared/points.js";
import {
  DEFAULT_MODE_ID,
  nextModeId,
  parseModeMemory,
  rememberMode,
  resolveModeId,
  serializeModeMemory,
  visibleModes,
} from "./modes.js";

export interface DocumentSurfaceApi {
  /** The document currently on screen, if any. */
  currentDocument(): string | undefined;
  /** The hydrated handle for the current document; `undefined` while hydrating. */
  currentHandle(): OpenDocument | undefined;
  /**
   * The live projection row of the document on screen. Added for `properties`, which
   * renders `fm` for whatever is on screen and must not open a second subscription
   * for it. Additive to the M3 scaffold's API.
   */
  currentRow(): DocumentRow | undefined;
  modes(): readonly DocumentMode[];
  activeMode(): string | undefined;
  setMode(modeId: string): Promise<void>;
  onChange(
    listener: (state: {
      documentId?: string;
      mode?: string;
      /** Additive: fires on row updates too, so dependents need no second query. */
      row?: DocumentRow;
    }) => void,
  ): Unsubscribe;
}

/** What the route can be showing. Every state has a written-out UI below. */
type SurfaceStatus = "idle" | "loading" | "ready" | "missing";

interface Snapshot {
  readonly documentId?: DocumentId;
  readonly row?: DocumentRow;
  readonly handle?: OpenDocument;
  readonly mode?: string;
  readonly status: SurfaceStatus;
  /** Hydration failed (usually: offline, never opened before). Read still works. */
  readonly hydrationError?: string;
  /**
   * Bumped on **every** notification, including ones that change nothing in the
   * fields above.
   *
   * `SurfaceView` reads this store through `useSyncExternalStore`, whose contract is
   * that `getSnapshot()` returns a value which is `Object.is`-different whenever the
   * store has changed. Notifying listeners while handing back the same object makes
   * React skip the render — which is precisely the case the mode registry needs to
   * work: `visible()` is derived from the *extension point*, not from this snapshot,
   * so a mode contributed after the last render (a plugin that activates late, or is
   * installed while a document is open) would never appear as a tab and an
   * uninstalled `editor` would never fall back to reading, despite the subscription
   * in the constructor doing its job. A revision counter is the cheapest honest way
   * to say "something you derive from me may have changed".
   */
  readonly revision: number;
}

const SETTING_DEFAULT_MODE = "defaultMode";
const SETTING_MODE_MEMORY = "modeMemory";
/** Mode choices are written back coalesced: a tab click must not await the CRDT. */
const MEMORY_WRITE_DELAY_MS = 750;

/** One document by id, in the shared filter DSL (SPEC §4.2 — ours, not Mongo's). */
const byId = (id: DocumentId): Record<string, unknown> => ({
  cmp: { field: "id", op: "eq", value: { str: id } },
});

export default function activate(kernel: Kernel): DocumentSurfaceApi {
  const modes = kernel.extensions.definePoint<DocumentMode>({
    name: POINTS.documentMode,
    shape: documentModeShape,
    key: (mode) => mode.id,
    description: "A way of showing one document — `read`, `edit`, or anything else.",
  });

  kernel.settings.defineSchema({
    [SETTING_DEFAULT_MODE]: {
      type: "string",
      label: "Default document mode",
      description: "Used when a document has no remembered mode.",
      default: DEFAULT_MODE_ID,
    },
    [SETTING_MODE_MEMORY]: {
      type: "list",
      label: "Remembered document modes",
      description:
        "UI state, one `document-id=mode` entry per recently opened document. Safe to clear.",
    },
  });

  const surface = new Surface(kernel, modes);

  kernel.extensions.contribute(POINTS.route, { path: "/doc/:id", view: "document.surface" });
  kernel.extensions.contribute(POINTS.mainView, {
    id: "document.surface",
    title: "Document",
    component: (props: { readonly params?: Readonly<Record<string, string>> }) => (
      <SurfaceView surface={surface} params={props.params} />
    ),
  });

  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "document.nextMode",
    title: "Switch document mode",
    category: "Document",
    when: () => surface.snapshot.documentId !== undefined,
    run: () => {
      const next = nextModeId(surface.visible(), api.activeMode());
      if (next) void api.setMode(next);
    },
  });
  kernel.extensions.contribute(POINTS.keybinding, { command: "document.nextMode", keys: "Mod+E" });

  // One command per registered mode, so the palette can jump straight to a mode and a
  // user can bind a key to it. Modes arrive over the lifetime of the boot (and can be
  // withdrawn when a plugin fails), so this tracks the point rather than reading it
  // once — `subscribe` fires immediately and on every change.
  const modeCommands = new Map<string, { dispose(): void }>();
  modes.subscribe((values) => {
    const seen = new Set<string>();
    for (const mode of values) {
      seen.add(mode.id);
      if (modeCommands.has(mode.id)) continue;
      modeCommands.set(
        mode.id,
        kernel.extensions.contribute<Command>(POINTS.command, {
          id: `document.mode.${mode.id}`,
          title: `Show document as: ${mode.label}`,
          category: "Document",
          when: () => surface.visible().some((candidate) => candidate.id === mode.id),
          run: () => api.setMode(mode.id),
        }),
      );
    }
    for (const [id, contribution] of modeCommands) {
      if (seen.has(id)) continue;
      contribution.dispose();
      modeCommands.delete(id);
    }
  });

  const api: DocumentSurfaceApi = {
    currentDocument: () => surface.snapshot.documentId,
    currentHandle: () => surface.snapshot.handle,
    currentRow: () => surface.snapshot.row,
    modes: () => surface.visible(),
    activeMode: () => surface.snapshot.mode,
    setMode: (modeId) => surface.setMode(modeId),
    onChange: (listener) =>
      surface.subscribe(() => {
        const { documentId, mode, row } = surface.snapshot;
        listener({ documentId, mode, row });
      }),
  };

  return api;
}

/**
 * The surface's state, outside React.
 *
 * It lives outside the component tree for one reason that matters: the hydrated handle
 * is reference-counted, and tying `open`/`release` to a component's effect lifecycle
 * makes a leak a rendering detail. A strict-mode double-effect, a remount from a
 * sibling re-render, or a fast back-navigation would each leak a socket subscription
 * and a replica for the rest of the session. One owner, one `release`, one generation
 * counter to make late async results harmless.
 */
class Surface {
  #snapshot: Snapshot = { status: "idle", revision: 0 };
  #revision = 0;
  readonly #listeners = new Set<() => void>();
  /** Bumped on every navigation; async results from an older generation are dropped. */
  #generation = 0;
  #query: QuerySubscription | undefined;
  #queryOff: Unsubscribe | undefined;
  #memory: Map<string, string> | undefined;
  #memoryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly kernel: Kernel,
    private readonly point: ExtensionPoint<DocumentMode>,
  ) {
    // A mode contributed (or withdrawn) after the document is on screen can change
    // which mode should be active — an uninstalled editor must fall back to reading.
    this.point.subscribe(() => {
      if (this.#snapshot.documentId === undefined) return;
      const mode = this.#resolve(this.#snapshot.mode);
      if (mode !== this.#snapshot.mode) this.#patch({ mode });
      else this.#emit();
    });
  }

  get snapshot(): Snapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Which plugin contributed a mode. Attribution comes from the registry, never from
   * the contribution's own `id` — `read` is a mode id, not a plugin id, and an error
   * boundary that named the wrong plugin would send the reader to the wrong admin row.
   */
  ownerOf(mode: DocumentMode): string | undefined {
    return this.point.entries().find((entry) => entry.value === mode)?.pluginId;
  }

  /** The modes that may show the document on screen, in order. */
  visible(): readonly DocumentMode[] {
    return visibleModes(this.point.get(), this.#snapshot.row, (mode, error) =>
      this.kernel.log.warn(`document.mode "${mode.id}" threw from when()`, error),
    );
  }

  /**
   * Show a document, or nothing. Idempotent for the same id — the router re-resolves
   * on every point change, so this is called far more often than the URL changes.
   */
  show(id: DocumentId | undefined): void {
    if (id === this.#snapshot.documentId) return;
    const generation = ++this.#generation;
    this.#teardown();
    if (id === undefined) {
      this.#set({ status: "idle" });
      return;
    }
    this.#set({ documentId: id, status: "loading" });
    void this.#watchRow(id, generation);
    void this.#hydrate(id, generation);
  }

  /** Release everything held for the document on screen. Safe to call twice. */
  close(): void {
    this.#generation++;
    this.#teardown();
    this.#set({ status: "idle" });
  }

  async setMode(modeId: string): Promise<void> {
    const { documentId } = this.#snapshot;
    if (documentId === undefined) return;
    if (!this.visible().some((mode) => mode.id === modeId)) {
      this.kernel.log.warn(`no visible document.mode "${modeId}"`);
      return;
    }
    this.#patch({ mode: modeId });
    rememberMode(this.#memoryMap(), documentId, modeId);
    this.#scheduleMemoryWrite();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  /** Notify with a new snapshot identity — see `Snapshot.revision`. */
  #emit(): void {
    this.#snapshot = { ...this.#snapshot, revision: ++this.#revision };
    this.#notify();
  }

  /**
   * Replace the whole snapshot. Separate from `#patch` because the revision counter
   * must survive a reset: it lives on the instance, not in the object it stamps.
   */
  #set(next: Omit<Snapshot, "revision">): void {
    this.#snapshot = { ...next, revision: ++this.#revision };
    this.#notify();
  }

  #patch(patch: Partial<Snapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#emit();
  }

  #teardown(): void {
    this.#queryOff?.();
    this.#queryOff = undefined;
    this.#query?.close();
    this.#query = undefined;
    // The one release that matters (SPEC §4.1: the last release unsubscribes from the
    // server and lets the LRU evict the replica).
    this.#snapshot.handle?.release();
  }

  async #watchRow(id: DocumentId, generation: number): Promise<void> {
    const apply = (row: DocumentRow | undefined): void => {
      if (generation !== this.#generation) return;
      this.#patch({ row, status: row ? "ready" : "missing", mode: this.#resolve(this.#snapshot.mode, id, row) });
    };
    try {
      // Tombstoned documents stay viewable: the Trash is a view over rows that are
      // still here for 30 days (SPEC §3.5), and a link into one must not 404.
      const subscription = await this.kernel.documents.subscribe({
        filter: byId(id),
        includeDeleted: true,
        limit: 1,
      });
      if (generation !== this.#generation) {
        subscription.close();
        return;
      }
      this.#query = subscription;
      this.#queryOff = subscription.onChange((result) => apply(result.rows[0]));
      apply(subscription.result.rows[0]);
    } catch (error) {
      this.kernel.log.warn("live row subscription failed; falling back to a one-shot read", error);
      try {
        apply(await this.kernel.documents.get(id));
      } catch (readError) {
        this.kernel.log.error("could not read the document row", readError);
        if (generation === this.#generation) this.#patch({ status: "missing" });
      }
    }
  }

  /**
   * Hydration is **eager**: the frozen `DocumentModeProps` gives a mode no way to ask
   * for a `Y.Doc`, so the surface cannot know whether the active mode needs one. The
   * cost is one `doc.subscribe` and one LRU slot per document you look at; the benefit
   * is that switching to an editing mode is instant and the document becomes editable
   * offline (SPEC §4.1). If that trade ever needs revisiting, the fix is an optional
   * `hydrate?: boolean` on the `document.mode` point — not a special case for `read`.
   *
   * A failure here is **not** a failure of the surface: offline, a document never
   * opened before cannot hydrate, and read modes render from `row.content` anyway.
   */
  async #hydrate(id: DocumentId, generation: number): Promise<void> {
    try {
      const handle = await this.kernel.documents.open(id);
      if (generation !== this.#generation) {
        handle.release();
        return;
      }
      this.#patch({ handle, hydrationError: undefined });
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#patch({
        handle: undefined,
        hydrationError: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #resolve(current: string | undefined, id?: DocumentId, row?: DocumentRow): string | undefined {
    const documentId = id ?? this.#snapshot.documentId;
    const visible = visibleModes(this.point.get(), row ?? this.#snapshot.row);
    // A mode the user is already on stays selected as long as it is still visible.
    if (current !== undefined && visible.some((mode) => mode.id === current)) return current;
    const remembered = documentId === undefined ? undefined : this.#memoryMap().get(documentId);
    return resolveModeId(remembered, this.#preferredMode(), visible);
  }

  #preferredMode(): string | undefined {
    try {
      const value = this.kernel.settings.get<string>(SETTING_DEFAULT_MODE);
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      // `settings` is not implemented yet in the kernel runtime; a missing preference
      // is not an error, it is the default.
      return undefined;
    }
  }

  #memoryMap(): Map<string, string> {
    if (this.#memory) return this.#memory;
    let stored: unknown;
    try {
      stored = this.kernel.settings.get(SETTING_MODE_MEMORY);
    } catch {
      stored = undefined;
    }
    this.#memory = parseModeMemory(stored);
    return this.#memory;
  }

  #scheduleMemoryWrite(): void {
    if (this.#memoryTimer !== undefined) clearTimeout(this.#memoryTimer);
    this.#memoryTimer = setTimeout(() => {
      this.#memoryTimer = undefined;
      const value = serializeModeMemory(this.#memoryMap());
      // A settings write is a CRDT splice into the per-user settings document; it can
      // fail (offline, not implemented yet) and a mode tab must not surface that.
      void Promise.resolve()
        .then(() => this.kernel.settings.set(SETTING_MODE_MEMORY, [...value]))
        .catch((error: unknown) =>
          this.kernel.log.debug("could not persist the document mode", error),
        );
    }, MEMORY_WRITE_DELAY_MS);
  }
}

// ---------------------------------------------------------------------------
// the view
// ---------------------------------------------------------------------------

/**
 * Every contributed component renders inside `kernel.ui.boundary` (SPEC §6.4), and the
 * wrapper is memoized: a fresh wrapper each render is a fresh component type, which
 * unmounts and remounts the mode on every keystroke — for `editor` that means losing
 * the CodeMirror view and the cursor.
 */
const wrapped = new WeakMap<ComponentType<DocumentModeProps>, ComponentType<DocumentModeProps>>();

function boundaryFor(
  kernel: Kernel,
  mode: DocumentMode,
  pluginId: string | undefined,
): ComponentType<DocumentModeProps> {
  const existing = wrapped.get(mode.component);
  if (existing) return existing;
  const component = kernel.ui.boundary(mode.component, {
    point: POINTS.documentMode,
    ...(pluginId === undefined ? {} : { pluginId }),
  });
  wrapped.set(mode.component, component);
  return component;
}

/**
 * A mode's `icon` is a `ReactNode`, so `boundaryFor` cannot wrap it — and rendered bare
 * it sits outside every boundary on this surface, where one throw unmounts the React
 * root instead of showing a chip (SPEC §6.4). This is the component that carries one.
 */
function IconSlot({ node }: { readonly node: ReactNode }): ReactNode {
  return node;
}

const wrappedIcons = new WeakMap<object, ComponentType<{ node: ReactNode }>>();

function iconBoundaryFor(
  kernel: Kernel,
  mode: DocumentMode,
  pluginId: string | undefined,
): ComponentType<{ node: ReactNode }> {
  const key = mode as unknown as object;
  const existing = wrappedIcons.get(key);
  if (existing) return existing;
  const component = kernel.ui.boundary(IconSlot, {
    point: `${POINTS.documentMode}#icon`,
    ...(pluginId === undefined ? {} : { pluginId }),
  });
  wrappedIcons.set(key, component);
  return component;
}

function ModeIcon({
  surface,
  mode,
}: {
  readonly surface: Surface;
  readonly mode: DocumentMode;
}): ReactNode {
  if (mode.icon === undefined || mode.icon === null || mode.icon === false) return null;
  const Icon = iconBoundaryFor(surface.kernel, mode, surface.ownerOf(mode));
  return (
    <span className="docsurface-mode-icon">
      <Icon node={mode.icon} />
    </span>
  );
}

function SurfaceView({
  surface,
  params,
}: {
  readonly surface: Surface;
  readonly params?: Readonly<Record<string, string>>;
}): ReactNode {
  const raw = params?.id;
  // `router.href` percent-encodes params; ids are ULIDs, but decoding is what makes
  // this correct for any id the router hands over.
  const id = raw === undefined ? undefined : safeDecode(raw);

  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => surface.subscribe(listener), [surface]),
    () => surface.snapshot,
  );

  // Navigation, not mounting, drives what is open — `show` is idempotent for the same
  // id, and `close` on unmount is the release that the handle's ref count needs.
  useEffect(() => {
    surface.show(id);
  }, [surface, id]);
  useEffect(() => () => surface.close(), [surface]);

  if (id === undefined) {
    return (
      <div className="docsurface-root docsurface-empty">
        <p>No document selected.</p>
      </div>
    );
  }

  if (snapshot.status === "loading") {
    return (
      <div className="docsurface-root docsurface-empty" aria-busy="true">
        <p>Opening the document…</p>
      </div>
    );
  }

  if (snapshot.status === "missing" || !snapshot.row) {
    return (
      <div className="docsurface-root docsurface-empty">
        <h1 className="docsurface-title">Document not found</h1>
        <p>
          Nothing in this workspace has the id <code className="docsurface-id">{id}</code>. It may
          have been permanently deleted, or this client may not have finished its first sync.
        </p>
      </div>
    );
  }

  const row = snapshot.row;
  const visible = surface.visible();
  const active = visible.find((mode) => mode.id === snapshot.mode) ?? visible[0];

  return (
    <div className="docsurface-root">
      <header className="docsurface-header">
        <h1 className="docsurface-title">{row.title}</h1>
        <ModeTabs surface={surface} modes={visible} activeId={active?.id} />
      </header>

      {row.deleted ? <TrashedBanner surface={surface} row={row} /> : null}
      {row.fm_parse_error ? (
        <p className="docsurface-notice docsurface-notice-warning" role="status">
          This document’s frontmatter has a line that could not be read. The text is untouched;
          open the properties panel to see which keys are missing.
        </p>
      ) : null}
      {snapshot.hydrationError && !snapshot.handle ? (
        <p className="docsurface-notice" role="status">
          Editing is unavailable: the editable copy could not be fetched
          {" ("}
          {snapshot.hydrationError}
          {"). "}
          Reading works from the replicated copy.
        </p>
      ) : null}

      <section
        className="docsurface-pane"
        role="tabpanel"
        id={`docsurface-pane-${active?.id ?? "none"}`}
        aria-labelledby={active ? `docsurface-tab-${active.id}` : undefined}
      >
        {active ? (
          <ActiveMode
            kernel={surface.kernel}
            mode={active}
            owner={surface.ownerOf(active)}
            id={row.id}
            row={row}
            open={snapshot.handle}
          />
        ) : (
          <p className="docsurface-empty">
            No way of showing a document is installed. A workspace needs at least one{" "}
            <code>document.mode</code> contribution.
          </p>
        )}
      </section>
    </div>
  );
}

/** Kept out of `SurfaceView` so the boundary lookup happens once per mode, not per field. */
function ActiveMode({
  kernel,
  mode,
  owner,
  id,
  row,
  open,
}: {
  readonly kernel: Kernel;
  readonly mode: DocumentMode;
  readonly owner: string | undefined;
  readonly id: DocumentId;
  readonly row: DocumentRow;
  readonly open?: OpenDocument;
}): ReactNode {
  const Component = boundaryFor(kernel, mode, owner);
  return <Component id={id} row={row} open={open} />;
}

/**
 * The mode switcher: a tab list, keyboard-operable (SPEC §8 a11y baseline). Arrow keys
 * move between tabs, Home/End jump, and the tab itself is a real button so a screen
 * reader announces the selected one.
 */
function ModeTabs({
  surface,
  modes,
  activeId,
}: {
  readonly surface: Surface;
  readonly modes: readonly DocumentMode[];
  readonly activeId: string | undefined;
}): ReactNode {
  const container = useRef<HTMLDivElement | null>(null);
  if (modes.length < 2) return null;

  const move = (delta: number, index: number): void => {
    const next = modes[(index + delta + modes.length) % modes.length];
    if (!next) return;
    void surface.setMode(next.id);
    container.current?.querySelector<HTMLButtonElement>(`#docsurface-tab-${cssEscape(next.id)}`)?.focus();
  };

  return (
    <div className="docsurface-modes" role="tablist" aria-label="Document mode" ref={container}>
      {modes.map((mode, index) => {
        const selected = mode.id === activeId;
        return (
          <button
            key={mode.id}
            id={`docsurface-tab-${mode.id}`}
            type="button"
            role="tab"
            className="docsurface-mode"
            aria-selected={selected}
            aria-controls={`docsurface-pane-${mode.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => void surface.setMode(mode.id)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") move(1, index);
              else if (event.key === "ArrowLeft" || event.key === "ArrowUp") move(-1, index);
              else if (event.key === "Home") move(-index, index);
              else if (event.key === "End") move(modes.length - 1 - index, index);
              else return;
              event.preventDefault();
            }}
          >
            <ModeIcon surface={surface} mode={mode} />
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}

function TrashedBanner({
  surface,
  row,
}: {
  readonly surface: Surface;
  readonly row: DocumentRow;
}): ReactNode {
  const kernel = surface.kernel;
  return (
    <p className="docsurface-notice docsurface-notice-danger" role="status">
      This document is in the Trash{row.deleted_at ? ` (deleted ${row.deleted_at})` : ""}. It is
      restorable for 30 days.{" "}
      <button
        type="button"
        className="docsurface-restore"
        onClick={() => {
          void kernel.documents
            .restore(row.id)
            .catch((error: unknown) => kernel.log.error("restore failed", error));
        }}
      >
        Restore
      </button>
    </p>
  );
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `CSS.escape` is not in every webview this ships to; ids are `[A-Za-z0-9_-]`-ish. */
function cssEscape(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "\\$&");
}

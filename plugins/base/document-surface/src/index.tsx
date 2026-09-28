/**
 * `document-surface` — owns the document route and the **mode registry** (SPEC §6.5).
 *
 * `viewer` and `editor` are symmetric offers on `document.mode`: this plugin has no
 * built-in favourite and no special case for either. That is what makes M3's
 * acceptance test possible — "the built-in editor replaced by a separately-authored
 * editor plugin" is a different offer wired to this host and nothing else. Nothing in
 * this file spells `viewer`, `editor`, `read` or `edit` except {@link DEFAULT_MODE_ID},
 * which is a *fallback preference* and degrades to the first seated mode.
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
 *
 * **The switch is icons.** On a wide screen, a compact segmented control in the header —
 * each mode's `icon`, its label as the accessible name and tooltip (a mode with no icon
 * shows its label). On a phone the header holds only the title, and a round button
 * floats bottom-right showing the mode it switches *to* (the pencil while reading, the
 * book while editing), where a thumb already is.
 */

import type {
  DocumentId,
  DocumentRow,
  Kernel,
  OpenDocument,
  QuerySubscription,
  SlotHost,
  Unsubscribe,
} from "@kernel";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";

import type { Command } from "@protocols/lm/commands.command";
import type { DocumentMode, DocumentModeProps } from "@protocols/lm/document.mode";
import type { KeybindingDefault } from "@protocols/lm/keybindings.default";
import type { MainView } from "@protocols/lm/main.view";
import type { Router } from "@protocols/lm/router";
import type { Route } from "@protocols/lm/router.route";
import type { SettingsSection } from "@protocols/lm/settings.section";
import { lineFromPath } from "./line.js";
import { SaveState } from "./SaveState.js";
import { DefaultModeSection } from "./SettingsSection.js";
import {
  DEFAULT_MODE_ID,
  nextModeId,
  parseModeMemory,
  rememberMode,
  resolveModeId,
  serializeModeMemory,
  visibleModes,
} from "./modes.js";

export { LINE_PARAM, lineFromPath } from "./line.js";

/** The `router` port: as much of `lm/router` as this plugin's manifest `needs`. */
type RouterService = Pick<Router, "current" | "onChange">;

export interface DocumentSurfaceApi {
  /** The document currently on screen, if any. */
  currentDocument(): string | undefined;
  /** The hydrated handle for the current document; `undefined` while hydrating. */
  currentHandle(): OpenDocument | undefined;
  /**
   * The live projection row of the document on screen, for a plugin that renders `fm`
   * for whatever is on screen and must not open a second subscription for it. Additive
   * to the M3 scaffold's API.
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
   * work: `visible()` is derived from the *host*, not from this snapshot,
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
  // The host: every mode wired in, in seat order (PLUGIN-PROTOCOLS §6a). That order is
  // the order of the switch, so nothing here sorts.
  const modes = kernel.ports.collect<DocumentMode>("modes");

  kernel.settings.defineSchema({
    [SETTING_DEFAULT_MODE]: {
      type: "string",
      label: "Open documents in",
      description:
        "Which mode a document opens in when you have not switched modes on it. " +
        "The options are whatever modes are installed.",
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
  liveSurface = surface;
  const router = kernel.ports.use<RouterService>("router");

  kernel.ports.offer<Route>("route", { path: "/doc/:id", view: "document.surface" });
  kernel.ports.offer<MainView>("view", {
    id: "document.surface",
    title: "Document",
    component: (props: { readonly params?: Readonly<Record<string, string>> }) => (
      <SurfaceView surface={surface} router={router} params={props.params} />
    ),
  });

  /**
   * "Open documents in" — the screen for the setting declared above.
   *
   * Offered on the `settings` port without depending on `settings`: an offer reaches
   * whichever host the wiring seats it on, and the protocol is an opaque name to the
   * kernel. A hard dependency would buy nothing and would make read/edit mode
   * disappear the day a workspace replaces the settings shell.
   */
  kernel.ports.offer<SettingsSection>("settings", {
    id: "documents",
    title: "Documents",
    order: 20,
    description: "How a document opens.",
    component: () => (
      <DefaultModeSection
        kernel={kernel}
        // Seat order: the same order every mode switcher in the app shows.
        modes={() => modes.get()}
        onModesChange={(listener) => modes.subscribe(() => listener())}
        // Not the raw stored value: `resolveModeId` is the same precedence the surface
        // opens a document with, so the select shows the mode that would actually be
        // used — including when the stored preference names a mode nobody installed.
        defaultMode={() => resolveModeId(undefined, surface.preferredMode(), modes.get())}
        setDefaultMode={(modeId) => surface.setPreferredMode(modeId)}
        rememberedCount={() => surface.rememberedCount()}
        forgetRemembered={() => surface.forgetRemembered()}
      />
    ),
  });

  kernel.ports.offer<Command>("commands", {
    id: "document.nextMode",
    title: "Switch document mode",
    category: "Document",
    when: () => surface.snapshot.documentId !== undefined,
    run: () => {
      const next = nextModeId(surface.visible(), api.activeMode());
      if (next) void api.setMode(next);
    },
  });
  kernel.ports.offer<KeybindingDefault>("keys", { command: "document.nextMode", keys: "Mod+E" });

  // One command per wired mode, so the palette can jump straight to a mode and a user
  // can bind a key to it. Modes arrive over the lifetime of the boot (and can be
  // withdrawn when a plugin fails), so this tracks the host rather than reading it
  // once — `subscribe` fires immediately and on every change.
  const modeCommands = new Map<string, { dispose(): void }>();
  modes.subscribe((values) => {
    const seen = new Set<string>();
    for (const mode of values) {
      seen.add(mode.id);
      if (modeCommands.has(mode.id)) continue;
      modeCommands.set(
        mode.id,
        kernel.ports.offer<Command>("commands", {
          id: `document.mode.${mode.id}`,
          title: `Show document as: ${mode.label}`,
          category: "Document",
          // Both halves are needed. The mode has to be registered *and* there has to be
          // a document to show it on: with only the first test these sat in the palette
          // from every other view — Trash, search, settings — and running one did
          // nothing at all, which is a dead button with a promising name.
          when: () =>
            surface.snapshot.documentId !== undefined &&
            surface.visible().some((candidate) => candidate.id === mode.id),
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
  /**
   * Whether the mode on screen was picked by the user (`setMode`) rather than resolved.
   * Only a picked mode is sticky when the registry changes: modes arrive one plugin at a
   * time on a cold boot, and a resolved one is just "the best of what had loaded so far".
   */
  #chosen = false;

  constructor(
    readonly kernel: Kernel,
    private readonly point: SlotHost<DocumentMode>,
  ) {
    // A mode offered (or withdrawn) after the document is on screen can change which
    // mode should be active — an uninstalled editor must fall back to reading.
    this.point.subscribe(() => {
      if (this.#snapshot.documentId === undefined) return;
      // Re-resolved from scratch unless the user picked the current mode. On a reload
      // straight into a document, `editor` activates before `viewer`, so `edit` was the
      // only candidate when the document first resolved — keeping it would override a
      // "Read" preference on every refresh.
      const mode = this.#resolve(this.#chosen ? this.#snapshot.mode : undefined);
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
   * Which plugin offered a mode. Attribution comes from the host, never from the
   * item's own `id` — `read` is a mode id, not a plugin id, and an error boundary
   * that named the wrong plugin would send the reader to the wrong admin row.
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
    this.#chosen = false;
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
    this.#chosen = true;
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

  /**
   * The user's "open documents in" preference, or `undefined` when none is stored.
   * Public for the settings section; the resolver uses the private one.
   */
  preferredMode(): string | undefined {
    return this.#preferredMode();
  }

  /** Store the preference. Takes effect on the next document opened, not on this one. */
  async setPreferredMode(modeId: string): Promise<void> {
    await this.kernel.settings.set(SETTING_DEFAULT_MODE, modeId);
  }

  /** How many documents have a remembered mode that outranks the preference. */
  rememberedCount(): number {
    return this.#memoryMap().size;
  }

  /**
   * Drop every remembered per-document mode, so the preference applies everywhere.
   *
   * The pending coalesced write is cancelled first: it holds the *old* map and would
   * put the whole memory back a fraction of a second after it was cleared.
   */
  async forgetRemembered(): Promise<void> {
    if (this.#memoryTimer !== undefined) {
      clearTimeout(this.#memoryTimer);
      this.#memoryTimer = undefined;
    }
    this.#memory = new Map();
    await this.kernel.settings.set(SETTING_MODE_MEMORY, []);
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

  /** Write a pending mode memory now: the plugin is stopping (§6c). */
  flush(): void {
    if (this.#memoryTimer === undefined) return;
    clearTimeout(this.#memoryTimer);
    this.#writeMemory();
  }

  #scheduleMemoryWrite(): void {
    if (this.#memoryTimer !== undefined) clearTimeout(this.#memoryTimer);
    this.#memoryTimer = setTimeout(() => this.#writeMemory(), MEMORY_WRITE_DELAY_MS);
  }

  #writeMemory(): void {
    this.#memoryTimer = undefined;
    const value = serializeModeMemory(this.#memoryMap());
    // A settings write is a CRDT splice into the per-user settings document; it can
    // fail (offline, not implemented yet) and a mode tab must not surface that.
    void Promise.resolve()
      .then(() => this.kernel.settings.set(SETTING_MODE_MEMORY, [...value]))
      .catch((error: unknown) =>
        this.kernel.log.debug("could not persist the document mode", error),
      );
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
    point: "document.mode",
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
    point: "document.mode#icon",
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
    <span className="docsurface:inline-flex docsurface:shrink-0 docsurface:leading-none">
      <Icon node={mode.icon} />
    </span>
  );
}

function SurfaceView({
  surface,
  router,
  params,
}: {
  readonly surface: Surface;
  readonly router: RouterService;
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

  // `?line=N`, followed live. The router notifies on a **query-only** change too
  // (`fullPath` keeps the query, deliberately), which is what makes a second search
  // result in the same document move the cursor instead of doing nothing.
  const [line, setLine] = useState<number | undefined>(() => lineFromPath(router.current()));
  useEffect(() => router.onChange((path) => setLine(lineFromPath(path))), [router]);

  // Navigation, not mounting, drives what is open — `show` is idempotent for the same
  // id, and `close` on unmount is the release that the handle's ref count needs.
  useEffect(() => {
    surface.show(id);
  }, [surface, id]);
  useEffect(() => () => surface.close(), [surface]);

  if (id === undefined) {
    return (
      <div className="docsurface-root docsurface-empty docsurface:flex docsurface:h-full docsurface:min-h-0 docsurface:min-w-0 docsurface:max-w-[62ch] docsurface:flex-col docsurface:px-4 docsurface:py-6 docsurface:font-sans docsurface:text-text-muted">
        <p>No document selected.</p>
      </div>
    );
  }

  if (snapshot.status === "loading") {
    return (
      <div className="docsurface-root docsurface-empty docsurface:flex docsurface:h-full docsurface:min-h-0 docsurface:min-w-0 docsurface:max-w-[62ch] docsurface:flex-col docsurface:px-4 docsurface:py-6 docsurface:font-sans docsurface:text-text-muted" aria-busy="true">
        <p>Opening the document…</p>
      </div>
    );
  }

  if (snapshot.status === "missing" || !snapshot.row) {
    return (
      <div className="docsurface-root docsurface-empty docsurface:flex docsurface:h-full docsurface:min-h-0 docsurface:min-w-0 docsurface:max-w-[62ch] docsurface:flex-col docsurface:px-4 docsurface:py-6 docsurface:font-sans docsurface:text-text-muted">
        <h1 className="docsurface-title docsurface:mb-2 docsurface:mt-0 docsurface:break-words docsurface:text-lg docsurface:font-semibold docsurface:leading-[1.3] docsurface:text-text">Document not found</h1>
        <p>
          No document with the id <code className="docsurface:break-words docsurface:font-mono docsurface:text-sm">{id}</code>. It may have been
          deleted, or this device may still be syncing.
        </p>
      </div>
    );
  }

  const row = snapshot.row;
  const visible = surface.visible();
  const active = visible.find((mode) => mode.id === snapshot.mode) ?? visible[0];

  return (
    <div className="docsurface-root docsurface:flex docsurface:h-full docsurface:min-h-0 docsurface:min-w-0 docsurface:flex-col docsurface:font-sans docsurface:text-text">
      <header className="docsurface:flex docsurface:items-center docsurface:gap-2 docsurface:border-b docsurface:border-border docsurface:px-4 docsurface:py-2 docsurface:compact:px-2">
        <h1 className="docsurface-title docsurface:m-0 docsurface:min-w-0 docsurface:flex-1 docsurface:break-words docsurface:text-lg docsurface:font-semibold docsurface:leading-[1.3] docsurface:compact:text-base">{row.title}</h1>
        <SaveState kernel={surface.kernel} />
        <ModeTabs surface={surface} modes={visible} activeId={active?.id} />
      </header>
      <ModeBubble surface={surface} modes={visible} activeId={active?.id} />

      {row.deleted ? <TrashedBanner surface={surface} row={row} /> : null}
      {/*
        `fm_parse_error` used to get a full-width notice here, and that was one
        rendering too many and one layer too high. Too many: `viewer`'s read-mode header
        warns beside the rows the dropped line is missing from — two statements of one
        fact, stacked on the same screen. Too high: this plugin owns the route and the mode
        registry and knows nothing else about a document (SPEC §6.5), and a
        frontmatter-shaped notice above every mode is knowledge about the text.

        The correction that followed: **each mode says it for itself.** Removing the
        notice from here left *edit* mode with no warning at all — the read-mode header
        does not render there — so `editor` now carries its own, which is also where the read-mode
        warning tells the reader to go. Three renderers, one per surface that shows
        `fm` or the text it comes from, and none of them this one.
      */}
      {snapshot.hydrationError && !snapshot.handle ? (
        <p className="docsurface:m-0 docsurface:border-b docsurface:border-border docsurface:bg-bg-subtle docsurface:px-4 docsurface:py-2 docsurface:text-sm docsurface:text-text-muted" role="status">
          {editableMessage(snapshot.hydrationError)}
        </p>
      ) : null}

      <section
        // Room at the end on a phone, so the floating mode button never sits over the
        // last lines of a document scrolled to the bottom.
        className={`docsurface-pane docsurface:flex docsurface:min-h-0 docsurface:min-w-0 docsurface:flex-1 docsurface:flex-col docsurface:overflow-auto ${visible.length > 1 ? "docsurface:compact:pb-[calc(5rem+var(--lm-safe-bottom))]" : ""}`}
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
            line={line}
            unavailable={Boolean(snapshot.hydrationError && !snapshot.handle)}
          />
        ) : (
          <p className="docsurface:max-w-[62ch] docsurface:px-4 docsurface:py-6 docsurface:text-text-muted">
            No plugin can display a document. Ask an administrator to install one.
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
  line,
  unavailable,
}: {
  readonly kernel: Kernel;
  readonly mode: DocumentMode;
  readonly owner: string | undefined;
  readonly id: DocumentId;
  readonly row: DocumentRow;
  readonly open?: OpenDocument;
  readonly line?: number;
  readonly unavailable: boolean;
}): ReactNode {
  const Component = boundaryFor(kernel, mode, owner);
  // Spread rather than `line={line}`: `exactOptionalPropertyTypes` is on, so an
  // absent line has to be an absent *prop*, not a prop whose value is `undefined`.
  return (
    <Component
      id={id}
      row={row}
      open={open}
      {...(line !== undefined ? { line } : {})}
      {...(unavailable ? { unavailable } : {})}
    />
  );
}

/** Why the document cannot be edited, in words: the kernel's reason is for the log. */
function editableMessage(reason: string | undefined): string {
  if (reason && /offline/i.test(reason)) {
    return "This note has not been copied to this device yet, so it cannot be edited offline. You can read it; editing works again once you are back online.";
  }
  return "This note cannot be edited right now. You can still read it.";
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
    <div className="docsurface-modes docsurface:flex docsurface:gap-0.5 docsurface:rounded docsurface:border docsurface:border-border docsurface:bg-bg-subtle docsurface:p-0.5 docsurface:compact:hidden" role="tablist" aria-label="Document mode" ref={container}>
      {modes.map((mode, index) => {
        const selected = mode.id === activeId;
        return (
          <button
            key={mode.id}
            id={`docsurface-tab-${mode.id}`}
            type="button"
            role="tab"
            // Icon-only and short: the app's button tap height is a phone rule, and on a
            // phone this control is not shown (`ModeBubble` is).
            className={`docsurface:inline-flex docsurface:h-7 docsurface:min-h-0! docsurface:cursor-pointer docsurface:items-center docsurface:justify-center docsurface:gap-1 docsurface:rounded-[calc(var(--lm-radius)-1px)] docsurface:border-0 docsurface:bg-transparent docsurface:py-0! docsurface:text-sm docsurface:text-text-muted docsurface:hover:text-text docsurface:aria-selected:bg-bg-raised docsurface:aria-selected:text-accent docsurface:aria-selected:shadow-1 docsurface:focus-visible:outline-2 docsurface:focus-visible:outline-offset-1 docsurface:focus-visible:outline-focus ${hasIcon(mode) ? "docsurface:w-8 docsurface:px-0!" : "docsurface:px-2.5"}`}
            aria-label={mode.label}
            title={mode.label}
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
            {hasIcon(mode) ? (
              <ModeIcon surface={surface} mode={mode} />
            ) : (
              <span className="docsurface:truncate">{mode.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function hasIcon(mode: DocumentMode): boolean {
  return mode.icon !== undefined && mode.icon !== null && mode.icon !== false;
}

/**
 * The phone's mode switch, bottom-right where a thumb already is. Any number of modes:
 *
 * - **Two** (read and edit): one round button that switches straight to the other mode
 *   and shows *its* icon — the pencil while reading, the book while editing.
 * - **More**: the button shows the current mode, and a tap fans the others out above
 *   it, one round button each, with their labels beside them; picking one switches, and
 *   a tap anywhere else (or Escape) folds them away.
 */
function ModeBubble({
  surface,
  modes,
  activeId,
}: {
  readonly surface: Surface;
  readonly modes: readonly DocumentMode[];
  readonly activeId: string | undefined;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (modes.length < 2) return null;
  const current = modes.find((mode) => mode.id === activeId) ?? modes[0];
  const others = modes.filter((mode) => mode !== current);
  const toggle = modes.length === 2;
  const shown = toggle ? others[0] : current;
  if (!shown || !current) return null;

  const face = (mode: DocumentMode): ReactNode =>
    hasIcon(mode) ? (
      <ModeIcon surface={surface} mode={mode} />
    ) : (
      <span className="docsurface:text-xs docsurface:font-semibold">{mode.label.slice(0, 2)}</span>
    );

  return (
    <div
      ref={root}
      className="docsurface-mode-bubble docsurface:hidden docsurface:compact:flex docsurface:fixed docsurface:right-[calc(1rem+var(--lm-safe-right))] docsurface:bottom-[calc(1rem+var(--lm-safe-bottom))] docsurface:z-10 docsurface:flex-col docsurface:items-end docsurface:gap-3"
    >
      {open && (
        <ul className="docsurface:m-0 docsurface:flex docsurface:list-none docsurface:flex-col docsurface:items-end docsurface:gap-2 docsurface:p-0 docsurface:pr-1" aria-label="Document modes">
          {others.map((mode) => (
            <li key={mode.id} className="docsurface:flex docsurface:items-center docsurface:gap-2">
              <span aria-hidden="true" className="docsurface:rounded docsurface:bg-bg-raised docsurface:px-2 docsurface:py-1 docsurface:text-sm docsurface:text-text docsurface:shadow-1">
                {mode.label}
              </span>
              <button
                type="button"
                className="docsurface:flex docsurface:size-12 docsurface:cursor-pointer docsurface:items-center docsurface:justify-center docsurface:rounded-full docsurface:border docsurface:border-border docsurface:bg-bg-raised docsurface:p-0 docsurface:text-lg docsurface:text-text docsurface:shadow-2"
                aria-label={`Switch to ${mode.label}`}
                onClick={() => {
                  setOpen(false);
                  void surface.setMode(mode.id);
                }}
              >
                {face(mode)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="docsurface:flex docsurface:size-14 docsurface:cursor-pointer docsurface:items-center docsurface:justify-center docsurface:rounded-full docsurface:border-0 docsurface:bg-accent docsurface:p-0 docsurface:text-xl docsurface:text-accent-text docsurface:shadow-2 docsurface:active:scale-95 docsurface:focus-visible:outline-2 docsurface:focus-visible:outline-offset-2 docsurface:focus-visible:outline-focus"
        {...(toggle
          ? { "aria-label": `Switch to ${shown.label}`, title: `Switch to ${shown.label}` }
          : {
              "aria-label": `${current.label} mode. Choose another`,
              title: "Document mode",
              "aria-expanded": open,
            })}
        onClick={() => {
          if (toggle) void surface.setMode(shown.id);
          else setOpen((value) => !value);
        }}
      >
        {face(shown)}
      </button>
    </div>
  );
}

/**
 * A timestamp as a person reads it, in their own locale.
 *
 * The banner used to print the stored ISO string, which is the only place in the app
 * that shows a user a `Z`-suffixed timestamp. Deliberately local to this plugin: `admin`
 * has the same three lines and the two must not import each other (SPEC §6.4 — a plugin
 * depends on another plugin's *API*, never its source).
 */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
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
    <p className="docsurface:m-0 docsurface:border-b docsurface:border-l-[3px] docsurface:border-border docsurface:border-l-danger docsurface:bg-bg-subtle docsurface:px-4 docsurface:py-2 docsurface:text-sm docsurface:text-text" role="status">
      In the Trash{row.deleted_at ? ` since ${formatWhen(row.deleted_at)}` : ""}. Restorable for
      30 days.{" "}
      <button
        type="button"
        className="docsurface:min-h-[calc(var(--lm-tap-target)-12px)] docsurface:cursor-pointer docsurface:rounded docsurface:border docsurface:border-border-strong docsurface:bg-bg-raised docsurface:px-2 docsurface:text-sm docsurface:text-text docsurface:focus-visible:outline-2 docsurface:focus-visible:outline-offset-1 docsurface:focus-visible:outline-focus"
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

/** The surface `activate` built, for its pending write; the kernel withdraws everything else (§6c). */
let liveSurface: { flush(): void } | undefined;

export function deactivate(): void {
  liveSurface?.flush();
  liveSurface = undefined;
}

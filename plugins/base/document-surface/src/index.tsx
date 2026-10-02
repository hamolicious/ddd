import type {
  DocumentId,
  DocumentRow,
  Kernel,
  OpenDocument,
  QuerySubscription,
  Registry,
  RegistryEntry,
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

import { addCommand, addKeybinding } from "plugin:commands";
import { onCreated } from "plugin:doc-events";
import { DOCUMENT_ROUTE, addRoute, current as currentPath, onChange as onPathChange } from "plugin:router";
import { addSection } from "plugin:settings";
import { addView } from "plugin:shell-ui";

import { modeRegistry, type DocumentMode, type DocumentModeProps } from "./api.js";
import { lineFromPath } from "./line.js";
import { SaveState } from "./SaveState.js";
import { DefaultModeSection } from "./SettingsSection.js";
import {
  claimedModeId,
  DEFAULT_MODE_ID,
  nextModeId,
  parseModeMemory,
  rememberMode,
  resolveModeId,
  serializeModeMemory,
  visibleModes as visibleOf,
} from "./modes.js";

export { LINE_PARAM, lineFromPath } from "./line.js";
export type { DocumentMode, DocumentModeProps } from "./api.js";

export interface DocumentSurfaceState {
  readonly documentId?: string;
  readonly mode?: string;
  readonly row?: DocumentRow;
}

export interface DocumentSurfaceApi {
  addMode(modes: DocumentMode | readonly DocumentMode[]): () => void;
  modes(): readonly DocumentMode[];
  visibleModes(): readonly DocumentMode[];
  currentDocument(): string | undefined;
  currentHandle(): OpenDocument | undefined;
  currentRow(): DocumentRow | undefined;
  activeMode(): string | undefined;
  setMode(modeId: string): Promise<void>;
  onChange(listener: (state: DocumentSurfaceState) => void): Unsubscribe;
}

export const addMode: (modes: DocumentMode | readonly DocumentMode[]) => () => void = modeRegistry.add;

export function modes(): readonly DocumentMode[] {
  return modeRegistry.get();
}

export function modeEntries(): readonly RegistryEntry<DocumentMode>[] {
  return modeRegistry.entries();
}

export function onModesChange(listener: (modes: readonly DocumentMode[]) => void): Unsubscribe {
  return modeRegistry.subscribe(listener);
}

export function visibleModes(): readonly DocumentMode[] {
  return liveSurface?.visible() ?? [];
}

export function currentDocument(): string | undefined {
  return liveSurface?.snapshot.documentId;
}

export function currentHandle(): OpenDocument | undefined {
  return liveSurface?.snapshot.handle;
}

export function currentRow(): DocumentRow | undefined {
  return liveSurface?.snapshot.row;
}

export function activeMode(): string | undefined {
  return liveSurface?.snapshot.mode;
}

export function setMode(modeId: string): Promise<void> {
  return requireSurface().setMode(modeId);
}

export function onChange(listener: (state: DocumentSurfaceState) => void): Unsubscribe {
  const surface = requireSurface();
  return surface.subscribe(() => {
    const { documentId, mode, row } = surface.snapshot;
    listener({ documentId, mode, row });
  });
}

function requireSurface(): Surface {
  if (!liveSurface) throw new Error("document-surface is not active yet");
  return liveSurface;
}
interface RouterService {
  current(): string;
  onChange(listener: (path: string) => void): () => void;
}

type SurfaceStatus = "idle" | "loading" | "ready" | "missing";

interface Snapshot {
  readonly documentId?: DocumentId;
  readonly row?: DocumentRow;
  readonly handle?: OpenDocument;
  readonly mode?: string;
  readonly status: SurfaceStatus;
  readonly hydrationError?: string;
  readonly revision: number;
}

const SETTING_DEFAULT_MODE = "defaultMode";
const SETTING_MODE_MEMORY = "modeMemory";
const MEMORY_WRITE_DELAY_MS = 750;

const byId = (id: DocumentId): Record<string, unknown> => ({
  cmp: { field: "id", op: "eq", value: { str: id } },
});

export default function activate(kernel: Kernel): void {
  const modes = modeRegistry;

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
  const router: RouterService = { current: currentPath, onChange: onPathChange };

  addRoute({ path: DOCUMENT_ROUTE, view: "document.surface" });
  addView({
    id: "document.surface",
    title: "Document",
    component: (props: { readonly params?: Readonly<Record<string, string>> }) => (
      <SurfaceView surface={surface} router={router} params={props.params} />
    ),
  });

  addSection({
    id: "documents",
    title: "Documents",
    order: 20,
    description: "How a document opens.",
    component: () => (
      <DefaultModeSection
        kernel={kernel}
        modes={() => modes.get().filter((mode) => mode.when === undefined)}
        onModesChange={(listener) => modes.subscribe(() => listener())}
        defaultMode={() => resolveModeId(undefined, surface.preferredMode(), modes.get())}
        setDefaultMode={(modeId) => surface.setPreferredMode(modeId)}
        rememberedCount={() => surface.rememberedCount()}
        forgetRemembered={() => surface.forgetRemembered()}
      />
    ),
  });

  addCommand({
    id: "document.nextMode",
    title: "Switch document mode",
    category: "Document",
    when: () => surface.snapshot.documentId !== undefined,
    run: () => {
      const next = nextModeId(surface.visible(), surface.snapshot.mode);
      if (next) void surface.setMode(next);
    },
  });
  addKeybinding({ command: "document.nextMode", keys: "Mod+E" });

  const modeCommands = new Map<string, () => void>();
  stopModeCommands = modes.subscribe((values) => {
    const seen = new Set<string>();
    for (const mode of values) {
      seen.add(mode.id);
      if (modeCommands.has(mode.id)) continue;
      modeCommands.set(
        mode.id,
        addCommand({
          id: `document.mode.${mode.id}`,
          title: `Show document as: ${mode.label}`,
          category: "Document",
          when: () =>
            surface.snapshot.documentId !== undefined &&
            surface.visible().some((candidate) => candidate.id === mode.id),
          run: () => surface.setMode(mode.id),
        }),
      );
    }
    for (const [id, remove] of modeCommands) {
      if (seen.has(id)) continue;
      remove();
      modeCommands.delete(id);
    }
  });
}

let stopModeCommands: Unsubscribe | undefined;

class Surface {
  #snapshot: Snapshot = { status: "idle", revision: 0 };
  #revision = 0;
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #query: QuerySubscription | undefined;
  #queryOff: Unsubscribe | undefined;
  #memory: Map<string, string> | undefined;
  #memoryTimer: ReturnType<typeof setTimeout> | undefined;
  #chosen = false;
  readonly #created = new Set<DocumentId>();
  #fresh = false;

  constructor(
    readonly kernel: Kernel,
    private readonly point: Registry<DocumentMode>,
  ) {
    onCreated(({ id }) => this.#created.add(id));
    this.point.subscribe(() => {
      if (this.#snapshot.documentId === undefined) return;
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

  ownerOf(mode: DocumentMode): string | undefined {
    return this.point.entries().find((entry) => entry.value === mode)?.pluginId;
  }

  visible(): readonly DocumentMode[] {
    return visibleOf(this.point.get(), this.#snapshot.row, (mode, error) =>
      this.kernel.log.warn(`document.mode "${mode.id}" threw from when()`, error),
    );
  }

  show(id: DocumentId | undefined): void {
    if (id === this.#snapshot.documentId) return;
    const generation = ++this.#generation;
    this.#chosen = false;
    this.#fresh = id !== undefined && this.#created.delete(id);
    this.#teardown();
    if (id === undefined) {
      this.#set({ status: "idle" });
      return;
    }
    this.#set({ documentId: id, status: "loading" });
    void this.#watchRow(id, generation);
    void this.#hydrate(id, generation);
  }

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

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #emit(): void {
    this.#snapshot = { ...this.#snapshot, revision: ++this.#revision };
    this.#notify();
  }

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
    this.#snapshot.handle?.release();
  }

  async #watchRow(id: DocumentId, generation: number): Promise<void> {
    const apply = (row: DocumentRow | undefined): void => {
      if (generation !== this.#generation) return;
      const blind = this.#snapshot.row === undefined && !this.#chosen;
      const mode = this.#resolve(blind ? undefined : this.#snapshot.mode, id, row);
      this.#patch({ row, status: row ? "ready" : "missing", mode });
    };
    try {
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
    const shown = row ?? this.#snapshot.row;
    const visible = visibleOf(this.point.get(), shown);
    if (current !== undefined && visible.some((mode) => mode.id === current)) return current;
    const forNew = this.#fresh ? visible.find((mode) => mode.forNew === true) : undefined;
    if (forNew !== undefined) return forNew.id;
    const remembered = documentId === undefined ? undefined : this.#memoryMap().get(documentId);
    const claimed = claimedModeId(visible, shown, (mode, error) =>
      this.kernel.log.warn(`document.mode "${mode.id}" threw from prefer()`, error),
    );
    return resolveModeId(remembered, this.#preferredMode(), visible, claimed);
  }

  preferredMode(): string | undefined {
    return this.#preferredMode();
  }

  async setPreferredMode(modeId: string): Promise<void> {
    await this.kernel.settings.set(SETTING_DEFAULT_MODE, modeId);
  }

  rememberedCount(): number {
    return this.#memoryMap().size;
  }

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
    void Promise.resolve()
      .then(() => this.kernel.settings.set(SETTING_MODE_MEMORY, [...value]))
      .catch((error: unknown) =>
        this.kernel.log.debug("could not persist the document mode", error),
      );
  }
}

const wrapped = new WeakMap<ComponentType<DocumentModeProps>, ComponentType<DocumentModeProps>>();

function boundaryFor(
  kernel: Kernel,
  mode: DocumentMode,
  pluginId: string | undefined,
): ComponentType<DocumentModeProps> {
  const existing = wrapped.get(mode.component);
  if (existing) return existing;
  const component = kernel.ui.boundary(mode.component, {
    point: "document-surface.mode",
    ...(pluginId === undefined ? {} : { pluginId }),
  });
  wrapped.set(mode.component, component);
  return component;
}

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
    point: "document-surface.mode#icon",
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
  const id = raw === undefined ? undefined : safeDecode(raw);

  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => surface.subscribe(listener), [surface]),
    () => surface.snapshot,
  );

  const [line, setLine] = useState<number | undefined>(() => lineFromPath(router.current()));
  useEffect(() => router.onChange((path) => setLine(lineFromPath(path))), [router]);

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
      {snapshot.hydrationError && !snapshot.handle ? (
        <p className="docsurface:m-0 docsurface:border-b docsurface:border-border docsurface:bg-bg-subtle docsurface:px-4 docsurface:py-2 docsurface:text-sm docsurface:text-text-muted" role="status">
          {editableMessage(snapshot.hydrationError)}
        </p>
      ) : null}

      <section
        className={`docsurface-pane docsurface:flex docsurface:min-h-0 docsurface:min-w-0 docsurface:flex-1 docsurface:flex-col docsurface:overflow-auto ${visible.length > 1 ? "docsurface:compact:pb-[calc(5rem+var(--ddd-safe-bottom))]" : ""}`}
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

function editableMessage(reason: string | undefined): string {
  if (reason && /offline/i.test(reason)) {
    return "This note has not been copied to this device yet, so it cannot be edited offline. You can read it; editing works again once you are back online.";
  }
  return "This note cannot be edited right now. You can still read it.";
}

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
            className={`docsurface:inline-flex docsurface:h-7 docsurface:min-h-0! docsurface:cursor-pointer docsurface:items-center docsurface:justify-center docsurface:gap-1 docsurface:rounded-[calc(var(--ddd-radius)-1px)] docsurface:border-0 docsurface:bg-transparent docsurface:py-0! docsurface:text-sm docsurface:text-text-muted docsurface:hover:text-text docsurface:aria-selected:bg-bg-raised docsurface:aria-selected:text-accent docsurface:aria-selected:shadow-1 docsurface:focus-visible:outline-2 docsurface:focus-visible:outline-offset-1 docsurface:focus-visible:outline-focus ${hasIcon(mode) ? "docsurface:w-8 docsurface:px-0!" : "docsurface:px-2.5"}`}
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
      className="docsurface-mode-bubble docsurface:hidden docsurface:compact:flex docsurface:fixed docsurface:right-[calc(1rem+var(--ddd-safe-right))] docsurface:bottom-[calc(1rem+max(var(--ddd-safe-bottom),var(--shell-footer-height,0px)))] docsurface:z-10 docsurface:flex-col docsurface:items-end docsurface:gap-3"
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
        className="docsurface:min-h-[calc(var(--ddd-tap-target)-12px)] docsurface:cursor-pointer docsurface:rounded docsurface:border docsurface:border-border-strong docsurface:bg-bg-raised docsurface:px-2 docsurface:text-sm docsurface:text-text docsurface:focus-visible:outline-2 docsurface:focus-visible:outline-offset-1 docsurface:focus-visible:outline-focus"
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

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cssEscape(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "\\$&");
}

let liveSurface: Surface | undefined;

export function deactivate(): void {
  stopModeCommands?.();
  stopModeCommands = undefined;
  liveSurface?.flush();
  liveSurface = undefined;
}

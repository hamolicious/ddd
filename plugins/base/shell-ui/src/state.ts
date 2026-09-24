/**
 * The shell's own state: which `main.view` is showing, whether the sidebar is
 * open, and whether we are below the mobile breakpoint.
 *
 * It lives outside React because two of the three are driven from *outside* the
 * React tree — the router calls `setMainView` during its own activation, and
 * `matchMedia` fires whenever the window crosses the breakpoint — and because
 * `ShellUiApi` has to answer `isCompact()` synchronously for dependents that are
 * not components at all.
 *
 * `snapshot()` returns a cached immutable object so `useSyncExternalStore` can use
 * it directly: a fresh object per call would re-render forever.
 */

import type { Unsubscribe } from "@kernel";

/** SPEC §6.5's mobile breakpoint. Below it: drawer sidebar, single pane. */
export const COMPACT_QUERY = "(max-width: 640px)";

/** Where the per-device panel collapse state is remembered. */
const PANELS_KEY = "life-manager.shell-ui.panels";

export interface ViewSelection {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface ShellSnapshot {
  readonly view: ViewSelection | undefined;
  readonly compact: boolean;
  /** Desktop: the sidebar column is shown. Compact: the drawer is open. */
  readonly sidebarOpen: boolean;
}

const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze({});

export class ShellState {
  readonly #listeners = new Set<() => void>();
  readonly #layoutListeners = new Set<(compact: boolean) => void>();
  readonly #media: MediaQueryList | undefined;
  #snapshot: ShellSnapshot;
  #panels: Record<string, boolean>;

  constructor() {
    const media = typeof matchMedia === "function" ? matchMedia(COMPACT_QUERY) : undefined;
    this.#media = media;
    const compact = media?.matches ?? false;
    this.#snapshot = { view: undefined, compact, sidebarOpen: !compact };
    this.#panels = readPanels();
    media?.addEventListener("change", () => this.#onBreakpoint());
  }

  snapshot = (): ShellSnapshot => this.#snapshot;

  subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get compact(): boolean {
    return this.#snapshot.compact;
  }

  onLayoutChange(listener: (compact: boolean) => void): Unsubscribe {
    this.#layoutListeners.add(listener);
    return () => this.#layoutListeners.delete(listener);
  }

  setMainView(id: string, params?: Readonly<Record<string, string>>): void {
    const current = this.#snapshot.view;
    const next: ViewSelection = { id, params: params ?? EMPTY_PARAMS };
    if (current && current.id === next.id && sameParams(current.params, next.params)) return;
    // Navigating on a phone closes the drawer: single pane means the view the user
    // just asked for has to be the thing they see (SPEC §6.5).
    const sidebarOpen = this.#snapshot.compact ? false : this.#snapshot.sidebarOpen;
    this.#set({ view: next, sidebarOpen });
  }

  toggleSidebar(open?: boolean): void {
    const next = open ?? !this.#snapshot.sidebarOpen;
    if (next === this.#snapshot.sidebarOpen) return;
    this.#set({ sidebarOpen: next });
  }

  /** Whether a sidebar panel is expanded; `defaultOpen` decides the first time. */
  panelOpen(id: string, defaultOpen: boolean): boolean {
    return this.#panels[id] ?? defaultOpen;
  }

  setPanelOpen(id: string, open: boolean): void {
    this.#panels = { ...this.#panels, [id]: open };
    writePanels(this.#panels);
    // The snapshot identity has to change or `useSyncExternalStore` will not re-read.
    this.#set({});
  }

  #onBreakpoint(): void {
    const compact = this.#media?.matches ?? false;
    if (compact === this.#snapshot.compact) return;
    // Crossing into compact closes the drawer; crossing out restores the column.
    this.#set({ compact, sidebarOpen: !compact });
    for (const listener of [...this.#layoutListeners]) listener(compact);
  }

  #set(patch: Partial<ShellSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }
}

function sameParams(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

function readPanels(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(PANELS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  } catch {
    // Private mode, or somebody else's JSON. Defaults are always correct.
    return {};
  }
}

function writePanels(panels: Record<string, boolean>): void {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
  } catch {
    // Per-device convenience only — never worth failing a render over.
  }
}

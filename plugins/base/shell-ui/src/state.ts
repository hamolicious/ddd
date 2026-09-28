/**
 * The shell's own state: which `main.view` is showing, whether the sidebar and the
 * altbar are open, and whether we are below the mobile breakpoint.
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

import { COMPACT_MEDIA_QUERY } from "../../_shared/compact.js";
import type { ShellLayout } from "../../_shared/shell-api.js";

/**
 * SPEC §6.5's mobile breakpoint: drawer sidebar, single pane.
 *
 * The string is `_shared/compact.ts`'s, not this file's, because every Tailwind plugin
 * uses the shared `compact:` variant and a layout that disagrees with `isCompact()` is
 * worse than either behaviour alone.
 */
export const COMPACT_QUERY = COMPACT_MEDIA_QUERY;

/** Where the per-device panel collapse state is remembered. */
const PANELS_KEY = "life-manager.shell-ui.panels";
/** Whether the altbar column is shown on a wide screen, per device. */
const ALTBAR_KEY = "life-manager.shell-ui.altbar";

export interface ViewSelection {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface ShellSnapshot {
  readonly view: ViewSelection | undefined;
  readonly compact: boolean;
  /** Desktop: the sidebar column is shown. Compact: the drawer is open. */
  readonly sidebarOpen: boolean;
  readonly hasSidebar: boolean;
  /** Desktop: the altbar column is shown. Compact: its drawer is open. */
  readonly altbarOpen: boolean;
  /** Some `altbar.panel` has something to say about the current view. */
  readonly hasAltbar: boolean;
}

const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze({});

export class ShellState {
  readonly #listeners = new Set<() => void>();
  readonly #layoutListeners = new Set<(compact: boolean) => void>();
  readonly #media: MediaQueryList | undefined;
  #snapshot: ShellSnapshot;
  #layout: ShellLayout;
  #panels: Record<string, boolean>;

  constructor() {
    const media = typeof matchMedia === "function" ? matchMedia(COMPACT_QUERY) : undefined;
    this.#media = media;
    const compact = media?.matches ?? false;
    const altbarOpen = !compact && readAltbar();
    this.#snapshot = {
      view: undefined,
      compact,
      sidebarOpen: !compact,
      hasSidebar: false,
      altbarOpen,
      hasAltbar: false,
    };
    this.#layout = { compact, sidebarOpen: !compact, hasSidebar: false, altbarOpen, hasAltbar: false };
    this.#panels = readPanels();
    media?.addEventListener("change", this.#onChange);
  }

  readonly #onChange = (): void => this.#onBreakpoint();

  /** Stop listening to the breakpoint: the plugin is being unplugged or restarted. */
  dispose(): void {
    this.#media?.removeEventListener("change", this.#onChange);
    this.#listeners.clear();
    this.#layoutListeners.clear();
  }

  snapshot = (): ShellSnapshot => this.#snapshot;

  subscribe = (listener: () => void): Unsubscribe => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Cached: a new object only when one of its three fields changed. */
  layout = (): ShellLayout => this.#layout;

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
    const compact = this.#snapshot.compact;
    const sidebarOpen = compact ? false : this.#snapshot.sidebarOpen;
    const altbarOpen = compact ? false : this.#snapshot.altbarOpen;
    this.#set({ view: next, sidebarOpen, altbarOpen });
  }

  toggleSidebar(open?: boolean): void {
    const next = open ?? !this.#snapshot.sidebarOpen;
    if (next === this.#snapshot.sidebarOpen) return;
    // On a phone the two drawers share the screen: opening one closes the other.
    this.#set(next && this.#snapshot.compact ? { sidebarOpen: true, altbarOpen: false } : { sidebarOpen: next });
  }

  toggleAltbar(open?: boolean): void {
    const next = open ?? !this.#snapshot.altbarOpen;
    if (next === this.#snapshot.altbarOpen) return;
    if (this.#snapshot.compact) {
      this.#set(next ? { altbarOpen: true, sidebarOpen: false } : { altbarOpen: false });
      return;
    }
    writeAltbar(next);
    this.#set({ altbarOpen: next });
  }

  /** The layout reports it, from the `altbar.panel` entries that accept the current view. */
  setHasAltbar(hasAltbar: boolean): void {
    if (hasAltbar === this.#snapshot.hasAltbar) return;
    this.#set({ hasAltbar });
  }

  /** The layout reports it; the shell sets it from the live `sidebar.panel` entries. */
  setHasSidebar(hasSidebar: boolean): void {
    if (hasSidebar === this.#snapshot.hasSidebar) return;
    this.#set({ hasSidebar });
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
    // Crossing into compact closes the drawers; crossing out restores the columns.
    this.#set({ compact, sidebarOpen: !compact, altbarOpen: !compact && readAltbar() });
    for (const listener of [...this.#layoutListeners]) listener(compact);
  }

  #set(patch: Partial<ShellSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    const { compact, sidebarOpen, hasSidebar, altbarOpen, hasAltbar } = this.#snapshot;
    const layout = this.#layout;
    if (
      layout.compact !== compact ||
      layout.sidebarOpen !== sidebarOpen ||
      layout.hasSidebar !== hasSidebar ||
      layout.altbarOpen !== altbarOpen ||
      layout.hasAltbar !== hasAltbar
    ) {
      this.#layout = { compact, sidebarOpen, hasSidebar, altbarOpen, hasAltbar };
    }
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

function readAltbar(): boolean {
  try {
    return localStorage.getItem(ALTBAR_KEY) === "open";
  } catch {
    return false;
  }
}

function writeAltbar(open: boolean): void {
  try {
    localStorage.setItem(ALTBAR_KEY, open ? "open" : "closed");
  } catch {
    // Per-device convenience only.
  }
}

function writePanels(panels: Record<string, boolean>): void {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
  } catch {
    // Per-device convenience only — never worth failing a render over.
  }
}

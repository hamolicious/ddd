import type { Unsubscribe } from "@kernel";

import { COMPACT_MEDIA_QUERY } from "../../_shared/compact.js";
import type { ShellLayout } from "./api.js";

export const COMPACT_QUERY = COMPACT_MEDIA_QUERY;

const PANELS_KEY = "ddd.shell-ui.panels";
const ALTBAR_KEY = "ddd.shell-ui.altbar";

export interface ViewSelection {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface ShellSnapshot {
  readonly view: ViewSelection | undefined;
  readonly compact: boolean;
  readonly sidebarOpen: boolean;
  readonly hasSidebar: boolean;
  readonly altbarOpen: boolean;
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
    const compact = this.#snapshot.compact;
    const sidebarOpen = compact ? false : this.#snapshot.sidebarOpen;
    const altbarOpen = compact ? false : this.#snapshot.altbarOpen;
    this.#set({ view: next, sidebarOpen, altbarOpen });
  }

  toggleSidebar(open?: boolean): void {
    const next = open ?? !this.#snapshot.sidebarOpen;
    if (next === this.#snapshot.sidebarOpen) return;
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

  setHasAltbar(hasAltbar: boolean): void {
    if (hasAltbar === this.#snapshot.hasAltbar) return;
    this.#set({ hasAltbar });
  }

  setHasSidebar(hasSidebar: boolean): void {
    if (hasSidebar === this.#snapshot.hasSidebar) return;
    this.#set({ hasSidebar });
  }

  panelOpen(id: string, defaultOpen: boolean): boolean {
    return this.#panels[id] ?? defaultOpen;
  }

  setPanelOpen(id: string, open: boolean): void {
    this.#panels = { ...this.#panels, [id]: open };
    writePanels(this.#panels);
    this.#set({});
  }

  #onBreakpoint(): void {
    const compact = this.#media?.matches ?? false;
    if (compact === this.#snapshot.compact) return;
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
  }
}

function writePanels(panels: Record<string, boolean>): void {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
  } catch {
  }
}

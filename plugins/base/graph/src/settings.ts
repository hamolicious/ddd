/**
 * The graph's per-user settings: the filters, display and forces behind the controls
 * panel, stored with `kernel.settings` so they follow the person to every device.
 *
 * A slider sends a value per pixel dragged, and each stored value is a CRDT write to the
 * settings document. So the view reads and changes a local copy at once, and the copy
 * is written a moment after the last change to each key.
 */

import type { Kernel, SettingsSchema, SettingsValue } from "@kernel";

import { DEFAULT_FILTER, type GraphFilter } from "./model.js";
import { DEFAULT_DISPLAY, type Display } from "./renderer.js";
import { DEFAULT_FORCES, type Forces } from "./simulation.js";

export interface GraphSettings {
  readonly showOrphans: boolean;
  readonly showMissing: boolean;
  readonly showEmbeds: boolean;
  readonly showFrontmatter: boolean;
  readonly arrows: boolean;
  /** Grow a node with its number of links. */
  readonly sizeByLinks: boolean;
  readonly textFade: number;
  readonly nodeSize: number;
  readonly linkThickness: number;
  readonly colorByFolder: boolean;
  readonly centerForce: number;
  readonly repelForce: number;
  readonly linkForce: number;
  readonly linkDistance: number;
  /** How many links out from the open note the local graph reaches. */
  readonly localDepth: number;
}

export const DEFAULT_SETTINGS: GraphSettings = {
  showOrphans: DEFAULT_FILTER.showOrphans,
  showMissing: DEFAULT_FILTER.showMissing,
  showEmbeds: DEFAULT_FILTER.showEmbeds,
  showFrontmatter: DEFAULT_FILTER.showFrontmatter,
  arrows: DEFAULT_DISPLAY.arrows,
  sizeByLinks: DEFAULT_DISPLAY.sizeByLinks,
  textFade: DEFAULT_DISPLAY.textFade,
  nodeSize: DEFAULT_DISPLAY.nodeSize,
  linkThickness: DEFAULT_DISPLAY.linkThickness,
  colorByFolder: DEFAULT_DISPLAY.colorByFolder,
  centerForce: DEFAULT_FORCES.center,
  repelForce: DEFAULT_FORCES.repel,
  linkForce: DEFAULT_FORCES.link,
  linkDistance: DEFAULT_FORCES.linkDistance,
  localDepth: 1,
};

const LABELS: Record<keyof GraphSettings, string> = {
  showOrphans: "Show orphans",
  showMissing: "Show links to missing notes",
  showEmbeds: "Show embeds",
  showFrontmatter: "Show frontmatter links",
  arrows: "Arrows",
  sizeByLinks: "Size nodes by links",
  textFade: "Text fade threshold",
  nodeSize: "Node size",
  linkThickness: "Link thickness",
  colorByFolder: "Colour by folder",
  centerForce: "Center force",
  repelForce: "Repel force",
  linkForce: "Link force",
  linkDistance: "Link distance",
  localDepth: "Local graph depth",
};

export function settingsSchema(): SettingsSchema {
  const schema: Record<string, SettingsSchema[string]> = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    schema[key] = {
      type: typeof value === "boolean" ? "boolean" : "number",
      label: LABELS[key as keyof GraphSettings],
      default: value,
    };
  }
  return schema;
}

export const filterOf = (settings: GraphSettings, search: string): GraphFilter => ({
  search,
  showOrphans: settings.showOrphans,
  showMissing: settings.showMissing,
  showEmbeds: settings.showEmbeds,
  showFrontmatter: settings.showFrontmatter,
});

export const displayOf = (settings: GraphSettings): Display => ({
  arrows: settings.arrows,
  sizeByLinks: settings.sizeByLinks,
  textFade: settings.textFade,
  nodeSize: settings.nodeSize,
  linkThickness: settings.linkThickness,
  colorByFolder: settings.colorByFolder,
});

export const forcesOf = (settings: GraphSettings): Forces => ({
  center: settings.centerForce,
  repel: settings.repelForce,
  link: settings.linkForce,
  linkDistance: settings.linkDistance,
});

export interface SettingsStore {
  get(): GraphSettings;
  set<K extends keyof GraphSettings>(key: K, value: GraphSettings[K]): void;
  /** Every key back to its default. */
  reset(): void;
  subscribe(listener: () => void): () => void;
  /** Write every value still waiting on its timer, now: the plugin is stopping. */
  flush(): void;
}

const WRITE_DELAY_MS = 500;

export function createSettingsStore(kernel: Kernel): SettingsStore {
  const listeners = new Set<() => void>();
  const pending = new Map<keyof GraphSettings, ReturnType<typeof setTimeout>>();
  let current = read(kernel.settings.all(), DEFAULT_SETTINGS);

  const publish = (): void => {
    for (const listener of [...listeners]) listener();
  };

  kernel.settings.subscribe((values) => {
    // A key this device is still about to write keeps its local value.
    const next = read(values, current, pending);
    if (!shallowEqual(next, current)) {
      current = next;
      publish();
    }
  });

  const save = (key: keyof GraphSettings): void => {
    pending.delete(key);
    const value = current[key];
    const write = value === DEFAULT_SETTINGS[key] ? kernel.settings.remove(key) : kernel.settings.set(key, value);
    write.catch((error: unknown) => kernel.log.warn(`graph: could not save ${key}`, error));
  };

  const write = (key: keyof GraphSettings): void => {
    clearTimeout(pending.get(key));
    pending.set(key, setTimeout(() => save(key), WRITE_DELAY_MS));
  };

  return {
    get: () => current,
    set(key, value) {
      if (current[key] === value) return;
      current = { ...current, [key]: value };
      write(key);
      publish();
    },
    reset() {
      const changed = (Object.keys(DEFAULT_SETTINGS) as (keyof GraphSettings)[]).filter(
        (key) => current[key] !== DEFAULT_SETTINGS[key],
      );
      if (changed.length === 0) return;
      current = DEFAULT_SETTINGS;
      for (const key of changed) write(key);
      publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flush() {
      for (const [key, timer] of [...pending]) {
        clearTimeout(timer);
        save(key);
      }
    },
  };
}

/** Stored values over `fallback`, each checked for the right type; `keep` keys stay as in `fallback`. */
function read(
  values: Readonly<Record<string, SettingsValue>>,
  fallback: GraphSettings,
  keep: ReadonlyMap<keyof GraphSettings, unknown> = new Map(),
): GraphSettings {
  const out: Record<string, unknown> = { ...fallback };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof GraphSettings)[]) {
    if (keep.has(key)) continue;
    const value = values[key];
    out[key] = typeof value === typeof DEFAULT_SETTINGS[key] && (typeof value !== "number" || Number.isFinite(value))
      ? value
      : DEFAULT_SETTINGS[key];
  }
  return out as unknown as GraphSettings;
}

function shallowEqual(a: GraphSettings, b: GraphSettings): boolean {
  return (Object.keys(a) as (keyof GraphSettings)[]).every((key) => a[key] === b[key]);
}

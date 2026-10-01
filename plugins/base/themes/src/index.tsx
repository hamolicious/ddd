/**
 * `themes` — the theme registry and picker (SPEC §6.5).
 *
 * It **overrides** the kernel's default tokens; it does not own them. That is the
 * whole design: `kernel.ui.tokens.apply(scheme, tokens)` adds a layer over the
 * kernel's light/dark palette and returns a handle that removes exactly that layer, so
 * switching themes cannot leave a half-applied palette behind, and a workspace whose
 * `themes` plugin failed still renders legibly (SPEC §6.4 error containment plus the
 * §6.5 note about where token defaults live).
 *
 * A theme therefore only names what it changes. Two are added here — one per scheme,
 * through this plugin's own `addTheme` — which is what proves the point: every value
 * they do not mention is still the kernel's, and a third-party theme is the same four
 * fields passed to `addTheme` from its own `activate`.
 *
 * `api.ts` holds the `Theme` type and the registry, `apply.ts` the application logic (and its tests), `controller.ts` the selection
 * state, `Picker.tsx` the settings section.
 */

import { type Kernel, type Unsubscribe } from "@kernel";
import { addCommand } from "plugin:commands";
import { addSection, open as openSettings } from "plugin:settings";

import { themeRegistry, type Theme } from "./api.js";
import { ThemePicker } from "./Picker.js";
import { ThemesController } from "./controller.js";

export type { Theme } from "./api.js";

/** Everything the functions below export, as one object. */
export interface ThemesApi {
  list(): readonly Theme[];
  /** Apply a theme by id; `undefined` returns to the kernel defaults. */
  select(themeId: string | undefined): Promise<void>;
  selected(): string | undefined;
  onChange(listener: (themeId: string | undefined) => void): Unsubscribe;
}

let live: ThemesController | undefined;

function controller(): ThemesController {
  if (!live) throw new Error("themes: not active yet (call it from your own activate or later)");
  return live;
}

/** Offer a theme (or several) to the picker. Returns the function that withdraws it. */
export const addTheme: (items: Theme | readonly Theme[]) => () => void = themeRegistry.add;

/** Every installed theme. */
export function list(): readonly Theme[] {
  return themeRegistry.get();
}

/** Apply a theme by id; `undefined` returns to the kernel defaults. */
export function select(themeId: string | undefined): Promise<void> {
  return controller().select(themeId);
}

/** The selected theme's id for the painted scheme, if any. */
export function selected(): string | undefined {
  return controller().selected();
}

/** Called with the selected id after every change. */
export function onChange(listener: (themeId: string | undefined) => void): Unsubscribe {
  return controller().onChange(listener);
}

export default function activate(kernel: Kernel): void {
  kernel.settings.defineSchema({
    theme: { type: "string", label: "Light theme", description: "Theme id, or empty for the kernel default." },
    themeDark: { type: "string", label: "Dark theme", description: "Theme id, or empty for the kernel default." },
    colorScheme: {
      type: "enum",
      label: "Appearance",
      options: ["system", "light", "dark"],
      default: "system",
    },
  });

  // Examples, and the minimum a picker needs to be worth opening. Both name a handful
  // of tokens and inherit the rest — including every contrast-checked text pair.
  addTheme([
    {
      id: "warm",
      name: "Warm",
      scheme: "light",
      tokens: {
        "--ddd-bg": "#fdfaf5",
        "--ddd-bg-subtle": "#f4eee4",
        "--ddd-bg-raised": "#fffdfa",
        "--ddd-border": "#e4d9c8",
        "--ddd-accent": "#9a5b16",
        "--ddd-accent-subtle": "#f6e9d8",
        "--ddd-link": "#9a5b16",
        "--ddd-selection": "#f0dcc0",
      },
    },
    {
      id: "midnight",
      name: "Midnight",
      scheme: "dark",
      tokens: {
        "--ddd-bg": "#0d1117",
        "--ddd-bg-subtle": "#11161d",
        "--ddd-bg-raised": "#161b22",
        "--ddd-border": "#232a33",
        "--ddd-border-strong": "#38404b",
        "--ddd-accent": "#7aa2f7",
        "--ddd-accent-text": "#0b1020",
        "--ddd-accent-subtle": "#17233d",
        "--ddd-link": "#7aa2f7",
        "--ddd-focus-ring": "#7aa2f7",
        "--ddd-selection": "#243354",
      },
    },
  ]);

  const controller = new ThemesController(kernel, () => themeRegistry.get());
  live = controller;
  controller.adoptStoredAppearance();

  // Live in both directions: a theme contributed (or withdrawn with its plugin) later
  // re-resolves the stored id, and `subscribe` firing immediately is the initial apply.
  themeRegistry.subscribe(() => controller.refresh());
  // A settings change — this tab, another tab, another device through sync. Never
  // unsubscribed: a frontend plugin's lifetime is the page's (activation is
  // reload-only, SPEC §6.4).
  safeSubscribe(kernel, () => controller.reload());
  // The painted scheme changed under us (OS flip, or the appearance control).
  kernel.ui.onColorScheme(() => controller.schemeChanged());
  // A choice made while the server was unreachable is kept on the device and retried
  // here, rather than living on one device until the user picks it again. `subscribe`
  // fires immediately, so a page that starts up already synced flushes at once.
  kernel.sync.subscribe((state) => {
    if (state.status === "synced" || state.status === "syncing") {
      void controller.flushPending().catch(() => undefined);
    }
  });

  addSection({
    id: "themes",
    title: "Appearance",
    order: 10,
    description: "Light and dark appearance, and the theme used for each.",
    component: () => <ThemePicker kernel={kernel} themes={themeRegistry} controller={controller} />,
  });

  addCommand([
    {
      id: "themes.toggleAppearance",
      title: "Toggle light / dark appearance",
      category: "Appearance",
      run: () => controller.setAppearance(kernel.ui.colorScheme === "dark" ? "light" : "dark"),
    },
    {
      id: "themes.open",
      title: "Change theme",
      category: "Appearance",
      run: () => openSettings("themes"),
    },
  ]);
}

export function deactivate(): void {
  live = undefined;
}

/**
 * `kernel.settings.subscribe` is one of the methods still landing in M3 and throws
 * `NotImplementedError` today. Subscribing is a convenience — the selection is already
 * applied — so it is guarded rather than allowed to fail activation (SPEC §6.4: a throw
 * from `activate` skips every dependent).
 */
function safeSubscribe(kernel: Kernel, listener: () => void): Unsubscribe | undefined {
  try {
    return kernel.settings.subscribe(() => listener());
  } catch {
    return undefined;
  }
}

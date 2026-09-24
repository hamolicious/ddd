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
 * A theme therefore only names what it changes. Two are contributed here — one per
 * scheme — which is what proves the point: every value they do not mention is still
 * the kernel's, and a third-party theme is the same four fields.
 *
 * `apply.ts` holds the application logic (and its tests), `controller.ts` the selection
 * state, `Picker.tsx` the settings section.
 */

import { type Kernel, type Unsubscribe } from "@kernel";

import { POINTS, themeShape, type Command, type SettingsSection, type Theme } from "../../_shared/points.js";

import { ThemePicker } from "./Picker.js";
import { ThemesController } from "./controller.js";

export interface ThemesApi {
  list(): readonly Theme[];
  /** Apply a theme by id; `undefined` returns to the kernel defaults. */
  select(themeId: string | undefined): Promise<void>;
  selected(): string | undefined;
  onChange(listener: (themeId: string | undefined) => void): Unsubscribe;
}

export default function activate(kernel: Kernel): ThemesApi {
  const themes = kernel.extensions.definePoint<Theme>({
    name: POINTS.theme,
    shape: themeShape,
    key: (theme) => theme.id,
    description: "Token overrides on top of the kernel's default palette.",
  });

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
  kernel.extensions.contribute<Theme>(POINTS.theme, {
    id: "warm",
    name: "Warm",
    scheme: "light",
    tokens: {
      "--lm-bg": "#fdfaf5",
      "--lm-bg-subtle": "#f4eee4",
      "--lm-bg-raised": "#fffdfa",
      "--lm-border": "#e4d9c8",
      "--lm-accent": "#9a5b16",
      "--lm-accent-subtle": "#f6e9d8",
      "--lm-link": "#9a5b16",
      "--lm-selection": "#f0dcc0",
    },
  });
  kernel.extensions.contribute<Theme>(POINTS.theme, {
    id: "midnight",
    name: "Midnight",
    scheme: "dark",
    tokens: {
      "--lm-bg": "#0d1117",
      "--lm-bg-subtle": "#11161d",
      "--lm-bg-raised": "#161b22",
      "--lm-border": "#232a33",
      "--lm-border-strong": "#38404b",
      "--lm-accent": "#7aa2f7",
      "--lm-accent-text": "#0b1020",
      "--lm-accent-subtle": "#17233d",
      "--lm-link": "#7aa2f7",
      "--lm-focus-ring": "#7aa2f7",
      "--lm-selection": "#243354",
    },
  });

  const controller = new ThemesController(kernel, () => themes.get());
  controller.adoptStoredAppearance();

  // Live in both directions: a theme contributed (or withdrawn with its plugin) later
  // re-resolves the stored id, and `subscribe` firing immediately is the initial apply.
  themes.subscribe(() => controller.refresh());
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

  kernel.extensions.contribute<SettingsSection>(POINTS.settingsSection, {
    id: "themes",
    title: "Appearance",
    order: 10,
    description: "Light and dark appearance, and the theme used for each.",
    component: () => <ThemePicker kernel={kernel} controller={controller} />,
  });

  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "themes.toggleAppearance",
    title: "Toggle light / dark appearance",
    category: "Appearance",
    run: () => controller.setAppearance(kernel.ui.colorScheme === "dark" ? "light" : "dark"),
  });

  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "themes.open",
    title: "Change theme",
    category: "Appearance",
    run: () => {
      const settings = kernel.services.get<{ open(sectionId?: string): void }>("settings");
      settings?.open("themes");
    },
  });

  return {
    list: () => themes.get(),
    select: (themeId) => controller.select(themeId),
    selected: () => controller.selected(),
    onChange: (listener) => controller.onChange(listener),
  };
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

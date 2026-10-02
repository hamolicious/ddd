import { type Kernel, type Unsubscribe } from "@kernel";
import { addCommand } from "plugin:commands";
import { addSection, open as openSettings } from "plugin:settings";

import { themeRegistry, type Theme } from "./api.js";
import { ThemePicker } from "./Picker.js";
import { ThemesController } from "./controller.js";

export type { Theme } from "./api.js";

export interface ThemesApi {
  list(): readonly Theme[];
  select(themeId: string | undefined): Promise<void>;
  selected(): string | undefined;
  onChange(listener: (themeId: string | undefined) => void): Unsubscribe;
}

let live: ThemesController | undefined;

function controller(): ThemesController {
  if (!live) throw new Error("themes: not active yet (call it from your own activate or later)");
  return live;
}

export const addTheme: (items: Theme | readonly Theme[]) => () => void = themeRegistry.add;

export function list(): readonly Theme[] {
  return themeRegistry.get();
}

export function select(themeId: string | undefined): Promise<void> {
  return controller().select(themeId);
}

export function selected(): string | undefined {
  return controller().selected();
}

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

  themeRegistry.subscribe(() => controller.refresh());
  safeSubscribe(kernel, () => controller.reload());
  kernel.ui.onColorScheme(() => controller.schemeChanged());
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

function safeSubscribe(kernel: Kernel, listener: () => void): Unsubscribe | undefined {
  try {
    return kernel.settings.subscribe(() => listener());
  } catch {
    return undefined;
  }
}

import type { ComponentType, ReactNode } from "react";

import type { Unsubscribe } from "./types.js";

export type ThemeTokenName =
  | "--ddd-bg"
  | "--ddd-bg-subtle"
  | "--ddd-bg-raised"
  | "--ddd-bg-overlay"
  | "--ddd-border"
  | "--ddd-border-strong"
  | "--ddd-text"
  | "--ddd-text-muted"
  | "--ddd-text-inverse"
  | "--ddd-link"
  | "--ddd-accent"
  | "--ddd-accent-text"
  | "--ddd-accent-subtle"
  | "--ddd-danger"
  | "--ddd-danger-text"
  | "--ddd-warning"
  | "--ddd-success"
  | "--ddd-focus-ring"
  | "--ddd-selection"
  | "--ddd-shadow-1"
  | "--ddd-shadow-2"
  | "--ddd-font-sans"
  | "--ddd-font-mono"
  | "--ddd-radius"
  | "--ddd-radius-lg"
  | "--ddd-space"
  | "--ddd-tap-target";

export type ThemeTokens = Readonly<Record<ThemeTokenName, string>>;

export type ColorScheme = "light" | "dark";
export type ColorSchemePreference = ColorScheme | "system";

export const DEFAULT_LIGHT_TOKENS: ThemeTokens = {
  "--ddd-bg": "#ffffff",
  "--ddd-bg-subtle": "#f5f6f8",
  "--ddd-bg-raised": "#ffffff",
  "--ddd-bg-overlay": "rgba(16, 19, 24, 0.44)",
  "--ddd-border": "#dfe2e7",
  "--ddd-border-strong": "#b9bfc9",
  "--ddd-text": "#1b1f24",
  "--ddd-text-muted": "#59616d",
  "--ddd-text-inverse": "#ffffff",
  "--ddd-link": "#0b5fd7",
  "--ddd-accent": "#0b5fd7",
  "--ddd-accent-text": "#ffffff",
  "--ddd-accent-subtle": "#e8f0fd",
  "--ddd-danger": "#b3261e",
  "--ddd-danger-text": "#ffffff",
  "--ddd-warning": "#8a5300",
  "--ddd-success": "#1a7f37",
  "--ddd-focus-ring": "#0b5fd7",
  "--ddd-selection": "#cfe0fb",
  "--ddd-shadow-1": "0 1px 2px rgba(16, 19, 24, 0.10)",
  "--ddd-shadow-2": "0 8px 24px rgba(16, 19, 24, 0.16)",
  "--ddd-font-sans":
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "--ddd-font-mono": 'ui-monospace, SFMono-Regular, "JetBrains Mono", Consolas, monospace',
  "--ddd-radius": "6px",
  "--ddd-radius-lg": "12px",
  "--ddd-space": "8px",
  "--ddd-tap-target": "44px",
};

export const DEFAULT_DARK_TOKENS: ThemeTokens = {
  "--ddd-bg": "#14161a",
  "--ddd-bg-subtle": "#1a1d22",
  "--ddd-bg-raised": "#1f2329",
  "--ddd-bg-overlay": "rgba(0, 0, 0, 0.58)",
  "--ddd-border": "#2c313a",
  "--ddd-border-strong": "#3d444f",
  "--ddd-text": "#e6e9ed",
  "--ddd-text-muted": "#a4acb8",
  "--ddd-text-inverse": "#0c1016",
  "--ddd-link": "#8ab4ff",
  "--ddd-accent": "#8ab4ff",
  "--ddd-accent-text": "#0c1016",
  "--ddd-accent-subtle": "#1b2740",
  "--ddd-danger": "#f2685f",
  "--ddd-danger-text": "#1a0c0b",
  "--ddd-warning": "#e3b341",
  "--ddd-success": "#56d364",
  "--ddd-focus-ring": "#8ab4ff",
  "--ddd-selection": "#2b3f63",
  "--ddd-shadow-1": "0 1px 2px rgba(0, 0, 0, 0.5)",
  "--ddd-shadow-2": "0 8px 24px rgba(0, 0, 0, 0.6)",
  "--ddd-font-sans": DEFAULT_LIGHT_TOKENS["--ddd-font-sans"],
  "--ddd-font-mono": DEFAULT_LIGHT_TOKENS["--ddd-font-mono"],
  "--ddd-radius": "6px",
  "--ddd-radius-lg": "12px",
  "--ddd-space": "8px",
  "--ddd-tap-target": "44px",
};

export const THEME_TOKEN_NAMES: readonly ThemeTokenName[] = Object.keys(
  DEFAULT_LIGHT_TOKENS,
) as readonly ThemeTokenName[];

export interface ThemeTokensApi {
  readonly names: readonly ThemeTokenName[];
  defaults(scheme: ColorScheme): ThemeTokens;
  current(): ThemeTokens;
  apply(scheme: ColorScheme, tokens: Partial<ThemeTokens>): Unsubscribe;
  reset(): void;
}

export type NoticeLevel = "info" | "warning" | "error";

export interface NoticeAction {
  readonly label: string;
  run(): void;
}

export interface NoticeProgress {
  readonly value: number;
  readonly label?: string;
}

export interface Notice {
  readonly id: string;
  readonly level: NoticeLevel;
  readonly message: string;
  readonly detail?: string;
  readonly actions?: readonly NoticeAction[];
  readonly progress?: NoticeProgress;
  readonly pluginId?: string;
}

export interface BoundaryInfo {
  readonly point: string;
  readonly pluginId?: string;
  readonly fallback?: ComponentType<{ readonly error: Error; readonly pluginId: string }>;
}

export interface UiApi {
  readonly root: HTMLElement;
  mount(element: ReactNode): Unsubscribe;
  boundary<P extends object>(component: ComponentType<P>, info: BoundaryInfo): ComponentType<P>;
  notify(notice: Notice): Unsubscribe;
  notices(): readonly Notice[];
  onNotices(listener: (notices: readonly Notice[]) => void): Unsubscribe;
  readonly tokens: ThemeTokensApi;
  readonly colorScheme: ColorScheme;
  colorSchemePreference(): ColorSchemePreference;
  setColorSchemePreference(preference: ColorSchemePreference): void;
  onColorScheme(listener: (scheme: ColorScheme) => void): Unsubscribe;
}

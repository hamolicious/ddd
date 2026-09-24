/**
 * `kernel.ui` — the single mount point, the error-boundary wrapper, the notice
 * strip, and the **default light/dark design tokens the kernel ships** (SPEC §6.4,
 * §6.5 note).
 *
 * Why tokens live in the kernel and not in `themes`: with them in a plugin, a
 * workspace whose `themes` plugin failed to activate — or a `?safe=bare` boot —
 * renders unreadable text on unpainted background, which is exactly the state you
 * are in when you need the plugin manager. The kernel therefore ships one legible,
 * WCAG-AA light and dark palette, and `themes` **overrides** it (SPEC §6.5).
 *
 * Why the kernel owns the error boundary: "every contribution is wrapped in an
 * error boundary" (SPEC §6.4) is a property of the *host*, not a courtesy each
 * plugin author remembers. The loader wraps contributed components with
 * {@link UiApi.boundary}; a plugin rendering another plugin's component wraps it
 * the same way.
 *
 * **FROZEN.**
 */

import type { ComponentType, ReactNode } from "react";

import type { Unsubscribe } from "./types.js";

/** A CSS custom property the kernel defines a value for. */
export type ThemeTokenName =
  // Surfaces
  | "--lm-bg"
  | "--lm-bg-subtle"
  | "--lm-bg-raised"
  | "--lm-bg-overlay"
  | "--lm-border"
  | "--lm-border-strong"
  // Text
  | "--lm-text"
  | "--lm-text-muted"
  | "--lm-text-inverse"
  | "--lm-link"
  // Intents
  | "--lm-accent"
  | "--lm-accent-text"
  | "--lm-accent-subtle"
  | "--lm-danger"
  | "--lm-danger-text"
  | "--lm-warning"
  | "--lm-success"
  // Affordances
  | "--lm-focus-ring"
  | "--lm-selection"
  | "--lm-shadow-1"
  | "--lm-shadow-2"
  // Metrics and type
  | "--lm-font-sans"
  | "--lm-font-mono"
  | "--lm-radius"
  | "--lm-radius-lg"
  | "--lm-space"
  | "--lm-tap-target";

export type ThemeTokens = Readonly<Record<ThemeTokenName, string>>;

export type ColorScheme = "light" | "dark";
export type ColorSchemePreference = ColorScheme | "system";

/**
 * Kernel default **light** tokens. Text/background pairs clear WCAG AA:
 * `--lm-text` on `--lm-bg` ≈ 14.9:1, `--lm-text-muted` ≈ 5.3:1,
 * `--lm-accent-text` on `--lm-accent` ≈ 5.2:1.
 */
export const DEFAULT_LIGHT_TOKENS: ThemeTokens = {
  "--lm-bg": "#ffffff",
  "--lm-bg-subtle": "#f5f6f8",
  "--lm-bg-raised": "#ffffff",
  "--lm-bg-overlay": "rgba(16, 19, 24, 0.44)",
  "--lm-border": "#dfe2e7",
  "--lm-border-strong": "#b9bfc9",
  "--lm-text": "#1b1f24",
  "--lm-text-muted": "#59616d",
  "--lm-text-inverse": "#ffffff",
  "--lm-link": "#0b5fd7",
  "--lm-accent": "#0b5fd7",
  "--lm-accent-text": "#ffffff",
  "--lm-accent-subtle": "#e8f0fd",
  "--lm-danger": "#b3261e",
  "--lm-danger-text": "#ffffff",
  "--lm-warning": "#8a5300",
  "--lm-success": "#1a7f37",
  "--lm-focus-ring": "#0b5fd7",
  "--lm-selection": "#cfe0fb",
  "--lm-shadow-1": "0 1px 2px rgba(16, 19, 24, 0.10)",
  "--lm-shadow-2": "0 8px 24px rgba(16, 19, 24, 0.16)",
  "--lm-font-sans":
    'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  "--lm-font-mono": 'ui-monospace, SFMono-Regular, "JetBrains Mono", Consolas, monospace',
  "--lm-radius": "6px",
  "--lm-radius-lg": "12px",
  "--lm-space": "8px",
  /** SPEC §6.5: 44 px touch targets at the mobile breakpoint. */
  "--lm-tap-target": "44px",
};

/**
 * Kernel default **dark** tokens. `--lm-text` on `--lm-bg` ≈ 13.6:1,
 * `--lm-text-muted` ≈ 6.4:1, `--lm-accent-text` on `--lm-accent` ≈ 8.1:1.
 */
export const DEFAULT_DARK_TOKENS: ThemeTokens = {
  "--lm-bg": "#14161a",
  "--lm-bg-subtle": "#1a1d22",
  "--lm-bg-raised": "#1f2329",
  "--lm-bg-overlay": "rgba(0, 0, 0, 0.58)",
  "--lm-border": "#2c313a",
  "--lm-border-strong": "#3d444f",
  "--lm-text": "#e6e9ed",
  "--lm-text-muted": "#a4acb8",
  "--lm-text-inverse": "#0c1016",
  "--lm-link": "#8ab4ff",
  "--lm-accent": "#8ab4ff",
  "--lm-accent-text": "#0c1016",
  "--lm-accent-subtle": "#1b2740",
  "--lm-danger": "#f2685f",
  "--lm-danger-text": "#1a0c0b",
  "--lm-warning": "#e3b341",
  "--lm-success": "#56d364",
  "--lm-focus-ring": "#8ab4ff",
  "--lm-selection": "#2b3f63",
  "--lm-shadow-1": "0 1px 2px rgba(0, 0, 0, 0.5)",
  "--lm-shadow-2": "0 8px 24px rgba(0, 0, 0, 0.6)",
  "--lm-font-sans": DEFAULT_LIGHT_TOKENS["--lm-font-sans"],
  "--lm-font-mono": DEFAULT_LIGHT_TOKENS["--lm-font-mono"],
  "--lm-radius": "6px",
  "--lm-radius-lg": "12px",
  "--lm-space": "8px",
  "--lm-tap-target": "44px",
};

/** Every token name, in declaration order. */
export const THEME_TOKEN_NAMES: readonly ThemeTokenName[] = Object.keys(
  DEFAULT_LIGHT_TOKENS,
) as readonly ThemeTokenName[];

export interface ThemeTokensApi {
  readonly names: readonly ThemeTokenName[];
  /** The kernel defaults — what `themes` starts from. */
  defaults(scheme: ColorScheme): ThemeTokens;
  /** The values currently applied to the document. */
  current(): ThemeTokens;
  /**
   * Override tokens for one scheme. Later calls layer on earlier ones; the
   * returned handle removes exactly this layer, so a theme picker never has to
   * reconstruct the base palette.
   */
  apply(scheme: ColorScheme, tokens: Partial<ThemeTokens>): Unsubscribe;
  /** Drop every override, back to the kernel defaults. */
  reset(): void;
}

export type NoticeLevel = "info" | "warning" | "error";

export interface NoticeAction {
  readonly label: string;
  run(): void;
}

/**
 * One line in the notice strip. The kernel uses it for the aggregated
 * failed-plugin notice and the single "update available — reload" flow (SPEC §8);
 * plugins use it for anything a user must be told once.
 */
export interface Notice {
  /** Stable id: re-notifying the same id replaces rather than stacks. */
  readonly id: string;
  readonly level: NoticeLevel;
  readonly message: string;
  readonly detail?: string;
  readonly actions?: readonly NoticeAction[];
  /** Set by the kernel when the notice is about a plugin. */
  readonly pluginId?: string;
}

export interface BoundaryInfo {
  /** Which extension point the component was contributed to. */
  readonly point: string;
  /** Owner of the component; defaults to the calling plugin. */
  readonly pluginId?: string;
  /** Rendered in place of the component when it throws; default is a terse chip. */
  readonly fallback?: ComponentType<{ readonly error: Error; readonly pluginId: string }>;
}

export interface UiApi {
  /**
   * The one DOM node the app's React root renders into. Plugins do not append to
   * it — {@link mount} is the sanctioned path. Exposed for the rare integration
   * that needs a portal container.
   */
  readonly root: HTMLElement;
  /**
   * Render the application shell. **Single mount** (SPEC §6.4): the first caller
   * owns it — normally `shell-ui` — and a second call while it is held throws
   * `ContractViolationError`. Disposing returns the mount point.
   */
  mount(element: ReactNode): Unsubscribe;
  /** Wrap a contributed component in the kernel's error boundary. */
  boundary<P extends object>(component: ComponentType<P>, info: BoundaryInfo): ComponentType<P>;
  /** Post (or replace) a notice. Disposing removes it. */
  notify(notice: Notice): Unsubscribe;
  notices(): readonly Notice[];
  onNotices(listener: (notices: readonly Notice[]) => void): Unsubscribe;
  readonly tokens: ThemeTokensApi;
  /** The scheme currently painted, after preference and `prefers-color-scheme`. */
  readonly colorScheme: ColorScheme;
  /** The user's preference; `themes` sets it, the kernel persists and resolves it. */
  colorSchemePreference(): ColorSchemePreference;
  setColorSchemePreference(preference: ColorSchemePreference): void;
  onColorScheme(listener: (scheme: ColorScheme) => void): Unsubscribe;
}

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
  | "--ddd-bg"
  | "--ddd-bg-subtle"
  | "--ddd-bg-raised"
  | "--ddd-bg-overlay"
  | "--ddd-border"
  | "--ddd-border-strong"
  // Text
  | "--ddd-text"
  | "--ddd-text-muted"
  | "--ddd-text-inverse"
  | "--ddd-link"
  // Intents
  | "--ddd-accent"
  | "--ddd-accent-text"
  | "--ddd-accent-subtle"
  | "--ddd-danger"
  | "--ddd-danger-text"
  | "--ddd-warning"
  | "--ddd-success"
  // Affordances
  | "--ddd-focus-ring"
  | "--ddd-selection"
  | "--ddd-shadow-1"
  | "--ddd-shadow-2"
  // Metrics and type
  | "--ddd-font-sans"
  | "--ddd-font-mono"
  | "--ddd-radius"
  | "--ddd-radius-lg"
  | "--ddd-space"
  | "--ddd-tap-target";

export type ThemeTokens = Readonly<Record<ThemeTokenName, string>>;

export type ColorScheme = "light" | "dark";
export type ColorSchemePreference = ColorScheme | "system";

/**
 * Kernel default **light** tokens. Text/background pairs clear WCAG AA:
 * `--ddd-text` on `--ddd-bg` ≈ 14.9:1, `--ddd-text-muted` ≈ 5.3:1,
 * `--ddd-accent-text` on `--ddd-accent` ≈ 5.2:1.
 */
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
  /** SPEC §6.5: 44 px touch targets at the mobile breakpoint. */
  "--ddd-tap-target": "44px",
};

/**
 * Kernel default **dark** tokens. `--ddd-text` on `--ddd-bg` ≈ 13.6:1,
 * `--ddd-text-muted` ≈ 6.4:1, `--ddd-accent-text` on `--ddd-accent` ≈ 8.1:1.
 */
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
 * Something under way, drawn as a bar along the bottom of its notice. Update it by
 * notifying the same id again.
 */
export interface NoticeProgress {
  /** 0 to 1. */
  readonly value: number;
  /** Beside the bar, e.g. the time left. */
  readonly label?: string;
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
  /** A notice about work in progress (an upload, say) carries how far it has got. */
  readonly progress?: NoticeProgress;
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

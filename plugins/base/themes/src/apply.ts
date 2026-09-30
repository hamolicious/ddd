/**
 * Turning a selection into applied tokens — the whole of `themes` that is worth
 * testing, with no React and no kernel object in it.
 *
 * The design is SPEC §6.5's "`themes` **overrides** the kernel default tokens", taken
 * literally:
 *
 * - The kernel owns the palette. A theme names only what it changes, so a two-token
 *   theme cannot produce unreadable text, and a workspace whose `themes` plugin failed
 *   to activate is merely plain (SPEC §6.4).
 * - **One layer per scheme, replaced rather than stacked.** `kernel.ui.tokens.apply`
 *   returns a handle that removes exactly that layer; an applier that forgot to dispose
 *   the previous one would leave the old theme's tokens showing through wherever the
 *   new theme is silent, which is the bug that makes theme switching feel haunted.
 * - **Both schemes are applied at once.** The user's appearance preference can be
 *   `system`, so the dark theme has to be in place before the OS flips at sunset —
 *   layers for the scheme that is not painted cost nothing.
 */

import type { ThemeTokens, ThemeTokensApi, Unsubscribe } from "@kernel";

import type { Theme } from "./api.js";

/** Which theme is chosen for each scheme. `undefined` ⇒ the kernel defaults. */
export interface ThemeSelection {
  readonly light: string | undefined;
  readonly dark: string | undefined;
}

export const NO_SELECTION: ThemeSelection = { light: undefined, dark: undefined };

export interface AppliedThemes {
  readonly light: Theme | undefined;
  readonly dark: Theme | undefined;
  /** Selected ids that no contributed theme provides (uninstalled, or renamed). */
  readonly missing: readonly string[];
}

/**
 * The theme for one scheme: the id has to name a theme that *declares* that scheme.
 * A dark theme selected as the light one is not silently repainted — the schemes are
 * separate slots precisely so `system` works.
 */
export function themeFor(
  themes: readonly Theme[],
  selection: ThemeSelection,
  scheme: "light" | "dark",
): Theme | undefined {
  const id = scheme === "dark" ? selection.dark : selection.light;
  if (id === undefined || id === "") return undefined;
  return themes.find((theme) => theme.id === id && theme.scheme === scheme);
}

/** What a theme's tokens look like over the kernel defaults. Pure; for previews. */
export function preview(defaults: ThemeTokens, theme: Theme | undefined): ThemeTokens {
  if (!theme) return defaults;
  return { ...defaults, ...theme.tokens } as ThemeTokens;
}

export class ThemeApplier {
  #layers: Unsubscribe[] = [];

  constructor(private readonly tokens: ThemeTokensApi) {}

  /**
   * Make `selection` the applied state. Idempotent, and safe to call on every change
   * of the theme registry: the previous layers go first, so nothing accumulates.
   */
  apply(themes: readonly Theme[], selection: ThemeSelection): AppliedThemes {
    this.reset();
    const light = themeFor(themes, selection, "light");
    const dark = themeFor(themes, selection, "dark");
    if (light) this.#layers.push(this.tokens.apply("light", light.tokens));
    if (dark) this.#layers.push(this.tokens.apply("dark", dark.tokens));

    const missing: string[] = [];
    if (selection.light && !light) missing.push(selection.light);
    if (selection.dark && !dark) missing.push(selection.dark);
    return { light, dark, missing };
  }

  /** Remove this applier's layers. The kernel defaults show through again. */
  reset(): void {
    for (const dispose of this.#layers.splice(0)) dispose();
  }

  /** How many layers are currently held — one per selected scheme, at most two. */
  get layerCount(): number {
    return this.#layers.length;
  }
}

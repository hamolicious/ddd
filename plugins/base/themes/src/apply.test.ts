/**
 * Theme application, against a stand-in for `kernel.ui.tokens` that layers exactly
 * the way `kernel/src/runtime/theme.ts` does.
 *
 * The two properties worth a test are the two that break silently in a browser: a
 * theme must override *only* the tokens it names (so no theme can make text
 * invisible), and switching themes must remove the previous layer (so the old
 * palette does not show through wherever the new one is silent).
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  THEME_TOKEN_NAMES,
  type ColorScheme,
  type ThemeTokens,
  type ThemeTokensApi,
  type Unsubscribe,
} from "@kernel";

import type { Theme } from "@protocols/lm/themes.theme";

import { NO_SELECTION, ThemeApplier, preview, themeFor } from "./apply.js";

interface Layer {
  readonly scheme: ColorScheme;
  readonly tokens: Partial<ThemeTokens>;
}

/** The same layer semantics as the kernel's `ThemeController`, minus the DOM. */
function stubTokens(): ThemeTokensApi & { layers: readonly Layer[]; applyCalls: number } {
  const layers: Layer[] = [];
  const state = {
    layers,
    applyCalls: 0,
    names: THEME_TOKEN_NAMES,
    defaults: (scheme: ColorScheme): ThemeTokens =>
      scheme === "dark" ? DEFAULT_DARK_TOKENS : DEFAULT_LIGHT_TOKENS,
    current: (): ThemeTokens => resolve(layers, "light"),
    apply: (scheme: ColorScheme, tokens: Partial<ThemeTokens>): Unsubscribe => {
      state.applyCalls += 1;
      const layer: Layer = { scheme, tokens };
      layers.push(layer);
      return () => {
        const at = layers.indexOf(layer);
        if (at >= 0) layers.splice(at, 1);
      };
    },
    reset: (): void => {
      layers.length = 0;
    },
  };
  return state;
}

function resolve(layers: readonly Layer[], scheme: ColorScheme): ThemeTokens {
  const merged: Record<string, string> = {
    ...(scheme === "dark" ? DEFAULT_DARK_TOKENS : DEFAULT_LIGHT_TOKENS),
  };
  for (const layer of layers) {
    if (layer.scheme !== scheme) continue;
    for (const [name, value] of Object.entries(layer.tokens)) {
      if (typeof value === "string") merged[name] = value;
    }
  }
  return merged as ThemeTokens;
}

const warm: Theme = {
  id: "warm",
  name: "Warm",
  scheme: "light",
  tokens: { "--lm-bg": "#fdfaf5", "--lm-accent": "#9a5b16" },
};
const paper: Theme = {
  id: "paper",
  name: "Paper",
  scheme: "light",
  tokens: { "--lm-bg": "#f7f4ee" },
};
const midnight: Theme = {
  id: "midnight",
  name: "Midnight",
  scheme: "dark",
  tokens: { "--lm-bg": "#0d1117", "--lm-accent": "#7aa2f7" },
};
const themes: readonly Theme[] = [warm, paper, midnight];

describe("themeFor", () => {
  it("resolves a selection per scheme", () => {
    expect(themeFor(themes, { light: "warm", dark: "midnight" }, "light")).toBe(warm);
    expect(themeFor(themes, { light: "warm", dark: "midnight" }, "dark")).toBe(midnight);
  });

  it("never repaints a theme into the other scheme", () => {
    expect(themeFor(themes, { light: "midnight", dark: undefined }, "light")).toBeUndefined();
  });

  it("treats no selection and an unknown id as the kernel defaults", () => {
    expect(themeFor(themes, NO_SELECTION, "light")).toBeUndefined();
    expect(themeFor(themes, { light: "", dark: undefined }, "light")).toBeUndefined();
    expect(themeFor(themes, { light: "uninstalled", dark: undefined }, "light")).toBeUndefined();
  });
});

describe("ThemeApplier", () => {
  it("overrides only the tokens the theme names", () => {
    const tokens = stubTokens();
    new ThemeApplier(tokens).apply(themes, { light: "warm", dark: undefined });

    const applied = resolve(tokens.layers, "light");
    expect(applied["--lm-bg"]).toBe("#fdfaf5");
    expect(applied["--lm-accent"]).toBe("#9a5b16");
    // Everything the theme is silent about stays the kernel's legible default.
    for (const name of THEME_TOKEN_NAMES) {
      if (name === "--lm-bg" || name === "--lm-accent") continue;
      expect(applied[name]).toBe(DEFAULT_LIGHT_TOKENS[name]);
    }
  });

  it("applies both schemes so `system` is ready for either", () => {
    const tokens = stubTokens();
    const result = new ThemeApplier(tokens).apply(themes, { light: "warm", dark: "midnight" });

    expect(result.light).toBe(warm);
    expect(result.dark).toBe(midnight);
    expect(tokens.layers).toHaveLength(2);
    expect(resolve(tokens.layers, "light")["--lm-bg"]).toBe("#fdfaf5");
    expect(resolve(tokens.layers, "dark")["--lm-bg"]).toBe("#0d1117");
  });

  it("replaces its layer instead of stacking it", () => {
    const tokens = stubTokens();
    const applier = new ThemeApplier(tokens);

    applier.apply(themes, { light: "warm", dark: undefined });
    applier.apply(themes, { light: "paper", dark: undefined });

    expect(applier.layerCount).toBe(1);
    expect(tokens.layers).toHaveLength(1);
    const applied = resolve(tokens.layers, "light");
    expect(applied["--lm-bg"]).toBe("#f7f4ee");
    // `warm` also set the accent; `paper` does not, so the *kernel* default must be
    // back — not the accent of the theme the user just switched away from.
    expect(applied["--lm-accent"]).toBe(DEFAULT_LIGHT_TOKENS["--lm-accent"]);
  });

  it("returns to the kernel defaults on reset and on an empty selection", () => {
    const tokens = stubTokens();
    const applier = new ThemeApplier(tokens);

    applier.apply(themes, { light: "warm", dark: "midnight" });
    applier.reset();
    expect(tokens.layers).toHaveLength(0);
    expect(resolve(tokens.layers, "light")).toEqual(DEFAULT_LIGHT_TOKENS);

    applier.apply(themes, NO_SELECTION);
    expect(applier.layerCount).toBe(0);
    expect(resolve(tokens.layers, "dark")).toEqual(DEFAULT_DARK_TOKENS);
  });

  it("reports a selected theme that is not installed, and paints the default", () => {
    const tokens = stubTokens();
    const result = new ThemeApplier(tokens).apply(themes, { light: "gone", dark: "midnight" });

    expect(result.missing).toEqual(["gone"]);
    expect(resolve(tokens.layers, "light")).toEqual(DEFAULT_LIGHT_TOKENS);
    expect(result.dark).toBe(midnight);
  });

  it("re-applying the same selection does not multiply layers", () => {
    const tokens = stubTokens();
    const applier = new ThemeApplier(tokens);
    for (let i = 0; i < 5; i += 1) applier.apply(themes, { light: "warm", dark: "midnight" });
    expect(tokens.layers).toHaveLength(2);
    expect(tokens.applyCalls).toBe(10);
  });
});

describe("preview", () => {
  it("is the defaults with the theme's tokens on top", () => {
    expect(preview(DEFAULT_LIGHT_TOKENS, undefined)).toEqual(DEFAULT_LIGHT_TOKENS);
    expect(preview(DEFAULT_LIGHT_TOKENS, warm)["--lm-bg"]).toBe("#fdfaf5");
    expect(preview(DEFAULT_LIGHT_TOKENS, warm)["--lm-text"]).toBe(DEFAULT_LIGHT_TOKENS["--lm-text"]);
  });
});

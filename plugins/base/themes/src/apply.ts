import type { ThemeTokens, ThemeTokensApi, Unsubscribe } from "@kernel";

import type { Theme } from "./api.js";

export interface ThemeSelection {
  readonly light: string | undefined;
  readonly dark: string | undefined;
}

export const NO_SELECTION: ThemeSelection = { light: undefined, dark: undefined };

export interface AppliedThemes {
  readonly light: Theme | undefined;
  readonly dark: Theme | undefined;
  readonly missing: readonly string[];
}

export function themeFor(
  themes: readonly Theme[],
  selection: ThemeSelection,
  scheme: "light" | "dark",
): Theme | undefined {
  const id = scheme === "dark" ? selection.dark : selection.light;
  if (id === undefined || id === "") return undefined;
  return themes.find((theme) => theme.id === id && theme.scheme === scheme);
}

export function preview(defaults: ThemeTokens, theme: Theme | undefined): ThemeTokens {
  if (!theme) return defaults;
  return { ...defaults, ...theme.tokens } as ThemeTokens;
}

export class ThemeApplier {
  #layers: Unsubscribe[] = [];

  constructor(private readonly tokens: ThemeTokensApi) {}

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

  reset(): void {
    for (const dispose of this.#layers.splice(0)) dispose();
  }

  get layerCount(): number {
    return this.#layers.length;
  }
}

/**
 * Design tokens: the kernel's defaults, the resolved colour scheme, and the layer
 * stack `themes` overrides through (SPEC §6.4, §6.5).
 *
 * Layers, not a merged blob: a theme picker applies a layer and disposes it when
 * the user picks another one, and the kernel defaults are never lost. That is also
 * what makes a failed `themes` plugin merely *plain* instead of invisible.
 *
 * Tokens are written to the document element as CSS custom properties, with
 * `color-scheme` set alongside them so native form controls and scrollbars follow.
 */

import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  THEME_TOKEN_NAMES,
  type ColorScheme,
  type ColorSchemePreference,
  type ThemeTokenName,
  type ThemeTokens,
  type ThemeTokensApi,
  type Unsubscribe,
} from "@kernel";

/** Where the colour-scheme preference is remembered. Not a setting: it must be readable before plugins load. */
export const COLOR_SCHEME_STORAGE_KEY = "ddd.color-scheme";

/**
 * Write the kernel's default tokens before anything else exists.
 *
 * The boot screen, the auth gate and a boot *failure* all render before there is a
 * kernel — and `app/src/styles.css` is written entirely in `--ddd-*` tokens, so
 * without this the login screen is unstyled text on the browser's default white,
 * in dark mode included. The alternative would be a second copy of the palette in
 * CSS, which is one drifting copy too many: {@link DEFAULT_LIGHT_TOKENS} and
 * {@link DEFAULT_DARK_TOKENS} are the contract (SPEC §6.4), so they are what gets
 * painted, by the same code path {@link ThemeController} uses afterwards.
 *
 * Idempotent, DOM-only, and safe to call before login: the stored preference is a
 * device setting (not a settings document), which is exactly why it lives in
 * `localStorage` under {@link COLOR_SCHEME_STORAGE_KEY}.
 */
export function paintKernelDefaultTokens(target: HTMLElement): ColorScheme {
  const scheme = resolveScheme(readPreference());
  writeTokens(target, scheme, scheme === "dark" ? DEFAULT_DARK_TOKENS : DEFAULT_LIGHT_TOKENS);
  return scheme;
}

/** The one place tokens reach the DOM. */
function writeTokens(target: HTMLElement, scheme: ColorScheme, tokens: ThemeTokens): void {
  for (const name of THEME_TOKEN_NAMES) {
    const value = tokens[name as ThemeTokenName];
    if (value !== undefined) target.style.setProperty(name, value);
  }
  // `color-scheme` so native controls and scrollbars follow, and a data attribute
  // so CSS (the kernel's or a plugin's) can branch without reading JS state.
  target.style.colorScheme = scheme;
  target.dataset["lmScheme"] = scheme;
}

function resolveScheme(preference: ColorSchemePreference): ColorScheme {
  if (preference !== "system") return preference;
  if (typeof matchMedia !== "function") return "light";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

interface Layer {
  readonly scheme: ColorScheme;
  readonly tokens: Partial<ThemeTokens>;
}

export class ThemeController {
  readonly #layers: Layer[] = [];
  readonly #listeners = new Set<(scheme: ColorScheme) => void>();
  #preference: ColorSchemePreference;
  #media: MediaQueryList | undefined;

  constructor(private readonly target: HTMLElement) {
    this.#preference = readPreference();
    if (typeof matchMedia === "function") {
      this.#media = matchMedia("(prefers-color-scheme: dark)");
      this.#media.addEventListener("change", () => {
        if (this.#preference === "system") this.#paint();
      });
    }
    this.#paint();
  }

  get scheme(): ColorScheme {
    if (this.#preference !== "system") return this.#preference;
    return this.#media?.matches ? "dark" : "light";
  }

  preference(): ColorSchemePreference {
    return this.#preference;
  }

  setPreference(preference: ColorSchemePreference): void {
    this.#preference = preference;
    try {
      if (preference === "system") localStorage.removeItem(COLOR_SCHEME_STORAGE_KEY);
      else localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, preference);
    } catch {
      // Private mode: the preference lasts as long as the page does.
    }
    this.#paint();
  }

  onScheme(listener: (scheme: ColorScheme) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  api(): ThemeTokensApi {
    return {
      names: THEME_TOKEN_NAMES,
      defaults: (scheme) => (scheme === "dark" ? DEFAULT_DARK_TOKENS : DEFAULT_LIGHT_TOKENS),
      current: () => this.#resolved(this.scheme),
      apply: (scheme, tokens) => {
        const layer: Layer = { scheme, tokens };
        this.#layers.push(layer);
        this.#paint();
        return () => {
          const index = this.#layers.indexOf(layer);
          if (index < 0) return;
          this.#layers.splice(index, 1);
          this.#paint();
        };
      },
      reset: () => {
        this.#layers.length = 0;
        this.#paint();
      },
    };
  }

  #resolved(scheme: ColorScheme): ThemeTokens {
    const base = scheme === "dark" ? DEFAULT_DARK_TOKENS : DEFAULT_LIGHT_TOKENS;
    const merged: Record<string, string> = { ...base };
    for (const layer of this.#layers) {
      if (layer.scheme !== scheme) continue;
      for (const [name, value] of Object.entries(layer.tokens)) {
        if (typeof value === "string") merged[name] = value;
      }
    }
    return merged as ThemeTokens;
  }

  #paint(): void {
    const scheme = this.scheme;
    writeTokens(this.target, scheme, this.#resolved(scheme));
    for (const listener of [...this.#listeners]) listener(scheme);
  }
}

function readPreference(): ColorSchemePreference {
  try {
    const stored = localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

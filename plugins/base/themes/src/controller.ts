import type { ColorScheme, ColorSchemePreference, Kernel, Unsubscribe } from "@kernel";

import type { Theme } from "./api.js";

import { ThemeApplier, themeFor, type AppliedThemes, type ThemeSelection } from "./apply.js";
import { preferenceStore, type PreferenceStore } from "./prefs.js";

export const KEY_LIGHT = "theme";
export const KEY_DARK = "themeDark";
export const KEY_APPEARANCE = "colorScheme";

export class ThemesController {
  readonly #applier: ThemeApplier;
  readonly #prefs: PreferenceStore;
  readonly #listeners = new Set<(themeId: string | undefined) => void>();
  #selection: ThemeSelection;
  #applied: AppliedThemes = { light: undefined, dark: undefined, missing: [] };

  constructor(
    private readonly kernel: Kernel,
    private readonly themes: () => readonly Theme[],
  ) {
    this.#applier = new ThemeApplier(kernel.ui.tokens);
    this.#prefs = preferenceStore(kernel, "themes");
    this.#selection = {
      light: this.#prefs.get(KEY_LIGHT) || undefined,
      dark: this.#prefs.get(KEY_DARK) || undefined,
    };
  }

  refresh(): void {
    this.#applied = this.#applier.apply(this.themes(), this.#selection);
  }

  adoptStoredAppearance(): void {
    const stored = this.#prefs.get(KEY_APPEARANCE);
    if (stored !== "light" && stored !== "dark" && stored !== "system") return;
    if (stored === this.kernel.ui.colorSchemePreference()) return;
    this.kernel.ui.setColorSchemePreference(stored);
  }

  reload(): void {
    this.adoptStoredAppearance();

    const next: ThemeSelection = {
      light: this.#prefs.get(KEY_LIGHT) || undefined,
      dark: this.#prefs.get(KEY_DARK) || undefined,
    };
    if (next.light === this.#selection.light && next.dark === this.#selection.dark) return;
    this.#selection = next;
    this.refresh();
    this.#emit();
  }

  get selection(): ThemeSelection {
    return this.#selection;
  }

  get applied(): AppliedThemes {
    return this.#applied;
  }

  get durable(): boolean {
    return this.#prefs.durable;
  }

  async flushPending(): Promise<void> {
    const before = this.#prefs.durable;
    await this.#prefs.flush();
    if (before !== this.#prefs.durable) this.#emit();
  }

  selected(): string | undefined {
    return this.forScheme(this.kernel.ui.colorScheme);
  }

  forScheme(scheme: ColorScheme): string | undefined {
    return scheme === "dark" ? this.#selection.dark : this.#selection.light;
  }

  async select(themeId: string | undefined): Promise<void> {
    if (themeId === undefined || themeId === "") {
      this.#selection = { light: undefined, dark: undefined };
      this.refresh();
      this.#emit();
      await Promise.all([this.#prefs.set(KEY_LIGHT, ""), this.#prefs.set(KEY_DARK, "")]);
      return;
    }

    const theme = this.themes().find((entry) => entry.id === themeId);
    if (!theme) {
      this.kernel.log.warn(`no theme with id "${themeId}" is registered`);
      return;
    }
    this.#selection =
      theme.scheme === "dark"
        ? { ...this.#selection, dark: theme.id }
        : { ...this.#selection, light: theme.id };
    this.refresh();
    this.#emit();
    await this.#prefs.set(theme.scheme === "dark" ? KEY_DARK : KEY_LIGHT, theme.id);
  }

  async clear(scheme: ColorScheme): Promise<void> {
    this.#selection =
      scheme === "dark" ? { ...this.#selection, dark: undefined } : { ...this.#selection, light: undefined };
    this.refresh();
    this.#emit();
    await this.#prefs.set(scheme === "dark" ? KEY_DARK : KEY_LIGHT, "");
  }

  appearance(): ColorSchemePreference {
    return this.kernel.ui.colorSchemePreference();
  }

  async setAppearance(preference: ColorSchemePreference): Promise<void> {
    this.kernel.ui.setColorSchemePreference(preference);
    await this.#prefs.set(KEY_APPEARANCE, preference);
  }

  onChange(listener: (themeId: string | undefined) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  previewTokens(theme: Theme): Record<string, string> {
    return { ...this.kernel.ui.tokens.defaults(theme.scheme), ...theme.tokens };
  }

  isMissing(scheme: ColorScheme): boolean {
    const id = this.forScheme(scheme);
    return id !== undefined && themeFor(this.themes(), this.#selection, scheme) === undefined;
  }

  #emit(): void {
    const selected = this.selected();
    for (const listener of [...this.#listeners]) listener(selected);
  }

  schemeChanged(): void {
    this.#emit();
  }
}

/**
 * The selection state behind `ThemesApi`: what is chosen for each scheme, where it
 * is remembered, and when it gets re-applied.
 *
 * Two decisions live here.
 *
 * **A selection per scheme, not one "current theme".** The appearance preference can
 * be `system` (SPEC §6.4's `ColorSchemePreference`), so at sunset the browser flips
 * schemes with no user action and no plugin code running. A single current theme would
 * mean either ignoring that flip or repainting a light theme's tokens onto a dark
 * page. Two slots and two layers make `system` correct by construction — and mean
 * picking a dark theme while the light appearance is active is deliberately invisible
 * until the appearance changes, which the picker says out loud.
 *
 * **Re-apply on every registry change.** `themes.theme` is live: a plugin installed
 * next week can provide the theme whose id is already stored, and a plugin that fails
 * has its contributions withdrawn (`host.retract`). Both must resolve to the right
 * palette without a reload.
 */

import type { ColorScheme, ColorSchemePreference, Kernel, Unsubscribe } from "@kernel";

import type { Theme } from "./api.js";

import { ThemeApplier, themeFor, type AppliedThemes, type ThemeSelection } from "./apply.js";
import { preferenceStore, type PreferenceStore } from "./prefs.js";

/** Settings keys, one per scheme plus the appearance preference. */
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

  /**
   * Apply what is stored. Called once at activation and again whenever the registry,
   * the settings document or the painted scheme changes.
   */
  refresh(): void {
    this.#applied = this.#applier.apply(this.themes(), this.#selection);
  }

  /** The per-user appearance preference, if one is stored and differs from this device's. */
  adoptStoredAppearance(): void {
    // Read unconditionally. This used to be gated on `prefs.durable`, which latched to
    // `false` after a single failed write and then silently ignored the user's stored
    // appearance for the rest of the session. `prefs.get` already prefers a value that
    // has not reached the settings document yet, so there is nothing left to gate on.
    const stored = this.#prefs.get(KEY_APPEARANCE);
    if (stored !== "light" && stored !== "dark" && stored !== "system") return;
    if (stored === this.kernel.ui.colorSchemePreference()) return;
    this.kernel.ui.setColorSchemePreference(stored);
  }

  /** Re-read the stored selection (a settings change, possibly from another device). */
  reload(): void {
    // The **appearance** is re-read here too, not only at activation.
    //
    // Settings live in a per-user document, and on a cold client that document arrives
    // over the change feed — which can be *after* this plugin activates, because
    // `settings.start()` waits for the first local query, not for the bootstrap to
    // finish replicating the workspace. When it lands late, `adoptStoredAppearance()`
    // has already run against an empty store and read nothing; without this line the
    // user's saved light/dark choice is then ignored for the rest of the session while
    // their saved *themes* are picked up below, so the dark theme sits unused behind a
    // light appearance. Signing in on a new device is exactly that case.
    //
    // It cannot loop: `adoptStoredAppearance` returns early when the stored value
    // already matches this device's preference, and `setColorSchemePreference` only
    // reaches `schemeChanged()`.
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

  /** `true` when every choice has reached the per-user settings document. */
  get durable(): boolean {
    return this.#prefs.durable;
  }

  /**
   * Retry any choice that never reached the settings document — called when sync
   * reports it is back, so a theme picked offline syncs on its own rather than living
   * on one device until the user re-picks it.
   */
  async flushPending(): Promise<void> {
    const before = this.#prefs.durable;
    await this.#prefs.flush();
    if (before !== this.#prefs.durable) this.#emit();
  }

  /** The chosen theme for the scheme currently painted. */
  selected(): string | undefined {
    return this.forScheme(this.kernel.ui.colorScheme);
  }

  forScheme(scheme: ColorScheme): string | undefined {
    return scheme === "dark" ? this.#selection.dark : this.#selection.light;
  }

  /**
   * Choose a theme by id, or `undefined` to return every scheme to the kernel
   * defaults. The theme's own `scheme` decides which slot it fills — a theme is never
   * repainted into the other one.
   */
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

  /** Clear one scheme's slot without touching the other. */
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

  /** The kernel persists and resolves the preference; this mirrors it per-user. */
  async setAppearance(preference: ColorSchemePreference): Promise<void> {
    this.kernel.ui.setColorSchemePreference(preference);
    await this.#prefs.set(KEY_APPEARANCE, preference);
  }

  onChange(listener: (themeId: string | undefined) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The tokens a theme would paint, for the picker's swatches. */
  previewTokens(theme: Theme): Record<string, string> {
    return { ...this.kernel.ui.tokens.defaults(theme.scheme), ...theme.tokens };
  }

  /** `true` when the stored id for `scheme` names a theme nothing provides. */
  isMissing(scheme: ColorScheme): boolean {
    const id = this.forScheme(scheme);
    return id !== undefined && themeFor(this.themes(), this.#selection, scheme) === undefined;
  }

  #emit(): void {
    const selected = this.selected();
    for (const listener of [...this.#listeners]) listener(selected);
  }

  /** Re-announce the selection because the painted scheme changed under us. */
  schemeChanged(): void {
    this.#emit();
  }
}

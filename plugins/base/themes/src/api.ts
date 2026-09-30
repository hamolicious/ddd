/**
 * The theme type and the module-scope registry behind `addTheme`.
 *
 * A theme is token overrides on top of the kernel defaults. `themes` overrides the
 * palette, it does not own it, so a theme need only name the tokens it changes and
 * everything else stays legible.
 */

import { createRegistry, s } from "@kernel";

export interface Theme {
  readonly id: string;
  readonly name: string;
  readonly scheme: "light" | "dark";
  /** Partial `ThemeTokens`: token name → CSS value. */
  readonly tokens: Readonly<Record<string, string>>;
}

export const themeRegistry = createRegistry<Theme>({
  key: (theme) => theme.id,
  shape: s.object({
    id: s.string(),
    name: s.string(),
    scheme: s.literal("light", "dark"),
    tokens: s.record(s.string()),
  }),
});

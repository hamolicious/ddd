/**
 * lm/themes.theme@1.0.0: slot, owned by `themes`.
 *
 * A theme: token overrides on top of the kernel defaults. `themes` overrides the palette,
 * it does not own it, so a theme need only name the tokens it changes and everything else
 * stays legible.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

/** The protocol this package describes. */
export type ProtocolId = "lm/themes.theme";
export type ProtocolVersion = "1.0.0";

export interface Theme {
  readonly id: string;
  readonly name: string;
  readonly scheme: "light" | "dark";
  /** Partial `ThemeTokens`: token name → CSS value. */
  readonly tokens: Readonly<Record<string, string>>;
}

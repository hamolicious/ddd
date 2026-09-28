import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/icons",
  version: "1.0.0",
  kind: "service",
  name: "Icons",
  description: `
An icon set, by name: something to draw one with and something to let a person choose one.
Icons are line drawings in \`currentColor\`, so they take the colour of the text around them.
A name is stable across versions of the set; one the set does not have draws nothing.

The drawings download on first use, a few at a time, so \`Icon\` can render empty for a
moment on a cold start.`,
  imports: `import type { ComponentType } from "react";`,
  declarations: `
export interface IconProps {
  readonly name: string;
  /** Any CSS length, or a number of pixels. Default \`1em\`. */
  readonly size?: number | string;
  readonly className?: string;
  /** Read out by screen readers. Without it the icon is decorative and hidden from them. */
  readonly title?: string;
}

export interface IconPickerProps {
  /** The chosen icon's name. */
  readonly value?: string;
  /** A name, or \`undefined\` for "no icon". */
  onChange(name: string | undefined): void;
  /** Draw the choices in this CSS colour. */
  readonly color?: string;
}

export interface IconInfo {
  readonly name: string;
  readonly category: string;
  readonly tags: readonly string[];
}`,
  shape: s.object({
    Icon: s.component().as("ComponentType<IconProps>"),
    Picker: s.component().as("ComponentType<IconPickerProps>").describe("A search box over a scrolling grid of every icon that matches."),
    search: s
      .func()
      .as("(query: string, limit?: number) => Promise<readonly IconInfo[]>")
      .describe("Best matches first, by name, then tags. An empty query is every icon, a suggested few first."),
    has: s.func().as("(name: string) => Promise<boolean>"),
  }),
};

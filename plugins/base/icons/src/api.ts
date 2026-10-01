/**
 * The types `icons` exports (`plugin:icons`). Icons are line drawings in `currentColor`, so
 * they take the colour of the text around them. A name is stable across versions of the
 * set; one the set does not have draws nothing. The drawings download on first use, a few
 * at a time, so `Icon` can render empty for a moment on a cold start.
 */

import type { ComponentType } from "react";

export interface IconProps {
  readonly name: string;
  /** Any CSS length, or a number of pixels. Default `1em`. */
  readonly size?: number | string;
  readonly className?: string;
  /** Read out by screen readers. Without it the icon is decorative and hidden from them. */
  readonly title?: string;
}

export interface IconPickerProps {
  /** The chosen icon's name. */
  readonly value?: string;
  /** A name, or `undefined` for "no icon". */
  onChange(name: string | undefined): void;
  /** Draw the choices in this CSS colour. */
  readonly color?: string;
}

export interface IconInfo {
  readonly name: string;
  readonly category: string;
  readonly tags: readonly string[];
}

/** Everything `plugin:icons` exports at runtime, as one type (the old `ddd/icons` service). */
export interface Icons {
  readonly Icon: ComponentType<IconProps>;
  /** A search box over a scrolling grid of every icon that matches. */
  readonly Picker: ComponentType<IconPickerProps>;
  /** Best matches first, by name, then tags. An empty query is every icon, a suggested few first. */
  readonly search: (query: string, limit?: number) => Promise<readonly IconInfo[]>;
  readonly has: (name: string) => Promise<boolean>;
}

import type { ComponentType } from "react";

export interface IconProps {
  readonly name: string;
  readonly size?: number | string;
  readonly className?: string;
  readonly title?: string;
}

export interface IconPickerProps {
  readonly value?: string;
  onChange(name: string | undefined): void;
  readonly color?: string;
}

export interface IconInfo {
  readonly name: string;
  readonly category: string;
  readonly tags: readonly string[];
}

export interface Icons {
  readonly Icon: ComponentType<IconProps>;
  readonly Picker: ComponentType<IconPickerProps>;
  readonly search: (query: string, limit?: number) => Promise<readonly IconInfo[]>;
  readonly has: (name: string) => Promise<boolean>;
}

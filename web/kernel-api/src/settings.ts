import type { CoreValue, Unsubscribe } from "./types.js";

export const SETTINGS_DOC_PATH = ".settings";

export type SettingsValue = string | number | boolean | null | readonly CoreValue[];

export interface SettingsFieldSchema {
  readonly type: "string" | "number" | "boolean" | "enum" | "list";
  readonly label?: string;
  readonly description?: string;
  readonly default?: SettingsValue;
  readonly options?: readonly string[];
}

export type SettingsSchema = Readonly<Record<string, SettingsFieldSchema>>;

export interface SettingsApi {
  defineSchema(schema: SettingsSchema): void;
  schema(): SettingsSchema;
  get<T extends SettingsValue>(key: string): T | undefined;
  all(): Readonly<Record<string, SettingsValue>>;
  set(key: string, value: SettingsValue): Promise<void>;
  remove(key: string): Promise<void>;
  subscribe(listener: (values: Readonly<Record<string, SettingsValue>>) => void): Unsubscribe;
  readonly documentId: string | undefined;
}

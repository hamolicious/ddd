/**
 * `kernel.settings` — per-user settings, **stored as documents** (SPEC §6.4).
 *
 * There is no settings service, no KV table, no extra endpoint: one document per
 * user, each plugin owning one `%%%` section inside it, written with the section
 * splice helper. That buys sync, offline, conflict merging, history and backup for
 * free, and it is why `set()` is a `Promise` — it goes through the CRDT.
 *
 * **Two consequences documented rather than hidden:**
 *
 * - The workspace is shared (SPEC §2), so **another user can read your settings
 *   document.** Never put a secret in settings. Plugin secrets live in admin
 *   config, encrypted at rest (SPEC §6.2).
 * - Values are YAML scalars, one key per line, so they are shallow by design:
 *   strings, numbers, booleans, null, and flow sequences of those. A nested object
 *   is rejected — serialize it yourself if you must, and expect a human to read it.
 *
 * Each plugin sees only its own namespace; the key space is flat within it.
 *
 * **FROZEN.**
 */

import type { CoreValue, Unsubscribe } from "./types.js";

/** `fm.path` of the per-user settings documents. One document per user. */
export const SETTINGS_DOC_PATH = ".settings";

/** What a settings value may be (SPEC §3.3: YAML, one key per line). */
export type SettingsValue = string | number | boolean | null | readonly CoreValue[];

export interface SettingsFieldSchema {
  readonly type: "string" | "number" | "boolean" | "enum" | "list";
  readonly label?: string;
  readonly description?: string;
  readonly default?: SettingsValue;
  /** For `type: "enum"`. */
  readonly options?: readonly string[];
}

/** Declared per plugin; the `settings` plugin renders it (SPEC §6.5). */
export type SettingsSchema = Readonly<Record<string, SettingsFieldSchema>>;

export interface SettingsApi {
  /**
   * Declare this plugin's keys, their types and their defaults. The declared
   * default is what `get` returns for an unset key, which is also how the
   * settings UI knows what to draw without the plugin contributing a widget.
   */
  defineSchema(schema: SettingsSchema): void;
  /** The declared schema, for the settings UI. */
  schema(): SettingsSchema;
  /** Synchronous read of the cached value (the settings document is replicated). */
  get<T extends SettingsValue>(key: string): T | undefined;
  /** Every value in this plugin's namespace, defaults merged in. */
  all(): Readonly<Record<string, SettingsValue>>;
  /** Write one key. One line splice into this plugin's section. */
  set(key: string, value: SettingsValue): Promise<void>;
  /** Remove one key; the declared default applies again. */
  remove(key: string): Promise<void>;
  /** Fires on local writes and on changes that arrive through sync. */
  subscribe(listener: (values: Readonly<Record<string, SettingsValue>>) => void): Unsubscribe;
  /** The backing document's id — `undefined` until it exists. Read-only. */
  readonly documentId: string | undefined;
}

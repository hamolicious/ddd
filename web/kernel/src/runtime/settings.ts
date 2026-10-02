import {
  ContractViolationError,
  type DocumentRow,
  type FilterJson,
  type QuerySubscription,
  type SectionLineEdit,
  type SettingsApi,
  type SettingsSchema,
  type SettingsValue,
  type Unsubscribe,
} from "@kernel";

import type { DocumentsHost } from "./documents.js";
import { applyEdits, isValidKey, spliceSection } from "./splice.js";

export const SETTINGS_OWNER_KEY = "settings-owner";

export interface SettingsHostOptions {
  readonly documents: DocumentsHost;
  readonly userId: string;
  readonly userLabel?: string;
  readonly onWarn?: (message: string) => void;
}

type Values = Record<string, SettingsValue>;

type SettingsEdit = SectionLineEdit & { readonly value: SettingsValue | null };

export function settingsFilter(userId: string): FilterJson {
  return { cmp: { field: `fm.${SETTINGS_OWNER_KEY}`, op: "eq", value: { str: userId } } };
}

export class SettingsHost {
  readonly #schemas = new Map<string, SettingsSchema>();
  readonly #stored = new Map<string, Values>();
  readonly #listeners = new Map<string, Set<(values: Readonly<Values>) => void>>();
  #documentIds: readonly string[] = [];
  #sectionsByDocument = new Map<string, Record<string, Values>>();
  readonly #rejected = new Set<string>();
  #subscription: QuerySubscription | undefined;
  #creating: Promise<string> | undefined;
  #started = false;

  constructor(readonly options: SettingsHostOptions) {}

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const subscription = await this.options.documents.subscribe({
      filter: settingsFilter(this.options.userId),
      sort: [{ field: "id", direction: "asc" }],
      includeDeleted: false,
    });
    this.#subscription = subscription;
    this.#absorb(subscription.result.rows);
    subscription.onChange((result) => this.#absorb(result.rows));
  }

  stop(): void {
    this.#subscription?.close();
    this.#subscription = undefined;
    this.#started = false;
  }

  get documentId(): string | undefined {
    return this.#documentIds[0];
  }

  get documentIds(): readonly string[] {
    return this.#documentIds;
  }

  api(pluginId: string): SettingsApi {
    const host = this;
    return {
      defineSchema: (schema) => {
        host.#schemas.set(pluginId, schema);
      },
      schema: () => host.#schemas.get(pluginId) ?? {},
      get: <T extends SettingsValue>(key: string): T | undefined =>
        host.#effective(pluginId)[key] as T | undefined,
      all: () => host.#effective(pluginId),
      set: (key: string, value: SettingsValue) =>
        host.#write(pluginId, [{ key, value, remove: false }]),
      remove: (key: string) => host.#write(pluginId, [{ key, value: null, remove: true }]),
      subscribe: (listener): Unsubscribe => {
        const listeners = host.#listeners.get(pluginId) ?? new Set();
        host.#listeners.set(pluginId, listeners);
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      get documentId(): string | undefined {
        return host.documentId;
      },
    };
  }

  #effective(pluginId: string): Readonly<Values> {
    const schema = this.#schemas.get(pluginId);
    const defaults: Values = {};
    for (const [key, field] of Object.entries(schema ?? {})) {
      if (field.default !== undefined) defaults[key] = field.default;
    }
    return { ...defaults, ...this.#stored.get(pluginId) };
  }

  #absorb(rows: readonly DocumentRow[]): void {
    const accepted = this.#accepted(rows);
    this.#documentIds = accepted.map((row) => row.id);

    const next = new Map<string, Values>();
    this.#sectionsByDocument = new Map();
    for (const row of [...accepted].reverse()) {
      const perDocument: Record<string, Values> = {};
      for (const [pluginId, section] of Object.entries(row.plugins)) {
        const values = next.get(pluginId) ?? {};
        const mine: Values = {};
        if (section !== null && typeof section === "object" && !Array.isArray(section)) {
          for (const [key, value] of Object.entries(section)) {
            const scalar = asSettingsValue(value);
            if (scalar === undefined) {
              this.#warn(
                `settings: dropped "${pluginId}.${key}" — settings values are scalars or flat lists (SPEC §3.3)`,
              );
              continue;
            }
            values[key] = scalar;
            mine[key] = scalar;
          }
        }
        next.set(pluginId, values);
        perDocument[pluginId] = mine;
      }
      this.#sectionsByDocument.set(row.id, perDocument);
    }

    const touched = new Set<string>([...this.#stored.keys(), ...next.keys()]);
    const changed = [...touched].filter(
      (pluginId) => !sameValues(this.#stored.get(pluginId), next.get(pluginId)),
    );
    this.#stored.clear();
    for (const [pluginId, values] of next) this.#stored.set(pluginId, values);
    for (const pluginId of changed) this.#emit(pluginId);
  }

  #accepted(rows: readonly DocumentRow[]): readonly DocumentRow[] {
    const mine = rows.filter((row) => row.created_by === this.options.userId);
    const unattributed = rows.filter((row) => row.created_by === null);
    for (const row of rows) {
      if (row.created_by === this.options.userId || row.created_by === null) continue;
      if (this.#rejected.has(row.id)) continue;
      this.#rejected.add(row.id);
      this.#warn(
        `settings: ignoring document ${row.id} — it claims ${SETTINGS_OWNER_KEY}: ${this.options.userId} but was created by ${row.created_by}`,
      );
    }
    return mine.length > 0 ? mine : unattributed;
  }

  #emit(pluginId: string): void {
    const listeners = this.#listeners.get(pluginId);
    if (!listeners || listeners.size === 0) return;
    const snapshot = this.#effective(pluginId);
    for (const listener of [...listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        this.#warn(`settings: a "${pluginId}" listener threw: ${String(error)}`);
      }
    }
  }

  async #write(
    pluginId: string,
    edits: readonly SettingsEdit[],
  ): Promise<void> {
    for (const edit of edits) {
      if (!isValidKey(edit.key)) {
        throw new ContractViolationError(
          `settings key "${edit.key}" must match ^[A-Za-z0-9_-]{1,64}$`,
          { pluginId, key: edit.key },
        );
      }
      if (edit.remove !== true && asSettingsValue(edit.value) === undefined) {
        throw new ContractViolationError(
          `settings value for "${edit.key}" must be a string, number, boolean, null or a flat list`,
          { pluginId, key: edit.key },
        );
      }
    }

    const existing = this.documentId ?? (await this.#find());
    const splice = this.options.documents.forPlugin(pluginId).splice;
    if (existing !== undefined) {
      await splice.spliceSection(existing, edits);
      await this.#consolidate(pluginId, existing, edits.map((edit) => edit.key));
    } else {
      await this.#create(pluginId, edits);
    }

    const optimistic: Values = { ...this.#stored.get(pluginId) };
    for (const edit of edits) {
      if (edit.remove === true) delete optimistic[edit.key];
      else optimistic[edit.key] = edit.value as SettingsValue;
    }
    this.#stored.set(pluginId, optimistic);
    this.#emit(pluginId);
  }

  async #consolidate(
    pluginId: string,
    canonical: string,
    keys: readonly string[],
  ): Promise<void> {
    const splice = this.options.documents.forPlugin(pluginId).splice;
    for (const id of this.#documentIds) {
      if (id === canonical) continue;
      const section = this.#sectionsByDocument.get(id)?.[pluginId];
      const stale = keys.filter((key) => section !== undefined && key in section);
      if (stale.length === 0) continue;
      try {
        await splice.spliceSection(
          id,
          stale.map((key) => ({ key, value: null, remove: true })),
        );
      } catch (error) {
        this.#warn(
          `settings: could not clear ${stale.length} duplicate key(s) from ${id}: ${String(error)}`,
        );
      }
    }
  }

  async #create(
    pluginId: string,
    edits: readonly SettingsEdit[],
  ): Promise<void> {
    if (this.#creating) {
      const id = await this.#creating;
      await this.options.documents.forPlugin(pluginId).splice.spliceSection(id, edits);
      return;
    }
    const base = this.#template();
    const text = applyEdits(
      base,
      spliceSection(
        base,
        pluginId,
        edits
          .filter((edit) => edit.remove !== true)
          .map((edit) => ({ key: edit.key, value: edit.value })),
      ),
    );
    this.#creating = this.options.documents.create({ text });
    try {
      const id = await this.#creating;
      if (!this.#documentIds.includes(id)) this.#documentIds = [...this.#documentIds, id].sort();
    } finally {
      this.#creating = undefined;
    }
  }

  async #find(): Promise<string | undefined> {
    const result = await this.options.documents.query({
      filter: settingsFilter(this.options.userId),
      sort: [{ field: "id", direction: "asc" }],
      includeDeleted: false,
    });
    const ids = this.#accepted(result.rows).map((row) => row.id);
    if (ids.length > 0) this.#documentIds = ids;
    return ids[0];
  }

  #template(): string {
    const label = this.options.userLabel ?? this.options.userId;
    return [
      "---",
      `title: Settings — ${label}`,
      "machine: true",
      `${SETTINGS_OWNER_KEY}: ${this.options.userId}`,
      "---",
      "",
      `Per-user settings for ${label}, written by the kernel and its plugins.`,
      "",
      "Every plugin owns one `%%%` section below; edit a value by hand if you like —",
      "it is a document like any other. It is also visible to everyone in this",
      "workspace, so nothing secret belongs here (plugin secrets live in admin).",
      "",
    ].join("\n");
  }

  #warn(message: string): void {
    (this.options.onWarn ?? ((text: string) => console.warn(text)))(message);
  }
}

function asSettingsValue(value: unknown): SettingsValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.every(
      (item) =>
        item === null ||
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean",
    )
      ? (value as SettingsValue)
      : undefined;
  }
  return undefined;
}

function sameValues(a: Values | undefined, b: Values | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const left = a[key];
    const right = b[key];
    if (Array.isArray(left) || Array.isArray(right)) {
      return (
        Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((item, index) => item === right[index])
      );
    }
    return left === right;
  });
}

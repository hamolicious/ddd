/**
 * `kernel.settings` — per-user settings as **documents** (SPEC §6.4).
 *
 * ## The design, written down because it is the contract
 *
 * **One document per user.** It is identified by frontmatter, not by a naming
 * convention:
 *
 * ```markdown
 * ---
 * title: Settings — alice@example.com
 * path: .settings
 * settings-owner: 01J8ZUSER0000000000000000
 * ---
 * ```
 *
 * `fm.path` is {@link SETTINGS_DOC_PATH} so `folders` files it out of the way, and
 * **`fm.settings-owner` is the user id** — the key the kernel matches on. A path
 * alone would not do: the workspace is shared, so every user's settings document
 * sits in the same folder, and `folders` is a plugin that may be replaced or absent.
 *
 * The document is **machine-owned** (SPEC §3.3): the kernel authors its frontmatter
 * and body. Each plugin owns exactly one `%%% <plugin-id>` section inside it, written
 * with the *section splice helper* through that plugin's own facade — so two plugins
 * writing different keys never conflict, two clients writing the same key resolve
 * last-occurrence-wins, and attribution is the kernel's (SPEC §3.3, §6.4). There is
 * no second write path and no settings endpoint.
 *
 * What this buys, and what it costs — both stated, neither hidden:
 *
 * - Sync, offline reads, CRDT merging, snapshots, Trash and the admin export come
 *   for free, because a settings document is just a document.
 * - **Other users can read it.** The workspace is shared (SPEC §2). Never put a
 *   secret in settings; plugin secrets live in admin config, encrypted at rest
 *   (SPEC §6.2). The `settings` plugin says so in its UI (`base-tools`).
 * - Values are YAML scalars, one key per line, so they are **shallow by design**:
 *   string, number, boolean, null, or a flow sequence of those. A nested map is
 *   dropped on read and refused on write.
 *
 * ## Reads are synchronous, and how
 *
 * The document is in the projection like any other, so `get`/`all` answer from a
 * cache this host keeps. {@link SettingsHost.start} opens one live local query
 * (`fm.path` + `fm.settings-owner`) before any plugin activates and re-derives the
 * cache from it — which is also how a change another device made shows up here.
 *
 * ## Whose document is it — matching, and why `created_by` is part of it
 *
 * `fm.settings-owner` says who a settings document is *for*, and a shared workspace
 * means anyone can write that key into any document (SPEC §2). So the frontmatter
 * claim is not sufficient on its own: a candidate is accepted only when the **server's
 * `created_by`** on the projection row is the same user. `created_by` is stamped
 * server-side at creation (SPEC §3.5) and is not writable from a document's text, which
 * makes it the one half of the pair a second user cannot forge.
 *
 * Without that check, planting a document with somebody else's `settings-owner` was a
 * way to override their settings — keybindings included — from across the workspace,
 * with no way for them to undo it from the UI. Rows that claim the ownership but were
 * created by someone else are ignored and warned about once.
 *
 * (A row whose `created_by` is `null` — a pre-attribution or restored document — is
 * accepted only when *no* properly attributed document exists, so an unattributed
 * legacy settings document keeps working and can never outrank a real one.)
 *
 * ## First run, and duplicates
 *
 * Nothing is created until the first `set()`: a fresh workspace has no empty
 * settings document in it, and `documentId` stays `undefined` until then. The first
 * write creates the document with the plugin's section already in it, in one
 * request, so there is no create-then-splice window to lose.
 *
 * One user's own clients can still both create one (two devices, both offline, both
 * writing). That is a two-document state, not a corrupt one, and the rule that makes it
 * harmless is that **reads and writes agree on which document wins**:
 *
 * - the **canonical** document is the lowest id (ULIDs sort by creation, so it is the
 *   one created first) — that is where every write goes;
 * - reads merge every accepted document with the canonical one **winning per key**, so
 *   a value that was just written is the value that is read back;
 * - a write also **removes the same keys from the non-canonical duplicates**, so the
 *   state converges to one document instead of flip-flopping forever.
 *
 * The middle rule is the one that was wrong before: reads let the *highest* id win while
 * writes went to the lowest, so with two documents in play every write was silently
 * reverted by the next feed tick — a chosen theme visibly flipping back, permanently.
 */

import {
  ContractViolationError,
  SETTINGS_DOC_PATH,
  type DocumentRow,
  type FilterJson,
  type QuerySubscription,
  type SettingsApi,
  type SettingsSchema,
  type SettingsValue,
  type Unsubscribe,
} from "@kernel";

import type { DocumentsHost } from "./documents.js";
import { applyEdits, isValidKey, spliceSection } from "./splice.js";

/** The frontmatter key carrying the owning user's id. */
export const SETTINGS_OWNER_KEY = "settings-owner";

export interface SettingsHostOptions {
  readonly documents: DocumentsHost;
  readonly userId: string;
  /** Shown in the document's title, so a human can tell whose it is. */
  readonly userLabel?: string;
  /** Reported once per offending key; defaults to `console.warn`. */
  readonly onWarn?: (message: string) => void;
}

type Values = Record<string, SettingsValue>;

/** The local query that finds this user's settings document(s). */
export function settingsFilter(userId: string): FilterJson {
  return {
    and: [
      { cmp: { field: "fm.path", op: "eq", value: { str: SETTINGS_DOC_PATH } } },
      { cmp: { field: `fm.${SETTINGS_OWNER_KEY}`, op: "eq", value: { str: userId } } },
    ],
  };
}

export class SettingsHost {
  readonly #schemas = new Map<string, SettingsSchema>();
  /** plugin id → the keys stored in the document, defaults *not* merged in. */
  readonly #stored = new Map<string, Values>();
  readonly #listeners = new Map<string, Set<(values: Readonly<Values>) => void>>();
  /** Every accepted document, id-ascending. The first is the canonical write target. */
  #documentIds: readonly string[] = [];
  /** Per accepted document: the sections it holds, so a write can consolidate. */
  #sectionsByDocument = new Map<string, Record<string, Values>>();
  /** Impostor documents already warned about, so the warning is once per document. */
  readonly #rejected = new Set<string>();
  #subscription: QuerySubscription | undefined;
  #creating: Promise<string> | undefined;
  #started = false;

  constructor(readonly options: SettingsHostOptions) {}

  /**
   * Open the live query and prime the cache. Called by the app once, before the
   * first plugin activates, so `get()` is already answerable inside `activate()`.
   *
   * Failing here is not fatal: settings fall back to the declared defaults and the
   * app reports it. A workspace whose search index is still warming must still boot.
   */
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

  /** Close the live query (sign-out, teardown). */
  stop(): void {
    this.#subscription?.close();
    this.#subscription = undefined;
    this.#started = false;
  }

  /** The canonical document — the write target — once one exists. */
  get documentId(): string | undefined {
    return this.#documentIds[0];
  }

  /** Every accepted settings document for this user — more than one means a merge. */
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
      set: (key: string, value: SettingsValue) => host.#write(pluginId, [{ key, value }]),
      remove: (key: string) => host.#write(pluginId, [{ key, value: null }]),
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

  // -------------------------------------------------------------------------
  // reads
  // -------------------------------------------------------------------------

  /** Stored values with the declared defaults underneath them. */
  #effective(pluginId: string): Readonly<Values> {
    const schema = this.#schemas.get(pluginId);
    const defaults: Values = {};
    for (const [key, field] of Object.entries(schema ?? {})) {
      if (field.default !== undefined) defaults[key] = field.default;
    }
    return { ...defaults, ...this.#stored.get(pluginId) };
  }

  /**
   * Re-derive the cache from the query result and fire the plugins whose values
   * actually changed.
   *
   * Rows arrive id-ascending and are merged **in reverse**, so the lowest id — the
   * canonical document, which is also the write target — wins per key. Keys only a
   * duplicate holds still surface; they are what the next write consolidates away.
   */
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

  /**
   * The rows that really are this user's settings documents.
   *
   * `fm.settings-owner` is text in a document anybody in the shared workspace can
   * write, so the frontmatter claim is checked against the server's `created_by` (see
   * the module header). Unattributed rows (`created_by: null`) are a fallback only —
   * they are used when nothing properly attributed exists, so a legacy or restored
   * document keeps working without ever outranking a real one.
   */
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

  // -------------------------------------------------------------------------
  // writes
  // -------------------------------------------------------------------------

  /**
   * One line splice into the plugin's own section — the only write path (SPEC §3.3).
   *
   * The value is validated *before* anything is created or opened, so a plugin
   * handing over an object cannot leave a half-written document behind.
   */
  async #write(
    pluginId: string,
    edits: readonly { readonly key: string; readonly value: SettingsValue | null }[],
  ): Promise<void> {
    for (const edit of edits) {
      if (!isValidKey(edit.key)) {
        throw new ContractViolationError(
          `settings key "${edit.key}" must match ^[A-Za-z0-9_-]{1,64}$`,
          { pluginId, key: edit.key },
        );
      }
      if (edit.value !== null && asSettingsValue(edit.value) === undefined) {
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

    // The write reaches the cache through the feed, but the plugin that just wrote
    // should not have to wait a round trip to read its own value back.
    const optimistic: Values = { ...this.#stored.get(pluginId) };
    for (const edit of edits) {
      if (edit.value === null) delete optimistic[edit.key];
      else optimistic[edit.key] = edit.value;
    }
    this.#stored.set(pluginId, optimistic);
    this.#emit(pluginId);
  }

  /**
   * Remove the keys just written from every **non-canonical** duplicate.
   *
   * This is what makes "the next write consolidates" true rather than aspirational.
   * Writing the canonical document alone would leave the duplicate's copy of the key in
   * place forever; reads prefer the canonical value, so the user would see the right
   * thing while the workspace quietly kept a second, divergent answer — and any change
   * to the merge order would resurrect it.
   *
   * Best-effort on purpose: a duplicate that cannot be opened (never hydrated, offline)
   * must not fail the write that already succeeded. It is retried by the next write.
   */
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
          stale.map((key) => ({ key, value: null })),
        );
      } catch (error) {
        this.#warn(
          `settings: could not clear ${stale.length} duplicate key(s) from ${id}: ${String(error)}`,
        );
      }
    }
  }

  /**
   * One-shot creation: the document is created **with** the plugin's section
   * already in it. Concurrent first writes share the one create (`#creating`), and
   * whoever loses the race splices into the document the winner made.
   */
  async #create(
    pluginId: string,
    edits: readonly { readonly key: string; readonly value: SettingsValue | null }[],
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
        edits.filter((edit) => edit.value !== null).map((edit) => ({ key: edit.key, value: edit.value })),
      ),
    );
    this.#creating = this.options.documents.create({ text });
    try {
      const id = await this.#creating;
      // `#absorb` will see it through the feed; recording it now keeps the *next*
      // write from creating a second document while that is in flight.
      if (!this.#documentIds.includes(id)) this.#documentIds = [...this.#documentIds, id].sort();
    } finally {
      this.#creating = undefined;
    }
  }

  /** A direct query, for the window before `start()` has seen the document. */
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

  /** The document the kernel authors. Machine-owned, and readable by a human. */
  #template(): string {
    const label = this.options.userLabel ?? this.options.userId;
    return [
      "---",
      `title: Settings — ${label}`,
      `path: ${SETTINGS_DOC_PATH}`,
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

/** A projection value narrowed to what a settings key may hold, or `undefined`. */
function asSettingsValue(value: unknown): SettingsValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    // A flow sequence of scalars. A list of maps is not a settings value.
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

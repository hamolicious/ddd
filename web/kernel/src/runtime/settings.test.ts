/**
 * `kernel.settings` end to end: the settings **document** of SPEC §6.4, over the
 * real query engine, the real Wasm parser and the real splice helper.
 *
 * The fake here is only the *server*: a `#materialize` that parses a document with
 * the shared core and pushes the row into the projection store, which is exactly
 * what the server does and the feed delivers (SPEC §3.5, §4.1). Everything the
 * settings host touches — the filter DSL, `plugins` materialization, the section
 * splice, the live local query — is the production code path, so this suite fails if
 * any of them stops agreeing about what a settings document is.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { OpenDocument, SettingsApi } from "@kernel";

import { QueryEngine } from "../query/index.js";
import { MemoryProjectionStore, feedRow } from "../store/testing.js";
import type { SyncClient } from "../sync/client.js";
import { coreArtifactExists, loadCoreForNode } from "../wasm/node-core.js";
import type { CoreBindings } from "../wasm/index.js";
import { DocumentsHost } from "./documents.js";
import { SettingsHost, SETTINGS_OWNER_KEY } from "./settings.js";

const USER = "01J8ZUSER0000000000000000";
const OTHER_USER = "01J8ZUSER0000000000000001";

/** Two event-loop turns: enough for a store batch to reach a live query. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * A workspace with a server in it: documents are text, every write is
 * re-materialized by the shared core, and the row lands in the projection store the
 * way the change feed would deliver it.
 */
class FakeWorkspace {
  readonly store = new MemoryProjectionStore();
  readonly engine: QueryEngine;
  readonly documents: DocumentsHost;
  readonly texts = new Map<string, string>();
  /** Document id → the `created_by` the server stamped. */
  readonly creators = new Map<string, string>();
  readonly opened = new Map<string, OpenDocument>();
  creates = 0;
  #seq = 0;
  #ids = 0;

  constructor(private readonly core: CoreBindings) {
    this.engine = new QueryEngine(this.store, core);
    this.documents = new DocumentsHost({
      engine: this.engine,
      sync: {
        open: (id: string) => Promise.resolve(this.#open(id)),
        store: this.store,
        state: { status: "synced" },
        docs: {
          seed: (_id: string, text: string) => {
            const doc = new Y.Doc();
            doc.getText("content").insert(0, text);
            return Promise.resolve(Y.encodeStateAsUpdate(doc));
          },
          created: () => undefined,
          forget: () => Promise.resolve(),
        },
      } as unknown as SyncClient,
      api: (path, init) => this.#api(path, init),
    });
  }

  text(id: string): string {
    return this.texts.get(id) ?? "";
  }

  /**
   * A document arriving through the feed. `createdBy` is the server's attribution
   * (`created_by`), which is what tells this user's settings document apart from one
   * another user planted with the same `settings-owner` key.
   */
  async seed(id: string, text: string, createdBy: string = USER): Promise<void> {
    this.texts.set(id, text);
    this.creators.set(id, createdBy);
    await this.#materialize(id);
  }

  #open(id: string): OpenDocument {
    const existing = this.opened.get(id);
    if (existing) return existing;
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const initial = this.texts.get(id);
    if (initial !== undefined && initial.length > 0) text.insert(0, initial);
    doc.on("update", () => {
      this.texts.set(id, text.toString());
      void this.#materialize(id);
    });
    const handle: OpenDocument = {
      id,
      doc,
      text,
      phase: "live",
      onAwareness: () => () => undefined,
      sendAwareness: () => undefined,
      release: () => undefined,
    };
    this.opened.set(id, handle);
    return handle;
  }

  async #api(path: string, init?: RequestInit): Promise<Response> {
    if (path === "/documents" && init?.method === "POST") {
      this.creates += 1;
      const body = JSON.parse(String(init.body)) as { id?: string; content?: string; state?: string };
      this.#ids += 1;
      const id = body.id ?? `01J8ZDOC${String(this.#ids).padStart(17, "0")}`;
      let content = body.content ?? "";
      if (body.state !== undefined) {
        // The device's own CRDT state (PROTOCOL.md §3.8): the text is what it holds.
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Uint8Array.from(atob(body.state), (char) => char.charCodeAt(0)));
        content = doc.getText("content").toString();
      }
      this.texts.set(id, content);
      await this.#materialize(id);
      return new Response(JSON.stringify({ id }), { status: 201 });
    }
    throw new Error(`unexpected API call ${init?.method ?? "GET"} ${path}`);
  }

  /** What the server does after applying an update (SPEC §3.5), then the feed. */
  async #materialize(id: string): Promise<void> {
    const text = this.texts.get(id) ?? "";
    const parsed = this.core.parseDocument(text);
    this.#seq += 1;
    await this.store.applyRows(
      [
        feedRow({
          id,
          seq: this.#seq,
          title: parsed.title,
          content: text,
          fm: parsed.fm,
          plugins: parsed.plugins,
          fm_parse_error: parsed.fm_parse_error,
          created_by: this.creators.get(id) ?? USER,
        }),
      ],
      { safeSeq: this.#seq, updatedAt: Date.now(), coreSemanticsVersion: null, bootstrapped: true },
    );
  }
}

describe.skipIf(!coreArtifactExists())("per-user settings documents", () => {
  let core: CoreBindings;
  beforeAll(async () => {
    core = await loadCoreForNode();
  });

  let workspace: FakeWorkspace;
  let host: SettingsHost;
  let themes: SettingsApi;
  let editor: SettingsApi;

  beforeEach(async () => {
    workspace = new FakeWorkspace(core);
    host = new SettingsHost({
      documents: workspace.documents,
      userId: USER,
      userLabel: "alice@example.com",
      onWarn: () => undefined,
    });
    await host.start();
    themes = host.api("themes");
    editor = host.api("editor");
    themes.defineSchema({
      theme: { type: "string", default: "kernel-light" },
      density: { type: "enum", options: ["cosy", "compact"] },
    });
  });

  it("answers from the declared defaults before anything is stored", () => {
    expect(host.documentId).toBeUndefined();
    expect(themes.get("theme")).toBe("kernel-light");
    expect(themes.get("density")).toBeUndefined();
    expect(themes.all()).toEqual({ theme: "kernel-light" });
  });

  it("creates the document on the first write, owned by this user", async () => {
    await themes.set("theme", "solarized");
    await settle();

    const id = host.documentId;
    expect(id).toBeDefined();
    const text = workspace.text(id as string);
    const parsed = core.parseDocument(text);
    expect(parsed.fm["path"]).toBe(".settings");
    expect(parsed.fm[SETTINGS_OWNER_KEY]).toBe(USER);
    expect(parsed.plugins["themes"]).toEqual({ theme: "solarized" });
    // Machine-owned, but a human can read it: the body says what it is.
    expect(text).toContain("Per-user settings for alice@example.com");
    expect(themes.get("theme")).toBe("solarized");
    expect(workspace.creates).toBe(1);
  });

  it("splices a second plugin into the same document", async () => {
    await themes.set("theme", "solarized");
    await settle();
    await editor.set("wrap", true);
    await editor.set("tab-size", 4);
    await settle();

    expect(workspace.creates).toBe(1);
    expect(host.documentIds).toHaveLength(1);
    const parsed = core.parseDocument(workspace.text(host.documentId as string));
    expect(parsed.plugins["themes"]).toEqual({ theme: "solarized" });
    expect(parsed.plugins["editor"]).toEqual({ wrap: true, "tab-size": 4 });
  });

  it("does not create a second document when two plugins write at once", async () => {
    await Promise.all([themes.set("theme", "a"), editor.set("wrap", false)]);
    await settle();
    expect(workspace.creates).toBe(1);
    const parsed = core.parseDocument(workspace.text(host.documentId as string));
    expect(parsed.plugins["themes"]).toEqual({ theme: "a" });
    expect(parsed.plugins["editor"]).toEqual({ wrap: false });
  });

  it("removes a key so the default applies again", async () => {
    await themes.set("theme", "solarized");
    await settle();
    await themes.remove("theme");
    await settle();
    expect(themes.get("theme")).toBe("kernel-light");
    expect(core.parseDocument(workspace.text(host.documentId as string)).plugins["themes"]).toEqual(
      {},
    );
  });

  it("stores lists, numbers, booleans and null", async () => {
    await editor.set("extensions", ["a", "b"]);
    await editor.set("size", 13.5);
    await editor.set("wrap", true);
    await settle();
    expect(editor.all()).toEqual({ extensions: ["a", "b"], size: 13.5, wrap: true });
    const plugins = core.parseDocument(workspace.text(host.documentId as string)).plugins;
    expect(plugins["editor"]).toEqual({ extensions: ["a", "b"], size: 13.5, wrap: true });
  });

  it("refuses a nested value and an unwritable key, before touching the workspace", async () => {
    await expect(editor.set("nested", { a: 1 } as never)).rejects.toThrow(/string, number/);
    await expect(editor.set("not a key", 1)).rejects.toThrow(/\^\[A-Za-z0-9_-\]/);
    expect(workspace.creates).toBe(0);
    expect(host.documentId).toBeUndefined();
  });

  it("notifies on a change that arrives through sync", async () => {
    await themes.set("theme", "solarized");
    await settle();
    const seen: unknown[] = [];
    themes.subscribe((values) => seen.push(values));

    // Another device edits the same document; the feed delivers the new row.
    const id = host.documentId as string;
    await workspace.seed(id, workspace.text(id).replace("theme: solarized", "theme: nord"));
    await settle();

    expect(themes.get("theme")).toBe("nord");
    expect(seen).toEqual([{ theme: "nord" }]);
  });

  it("ignores another user's settings document", async () => {
    await workspace.seed(
      "01J8ZOTHER000000000000000",
      `---\npath: .settings\n${SETTINGS_OWNER_KEY}: ${OTHER_USER}\n---\n\n%%% themes\ntheme: not-mine\n%%%\n`,
    );
    await settle();
    expect(host.documentId).toBeUndefined();
    expect(themes.get("theme")).toBe("kernel-light");
  });

  it("merges duplicate documents with the canonical one winning, and writes to it", async () => {
    const first = "01J8ZDUPE000000000000000A";
    const second = "01J8ZDUPE000000000000000B";
    const doc = (theme: string, extra: string): string =>
      `---\npath: .settings\n${SETTINGS_OWNER_KEY}: ${USER}\n---\n\n%%% themes\ntheme: ${theme}\n${extra}\n%%%\n`;
    await workspace.seed(first, doc("first", "density: cosy"));
    await workspace.seed(second, doc("second", "extra: yes"));
    await settle();

    expect(host.documentIds).toEqual([first, second]);
    // The canonical (lowest id) document wins per key — the same document a write
    // targets — and keys only the duplicate holds still surface.
    expect(themes.all()).toEqual({ theme: "first", density: "cosy", extra: "yes" });

    // The write consolidates into the canonical document rather than making a third…
    await themes.set("theme", "chosen");
    await settle();
    expect(workspace.creates).toBe(0);
    expect(core.parseDocument(workspace.text(first)).plugins["themes"]).toMatchObject({
      theme: "chosen",
    });
    // …the duplicate's copy of that key is removed, so the value cannot come back…
    expect(core.parseDocument(workspace.text(second)).plugins["themes"]).toEqual({ extra: "yes" });
    // …and the value read back is the value written. Reading `second` here was the
    // bug: writes went to the lowest id while reads let the highest win, so every
    // write was reverted by the next feed tick, permanently.
    expect(themes.get("theme")).toBe("chosen");
    expect(themes.all()).toEqual({ theme: "chosen", density: "cosy", extra: "yes" });
  });

  it("ignores a settings document another user planted with this user's owner key", async () => {
    // The shared workspace means anybody can *write* `settings-owner`; only the server
    // stamps `created_by`. A later ULID used to win every key, which handed one user
    // control of another's settings — keybindings included — with no way to undo it.
    const mine = "01J8ZMINE000000000000000A";
    const planted = "01J8ZPLANTED0000000000000";
    await workspace.seed(
      mine,
      `---\npath: .settings\n${SETTINGS_OWNER_KEY}: ${USER}\n---\n\n%%% themes\ntheme: mine\n%%%\n`,
    );
    await workspace.seed(
      planted,
      `---\npath: .settings\n${SETTINGS_OWNER_KEY}: ${USER}\n---\n\n%%% themes\ntheme: planted\n%%%\n`,
      OTHER_USER,
    );
    await settle();

    expect(host.documentIds).toEqual([mine]);
    expect(themes.get("theme")).toBe("mine");

    // And a write still lands in the user's own document, not the planted one.
    await themes.set("theme", "chosen");
    await settle();
    expect(themes.get("theme")).toBe("chosen");
    expect(core.parseDocument(workspace.text(planted)).plugins["themes"]).toEqual({
      theme: "planted",
    });
  });

  it("drops a value that is not a settings value, keeping the rest", async () => {
    const id = "01J8ZDEEP000000000000000A";
    await workspace.seed(
      id,
      `---\npath: .settings\n${SETTINGS_OWNER_KEY}: ${USER}\n---\n\n%%% themes\ntheme: nord\nnested: {a: 1}\n%%%\n`,
    );
    await settle();
    expect(themes.all()).toEqual({ theme: "nord" });
  });

  it("stops the live query on teardown", async () => {
    await themes.set("theme", "solarized");
    await settle();
    host.stop();
    const id = host.documentId as string;
    await workspace.seed(id, workspace.text(id).replace("solarized", "nord"));
    await settle();
    // No live query, so the cache is frozen at what it last saw. Sign-out clears
    // everything anyway; what matters is that nothing throws after `stop()`.
    expect(themes.get("theme")).toBe("solarized");
  });
});

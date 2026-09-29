/**
 * `kernel.documents.splice` over a real `Y.Doc`: attribution, hydration
 * bookkeeping, and the one-transaction rule.
 *
 * `splice.test.ts` proves the *edits* match the shared core. This file proves the
 * kernel applies them the way SPEC §3.3 and §6.4 require: one transaction, the
 * calling plugin's section and no other, and a document opened for the write
 * released again afterwards.
 */

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import type { OpenDocument } from "@kernel";

import type { QueryEngine } from "../query/index.js";
import type { SyncClient } from "../sync/client.js";
import { DocumentsHost } from "./documents.js";

/** A hydrated document, minus the socket. */
class FakeOpen implements OpenDocument {
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  phase: OpenDocument["phase"] = "live";
  opens = 0;
  releases = 0;

  constructor(
    readonly id: string,
    initial: string,
  ) {
    this.text = this.doc.getText("content");
    this.text.insert(0, initial);
  }

  onAwareness(): () => void {
    return () => undefined;
  }
  sendAwareness(): void {}
  release(): void {
    this.releases += 1;
  }
}

function host(open: FakeOpen): DocumentsHost {
  return new DocumentsHost({
    engine: {} as QueryEngine,
    sync: {
      open: (id: string) => {
        if (id !== open.id) throw new Error(`unexpected open("${id}")`);
        open.opens += 1;
        return Promise.resolve(open);
      },
    } as unknown as SyncClient,
    api: () => Promise.reject(new Error("no REST in this test")),
  });
}

describe("splice writes through the CRDT", () => {
  it("sets a frontmatter value on an already-open document", async () => {
    const open = new FakeOpen("doc1", "---\ntitle: Old\npath: home\n---\n\nbody\n");
    const documents = host(open).forPlugin("properties");
    await documents.splice.setFrontmatterValue(open, "title", "New");
    expect(open.text.toString()).toBe("---\ntitle: New\npath: home\n---\n\nbody\n");
    // A document the caller owns is neither re-opened nor released by the kernel.
    expect(open.opens).toBe(0);
    expect(open.releases).toBe(0);
  });

  it("hydrates and releases a document given by id", async () => {
    const open = new FakeOpen("doc1", "---\npath: home\n---\n");
    const documents = host(open).forPlugin("folders");
    await documents.splice.setFrontmatterValue("doc1", "path", "home/lists");
    expect(open.text.toString()).toBe("---\npath: home/lists\n---\n");
    expect(open.opens).toBe(1);
    expect(open.releases).toBe(1);
  });

  it("releases the document even when the plan throws", async () => {
    const open = new FakeOpen("doc1", "body\n");
    const documents = host(open).forPlugin("folders");
    await expect(documents.splice.setFrontmatterValue("doc1", "not a key", "x")).rejects.toThrow();
    expect(open.releases).toBe(1);
  });

  it("applies every edit of one splice in a single transaction", async () => {
    const open = new FakeOpen("doc1", "---\na: 1\nb: 2\na: 3\n---\n");
    const documents = host(open).forPlugin("properties");
    let transactions = 0;
    const origins: unknown[] = [];
    open.doc.on("afterTransaction", (transaction: Y.Transaction) => {
      transactions += 1;
      origins.push(transaction.origin);
    });
    await documents.splice.removeFrontmatterKey(open, "a");
    expect(open.text.toString()).toBe("---\nb: 2\n---\n");
    expect(transactions).toBe(1);
    // A stable, plugin-attributed origin: `y-codemirror.next` filters on it.
    expect(origins).toEqual(["splice:properties"]);
  });

  it("writes nothing, and opens no transaction, when there is nothing to do", async () => {
    const open = new FakeOpen("doc1", "---\na: 1\n---\n");
    const documents = host(open).forPlugin("properties");
    let transactions = 0;
    open.doc.on("afterTransaction", () => {
      transactions += 1;
    });
    await documents.splice.removeFrontmatterKey(open, "absent");
    expect(transactions).toBe(0);
  });

  it("refuses a document that failed to hydrate rather than writing into an empty replica", async () => {
    const open = new FakeOpen("doc1", "");
    open.phase = "error";
    const documents = host(open).forPlugin("properties");
    await expect(documents.splice.setFrontmatterValue(open, "title", "X")).rejects.toThrow(
      /failed to hydrate/,
    );
    expect(open.text.toString()).toBe("");
  });
});

describe("a plugin's section is its own", () => {
  it("writes only the calling plugin's `%%%` section", async () => {
    const open = new FakeOpen("doc1", "body\n\n%%% calendar\nuid: a\n%%%\n");
    const shared = host(open);
    await shared.forPlugin("calendar").splice.spliceSection(open, [{ key: "uid", value: "b" }]);
    await shared.forPlugin("agenda").splice.spliceSection(open, [{ key: "shown", value: true }]);
    expect(open.text.toString()).toBe(
      "body\n\n%%% calendar\nuid: b\n%%%\n%%% agenda\nshown: true\n%%%\n",
    );
  });

  it("removes only its own section", async () => {
    const open = new FakeOpen("doc1", "body\n\n%%% a\nx: 1\n%%%\n%%% b\ny: 2\n%%%\n");
    await host(open).forPlugin("a").splice.removeSection(open);
    expect(open.text.toString()).toBe("body\n\n%%% b\ny: 2\n%%%\n");
  });

  it("pushes, removes and pops list items in the plugin's own section", async () => {
    const open = new FakeOpen("doc1", "body\n");
    const splice = host(open).forPlugin("folders").splice;
    await splice.sectionList(open, "children", { action: "push", value: "01A" });
    await splice.sectionList(open, "children", { action: "push", value: "01B" });
    await splice.sectionList(open, "children", { action: "insert", index: 0, value: "01C" });
    expect(open.text.toString()).toBe("body\n\n%%% folders\nchildren:\n  - 01C\n  - 01A\n  - 01B\n%%%\n");
    await splice.sectionList(open, "children", { action: "remove", value: "01A" });
    expect(await splice.sectionList(open, "children", { action: "pop" })).toBe("01B");
    expect(open.text.toString()).toBe("body\n\n%%% folders\nchildren:\n  - 01C\n%%%\n");
  });

  it("removes a key's line when the edit says `remove`", async () => {
    const open = new FakeOpen("doc1", "%%% a\nx: 1\ny: 2\n%%%\n");
    await host(open)
      .forPlugin("a")
      .splice.spliceSection(open, [{ key: "x", value: null, remove: true }]);
    expect(open.text.toString()).toBe("%%% a\ny: 2\n%%%\n");
  });

  // The distinction `remove` was added for: the strict YAML subset of SPEC §3.4 has a
  // `null` scalar, and before this a plugin had no way to write one — `value: null`
  // was spelled for deletion and spent the only spelling JSON has for an explicit null.
  it("writes a literal null when `remove` is not set", async () => {
    const open = new FakeOpen("doc1", "%%% a\nx: 1\ny: 2\n%%%\n");
    await host(open)
      .forPlugin("a")
      .splice.spliceSection(open, [{ key: "x", value: null, remove: false }]);
    expect(open.text.toString()).toBe("%%% a\nx: null\ny: 2\n%%%\n");
  });

  it("writes a literal null into a section that does not exist yet", async () => {
    const open = new FakeOpen("doc1", "body\n");
    await host(open)
      .forPlugin("a")
      .splice.spliceSection(open, [{ key: "x", value: null, remove: false }]);
    expect(open.text.toString()).toBe("body\n\n%%% a\nx: null\n%%%\n");
  });

  /**
   * The one spelling whose meaning changed between kernel 1.0.0 and 1.1.0, and the only
   * thing that can be done about it short of a major.
   *
   * `{ key, value: null }` used to delete the key's line and now writes `key: null`. The
   * two are byte-identical on the way in, so the install gate cannot refuse the old one:
   * `KERNEL_API_MAJOR` is still `1`, `"kernel": "^1.0"` still resolves, and a plugin
   * written against 1.0.0 loads and then quietly accretes null lines where it meant to
   * clear them. The write follows the *new* contract — that is what the contract says —
   * and the author is told, at the call site, once.
   */
  it("warns once per key when a null arrives without an explicit `remove`", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const open = new FakeOpen("doc1", "%%% migrating\nx: 1\n%%%\n");
      const splice = host(open).forPlugin("migrating").splice;
      await splice.spliceSection(open, [{ key: "x", value: null }]);
      await splice.spliceSection(open, [{ key: "x", value: null }]);

      expect(open.text.toString()).toBe("%%% migrating\nx: null\n%%%\n");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("remove: true");

      // An explicit `remove: false` is the author saying they meant the null.
      await splice.spliceSection(open, [{ key: "y", value: null, remove: false }]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the planners are pure", () => {
  it("returns edits without touching anything", () => {
    const open = new FakeOpen("doc1", "---\na: 1\n---\n");
    const splice = host(open).forPlugin("p").splice;
    const text = "---\na: 1\n---\n";
    const fm = splice.planFrontmatterValue(text, "b", 2);
    const section = splice.planSection(text, [{ key: "k", value: "v" }]);
    expect(fm).toHaveLength(1);
    expect(section).toHaveLength(1);
    expect(open.text.toString()).toBe(text);
    // `apply` is the caller's way to batch several plans into one transaction.
    let transactions = 0;
    open.doc.on("afterTransaction", () => {
      transactions += 1;
    });
    splice.apply(open, [...fm, ...section], "batch");
    expect(transactions).toBe(1);
    expect(open.text.toString()).toBe("---\na: 1\nb: 2\n---\n\n%%% p\nk: v\n%%%\n");
  });
});

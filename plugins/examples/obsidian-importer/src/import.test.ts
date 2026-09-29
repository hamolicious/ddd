import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";
import type { Kernel, SectionLineEdit } from "@kernel";

import { setFrontmatterValue, spliceSection } from "../../../../web/kernel/src/runtime/splice.js";
import { importVault, prepareAttachmentDocument } from "./import.js";

const kernel = {
  pluginId: "obsidian-importer",
  documents: {
    splice: {
      planFrontmatterValue: setFrontmatterValue,
      planSection: (text: string, edits: readonly SectionLineEdit[]) =>
        spliceSection(
          text,
          "obsidian-importer",
          edits.map((edit) => ({ key: edit.key, value: edit.remove ? undefined : edit.value })),
        ),
    },
  },
} as unknown as Kernel;

describe("Obsidian attachment wrappers", () => {
  it("keeps the durable source identity", () => {
    const text = prepareAttachmentDocument(kernel, "My Vault", "Assets/photo.png", {
      id: "01JATTACHMENT00000000000000",
      name: "photo.png",
      mime: "image/png",
    });

    expect(text).toContain("title: photo.png\n");
    expect(text).not.toMatch(/^path:/m);
    expect(text).toContain("attachment: 01JATTACHMENT00000000000000\n");
    expect(text).toContain("![photo.png](attachment://01JATTACHMENT00000000000000)\n");
    expect(text).toContain("source_kind: attachment\n");
    expect(text).toContain("source_path: Assets/photo.png\n");
    expect(text).toContain("attachment_id: 01JATTACHMENT00000000000000\n");
  });

  it("links non-images instead of embedding them", () => {
    const text = prepareAttachmentDocument(kernel, "Vault", "manual.pdf", {
      id: "01JATTACHMENT00000000000000",
      name: "manual.pdf",
      mime: "application/pdf",
    });
    expect(text).toContain("[manual.pdf](attachment://01JATTACHMENT00000000000000)\n");
    expect(text).not.toContain("![manual.pdf]");
  });

  it("uploads once and discovers the wrapper on a retry", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const upload = vi.fn(async () => ({
      attachment: { id: "01JATTACHMENT00000000000000", name: "photo.png", mime: "image/png" },
    }));
    const importingKernel = {
      ...kernel,
      ports: { bound: () => false, use: () => ({ upload }) },
      documents: {
        ...kernel.documents,
        query: async ({ offset }: { readonly offset: number }) => ({
          rows: rows.slice(offset),
          total: rows.length,
        }),
        create: async ({ id, text }: { readonly id: string; readonly text: string }) => {
          rows.push({
            id,
            deleted: false,
            plugins: {
              "obsidian-importer": {
                archive: "Retry Vault",
                source_path: "Assets/photo.png",
                source_kind: "attachment",
                attachment_id: "01JATTACHMENT00000000000000",
              },
            },
            text,
          });
        },
      },
      log: { error: vi.fn() },
    } as unknown as Kernel;
    const archive = {
      notes: [],
      attachments: [
        {
          path: "Assets/photo.png",
          size: 3,
          bytes: async () => Uint8Array.of(1, 2, 3),
        },
      ],
      skippedFiles: 0,
    };

    const first = await importVault(importingKernel, "Retry Vault", archive, () => undefined);
    const second = await importVault(importingKernel, "Retry Vault", archive, () => undefined);

    expect(first).toMatchObject({ attachmentsImported: 1, attachmentsAlreadyImported: 0, failed: [] });
    expect(second).toMatchObject({ attachmentsImported: 0, attachmentsAlreadyImported: 1, failed: [] });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });

  it("repairs attachment links when an imported vault is selected again", async () => {
    let noteText = "![photo.png](attachment://01JATTACHMENT00000000000000)\n";
    const rows = [
      {
        id: "01JNOTE00000000000000000000",
        deleted: false,
        plugins: {
          "obsidian-importer": {
            archive: "Retry Vault",
            source_path: "Notes/Today.md",
            source_kind: "note",
          },
        },
      },
      {
        id: "01JWRAPPER0000000000000000",
        deleted: false,
        plugins: {
          "obsidian-importer": {
            archive: "Retry Vault",
            source_path: "Assets/photo.png",
            source_kind: "attachment",
            attachment_id: "01JATTACHMENT00000000000000",
          },
        },
      },
    ];
    const importingKernel = {
      ...kernel,
      core: { parseDocument: () => ({ fm: {} }) },
      ports: { bound: () => false, use: () => ({ upload: vi.fn() }) },
      documents: {
        ...kernel.documents,
        query: async ({ offset }: { readonly offset: number }) => ({
          rows: rows.slice(offset),
          total: rows.length,
        }),
        open: async () => ({
          text: { toString: () => noteText },
          release: vi.fn(),
        }),
        splice: {
          ...kernel.documents.splice,
          apply: (_open: unknown, edits: readonly { readonly range: { readonly start: number; readonly end: number }; readonly text: string }[]) => {
            for (const edit of [...edits].sort((left, right) => right.range.start - left.range.start)) {
              noteText = noteText.slice(0, edit.range.start) + edit.text + noteText.slice(edit.range.end);
            }
          },
        },
      },
      log: { error: vi.fn() },
    } as unknown as Kernel;
    const archive = {
      notes: [{ path: "Notes/Today.md", text: "![[photo]]\n" }],
      attachments: [
        {
          path: "Assets/photo.png",
          size: 3,
          bytes: async () => Uint8Array.of(1, 2, 3),
        },
      ],
      skippedFiles: 0,
    };

    const result = await importVault(importingKernel, "Retry Vault", archive, () => undefined);

    expect(result).toMatchObject({
      alreadyImported: 1,
      attachmentsAlreadyImported: 1,
      resolvedWikilinks: 1,
      unresolvedWikilinks: 0,
      failed: [],
    });
    expect(noteText).toBe("![photo.png](doc://01JWRAPPER0000000000000000)\n");
  });
});

describe("Obsidian folders", () => {
  it("files each new document under the note for its vault folder", async () => {
    const created: string[] = [];
    const ensurePath = vi.fn(async (titles: readonly string[]) => `folder:${titles.join("/")}`);
    const file = vi.fn(async () => undefined);
    const importingKernel = {
      ...kernel,
      core: { parseDocument: () => ({ fm: {} }) },
      ports: {
        bound: (port: string) => port === "folders",
        use: (port: string) => (port === "folders" ? { ensurePath, file } : { upload: vi.fn() }),
      },
      documents: {
        ...kernel.documents,
        query: async () => ({ rows: [], total: 0 }),
        create: async ({ id }: { readonly id: string }) => {
          created.push(id);
          return id;
        },
        open: async () => ({ text: { toString: () => "" }, release: vi.fn() }),
        splice: { ...kernel.documents.splice, apply: vi.fn() },
      },
      log: { error: vi.fn(), warn: vi.fn() },
    } as unknown as Kernel;
    const archive = {
      notes: [
        { path: "Notes/Daily/Today.md", text: "today\n" },
        { path: "Notes/Daily/Yesterday.md", text: "yesterday\n" },
        { path: "Loose.md", text: "loose\n" },
      ],
      attachments: [],
      skippedFiles: 0,
    };

    await importVault(importingKernel, "Vault", archive, () => undefined);

    // One folder chain per vault folder, however many notes are in it.
    expect(ensurePath).toHaveBeenCalledTimes(1);
    expect(ensurePath).toHaveBeenCalledWith(["Notes", "Daily"]);
    expect(file.mock.calls).toEqual([
      [created[0], "folder:Notes/Daily"],
      [created[1], "folder:Notes/Daily"],
    ]);
  });
});

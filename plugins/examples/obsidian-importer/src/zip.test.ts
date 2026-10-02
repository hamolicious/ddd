import { describe, expect, it } from "vitest";

import { crc32, readVaultArchive } from "./zip.js";

describe("Obsidian vault ZIP reader", () => {
  it("strips one archive root, exposes attachments lazily, and ignores metadata", async () => {
    const bytes = zip([
      ["My Vault/Index.md", "# Home\n\n[[Projects/One]]"],
      ["My Vault/Projects/One.md", "one"],
      ["My Vault/.obsidian/app.json", "{}"],
      ["My Vault/image.png", "not really a png"],
    ]);

    const archive = await readVaultArchive(bytes);
    expect(archive.notes).toEqual([
      { path: "Index.md", text: "# Home\n\n[[Projects/One]]" },
      { path: "Projects/One.md", text: "one" },
    ]);
    expect(archive.attachments.map(({ path, size }) => ({ path, size }))).toEqual([
      { path: "image.png", size: 16 },
    ]);
    await expect(archive.attachments[0]?.bytes()).resolves.toEqual(new TextEncoder().encode("not really a png"));
    expect(archive.skippedFiles).toBe(1);
  });

  it("rejects traversal paths", async () => {
    await expect(readVaultArchive(zip([["../escape.md", "no"]]))).rejects.toThrow("unsafe ZIP path");
  });

  it("does not mistake a lone top-level folder for a ZIP wrapper", async () => {
    await expect(readVaultArchive(zip([["Projects/One.md", "one"]]))).resolves.toEqual({
      notes: [{ path: "Projects/One.md", text: "one" }],
      attachments: [],
      skippedFiles: 0,
    });
  });

  it("reads deflated notes", async () => {
    const compressed = Uint8Array.from([0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x07, 0x00]);
    await expect(readVaultArchive(zip([["Note.md", "hello", compressed]]))).resolves.toEqual({
      notes: [{ path: "Note.md", text: "hello" }],
      attachments: [],
      skippedFiles: 0,
    });
  });

  it("rejects a corrupt note", async () => {
    const bytes = zip([["Note.md", "hello"]]);
    bytes[37] = bytes[37]! ^ 0xff;
    await expect(readVaultArchive(bytes)).rejects.toThrow(/checksum|size|UTF-8/);
  });

  it("checksums an attachment when its lazy bytes are requested", async () => {
    const bytes = zip([["photo.png", "image bytes"]]);
    bytes[39] = bytes[39]! ^ 0xff;
    const archive = await readVaultArchive(bytes);
    await expect(archive.attachments[0]?.bytes()).rejects.toThrow("checksum");
  });
});

function zip(files: readonly (readonly [string, string, Uint8Array?])[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let localOffset = 0;
  for (const [name, content, compressed] of files) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(content);
    const payload = compressed ?? data;
    const method = compressed === undefined ? 0 : 8;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length + payload.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, payload.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    localOffset += local.length;
  }

  const centralOffset = localOffset;
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  return concat([...locals, ...centrals, end]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

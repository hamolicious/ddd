/** A deliberately small ZIP reader for Obsidian vaults. No dependency is needed at runtime. */

const CENTRAL_FILE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const LOCAL_FILE = 0x04034b50;
const UTF8_NAME = 0x0800;
const ENCRYPTED = 0x0001;
const MAX_ENTRIES = 50_000;
const MAX_NOTE_BYTES = 8 * 1024 * 1024;
const MAX_COMPRESSED_NOTE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_NOTE_BYTES = 256 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_COMPRESSED_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;

export interface VaultNote {
  /** Vault-relative path, with `/` separators. */
  readonly path: string;
  readonly text: string;
}

export interface VaultAttachment {
  /** Vault-relative path, with `/` separators. */
  readonly path: string;
  readonly size: number;
  /** Inflate and checksum this entry only when it is ready to upload. */
  bytes(): Promise<Uint8Array>;
}

export interface VaultArchive {
  readonly notes: readonly VaultNote[];
  readonly attachments: readonly VaultAttachment[];
  /** Obsidian configuration, trash, and operating-system metadata. */
  readonly skippedFiles: number;
}

interface ZipEntry {
  readonly path: string;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

export async function readVaultArchive(bytes: Uint8Array, rootHint?: string): Promise<VaultArchive> {
  const entries = readDirectory(bytes);
  const candidates = entries.filter((entry) => isVaultNote(entry.path));
  const attachmentCandidates = entries.filter((entry) => isVaultAttachment(entry.path));
  const root = archiveRoot(entries, candidates.length > 0 ? candidates : attachmentCandidates, rootHint);
  const seen = new Set<string>();
  const notes: VaultNote[] = [];
  const attachments: VaultAttachment[] = [];
  let totalSize = 0;

  for (const entry of candidates) {
    const path = root === undefined ? entry.path : entry.path.slice(root.length + 1);
    if (path === "" || seen.has(path)) throw new Error(`duplicate vault path: ${path || entry.path}`);
    seen.add(path);
    if (entry.size > MAX_NOTE_BYTES) throw new Error(`${path} is larger than 8 MiB`);
    if (entry.compressedSize > MAX_COMPRESSED_NOTE_BYTES) throw new Error(`${path} is too large to decompress safely`);
    totalSize += entry.size;
    if (totalSize > MAX_TOTAL_NOTE_BYTES) throw new Error("vault Markdown is larger than 256 MiB");
    notes.push({ path, text: decodeMarkdown(await inflateEntry(bytes, entry, MAX_NOTE_BYTES)) });
  }

  let totalAttachmentSize = 0;
  for (const entry of attachmentCandidates) {
    const path = root === undefined ? entry.path : stripRoot(entry.path, root);
    if (path === undefined) continue;
    if (path === "" || seen.has(path)) throw new Error(`duplicate vault path: ${path || entry.path}`);
    seen.add(path);
    if (entry.size > MAX_ATTACHMENT_BYTES) throw new Error(`${path} is larger than 100 MiB`);
    if (entry.compressedSize > MAX_COMPRESSED_ATTACHMENT_BYTES) {
      throw new Error(`${path} is too large to decompress safely`);
    }
    totalAttachmentSize += entry.size;
    if (totalAttachmentSize > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error("vault attachments are larger than 2 GiB");
    }
    attachments.push({
      path,
      size: entry.size,
      bytes: () => inflateEntry(bytes, entry, MAX_ATTACHMENT_BYTES),
    });
  }

  notes.sort((left, right) => left.path.localeCompare(right.path));
  attachments.sort((left, right) => left.path.localeCompare(right.path));
  return {
    notes,
    attachments,
    skippedFiles: entries.length - notes.length - attachments.length,
  };
}

function readDirectory(bytes: Uint8Array): readonly ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEnd(view);
  const count = u16(view, eocd + 10);
  const directorySize = u32(view, eocd + 12);
  const directoryOffset = u32(view, eocd + 16);
  if (u16(view, eocd + 4) !== 0 || u16(view, eocd + 6) !== 0) {
    throw new Error("multi-disk ZIP files are not supported");
  }
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error("ZIP64 vaults are not supported");
  }
  if (count > MAX_ENTRIES) throw new Error(`vault contains more than ${String(MAX_ENTRIES)} files`);
  requireRange(view, directoryOffset, directorySize);
  if (directoryOffset + directorySize > eocd) throw new Error("invalid ZIP central directory");

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (u32(view, offset) !== CENTRAL_FILE) throw new Error("invalid ZIP central directory");
    const flags = u16(view, offset + 8);
    const method = u16(view, offset + 10);
    const crc = u32(view, offset + 16);
    const compressedSize = u32(view, offset + 20);
    const size = u32(view, offset + 24);
    const nameLength = u16(view, offset + 28);
    const extraLength = u16(view, offset + 30);
    const commentLength = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP64 vaults are not supported");
    }
    requireRange(view, offset + 46, nameLength + extraLength + commentLength);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const rawName = decodeName(nameBytes, (flags & UTF8_NAME) !== 0);
    const path = safePath(rawName);
    if (!path.endsWith("/")) {
      entries.push({ path, flags, method, crc, compressedSize, size, localOffset });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEnd(view: DataView): number {
  const first = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= first; offset -= 1) {
    if (u32(view, offset) === END_OF_CENTRAL_DIRECTORY) {
      const commentLength = u16(view, offset + 20);
      if (offset + 22 + commentLength === view.byteLength) return offset;
    }
  }
  throw new Error("not a ZIP file, or the ZIP is incomplete");
}

async function inflateEntry(archive: Uint8Array, entry: ZipEntry, maxBytes: number): Promise<Uint8Array> {
  if ((entry.flags & ENCRYPTED) !== 0) throw new Error(`${entry.path} is encrypted`);
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  if (u32(view, entry.localOffset) !== LOCAL_FILE) throw new Error(`invalid ZIP entry: ${entry.path}`);
  const nameLength = u16(view, entry.localOffset + 26);
  const extraLength = u16(view, entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  requireRange(view, start, entry.compressedSize);
  const compressed = archive.slice(start, start + entry.compressedSize);
  let result: Uint8Array;
  if (entry.method === 0) {
    result = compressed;
  } else if (entry.method === 8) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("this browser cannot decompress ZIP files");
    }
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    result = await readLimited(stream, entry.path, entry.size, maxBytes);
  } else {
    throw new Error(`${entry.path} uses unsupported ZIP compression method ${String(entry.method)}`);
  }
  if (result.byteLength !== entry.size) throw new Error(`${entry.path} has an invalid uncompressed size`);
  if (crc32(result) !== entry.crc) throw new Error(`${entry.path} failed its ZIP checksum`);
  return result;
}

function isVaultNote(path: string): boolean {
  if (!path.toLocaleLowerCase().endsWith(".md")) return false;
  return !isIgnored(path);
}

function isVaultAttachment(path: string): boolean {
  return !path.toLocaleLowerCase().endsWith(".md") && !isIgnored(path);
}

function isIgnored(path: string): boolean {
  const parts = path.split("/");
  const basename = parts.at(-1)?.toLocaleLowerCase();
  return (
    parts.some((part) => part === ".obsidian" || part === ".trash" || part === ".git" || part === "__MACOSX") ||
    basename === ".ds_store" ||
    basename === "thumbs.db"
  );
}

function stripRoot(path: string, root: string): string | undefined {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
}

function archiveRoot(
  entries: readonly ZipEntry[],
  notes: readonly ZipEntry[],
  rootHint: string | undefined,
): string | undefined {
  const paths = notes.map((entry) => entry.path);
  if (paths.length === 0) return undefined;
  const first = paths[0]?.split("/")[0];
  if (!first) return undefined;
  if (!paths.every((path) => path.includes("/") && path.split("/")[0] === first)) return undefined;
  const hinted = rootHint !== undefined && first.localeCompare(rootHint, undefined, { sensitivity: "base" }) === 0;
  const hasObsidianDirectory = entries.some((entry) => entry.path.startsWith(`${first}/.obsidian/`));
  return hinted || hasObsidianDirectory ? first : undefined;
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  path: string,
  expectedSize: number,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expectedSize || total > maxBytes) {
        await reader.cancel();
        throw new Error(`${path} expands beyond its declared size`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function safePath(raw: string): string {
  const path = raw.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) throw new Error(`unsafe ZIP path: ${raw}`);
  const parts = path.split("/");
  if (parts.some((part) => part === ".." || part === "" && !path.endsWith("/"))) {
    throw new Error(`unsafe ZIP path: ${raw}`);
  }
  return parts.filter((part) => part !== ".").join("/");
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  // Obsidian emits UTF-8 names. ASCII is the portable subset for archives without bit 11.
  if (!utf8 && bytes.some((byte) => byte > 0x7f)) {
    throw new Error("ZIP contains a non-UTF-8 filename");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("ZIP contains an invalid UTF-8 filename");
  }
}

function decodeMarkdown(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("a Markdown note is not valid UTF-8");
  }
}

function requireRange(view: DataView, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > view.byteLength) throw new Error("truncated ZIP file");
}

function u16(view: DataView, offset: number): number {
  requireRange(view, offset, 2);
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  requireRange(view, offset, 4);
  return view.getUint32(offset, true);
}

/** ZIP's CRC-32 (ISO-HDLC), kept exported so fixtures can be made without a ZIP dependency. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

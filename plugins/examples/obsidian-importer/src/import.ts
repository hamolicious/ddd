import type { CoreMap, Kernel, TextEdit } from "@kernel";
import type { Attachments } from "@protocols/lm/attachments";

import {
  aliasesOf,
  rewriteFrontmatterWikilinks,
  rewriteWikilinks,
  type LinkTarget,
} from "./links.js";
import {
  checkpointKey,
  readCheckpoint,
  removeCheckpoint,
  writeCheckpoint,
  type AttachmentCheckpoint,
  type UploadedAttachment,
} from "./checkpoint.js";
import type { VaultArchive, VaultAttachment, VaultNote } from "./zip.js";

export interface ImportResult {
  readonly imported: number;
  readonly alreadyImported: number;
  readonly attachmentsImported: number;
  readonly attachmentsAlreadyImported: number;
  readonly failed: readonly string[];
  readonly resolvedWikilinks: number;
  readonly unresolvedWikilinks: number;
}

interface ImportedDocument {
  readonly id: string;
  readonly deleted: boolean;
  readonly attachmentId?: string;
}

/** What this plugin reads through its `attachments` port: the manifest's `needs`. */
type AttachmentsApi = Pick<Attachments, "upload">;

export async function importVault(
  kernel: Kernel,
  archiveName: string,
  archive: VaultArchive,
  onProgress: (finished: number, total: number) => void,
): Promise<ImportResult> {
  const existing = await importedDocuments(kernel, archiveName);
  const documents = new Map(existing);
  const failed: string[] = [];
  let imported = 0;
  let alreadyImported = 0;
  let attachmentsImported = 0;
  let attachmentsAlreadyImported = 0;
  let finished = 0;
  let resolvedWikilinks = 0;
  let unresolvedWikilinks = 0;
  const totalWork = archive.notes.length * 2 + archive.attachments.length;

  for (const note of archive.notes) {
    if (existing.has(note.path)) {
      alreadyImported += 1;
    } else {
      try {
        const id = mintUlid();
        await kernel.documents.create({ id, text: prepareDocument(kernel, archiveName, note) });
        documents.set(note.path, { id, deleted: false });
        imported += 1;
      } catch (cause) {
        kernel.log.error(`could not import ${note.path}`, cause);
        failed.push(note.path);
      }
    }
    finished += 1;
    onProgress(finished, totalWork);
  }

  // The `lm/attachments` service the wiring bound to this plugin's `attachments` port.
  const attachmentService = kernel.ports.use<AttachmentsApi>("attachments");
  for (const attachment of archive.attachments) {
    const prior = existing.get(attachment.path);
    if (prior?.attachmentId) {
      documents.set(attachment.path, prior);
      attachmentsAlreadyImported += 1;
      await removeCheckpoint(archiveName, attachment.path).catch(() => undefined);
    } else {
      try {
        const uploaded = await importAttachment(kernel, attachmentService, archiveName, attachment);
        documents.set(attachment.path, uploaded);
        attachmentsImported += 1;
      } catch (cause) {
        kernel.log.error(`could not import attachment ${attachment.path}`, cause);
        failed.push(attachment.path);
      }
    }
    finished += 1;
    onProgress(finished, totalWork);
  }

  const targets = linkTargets(kernel, archive, documents);
  for (const note of archive.notes) {
    const document = documents.get(note.path);
    if (document && !document.deleted) {
      try {
        const open = await kernel.documents.open(document.id);
        try {
          const current = open.text.toString();
          const body = rewriteWikilinks(current, note.path, targets);
          const frontmatter = rewriteFrontmatterWikilinks(
            kernel.core.parseDocument(current).fm,
            note.path,
            targets,
          );
          resolvedWikilinks += body.resolved + frontmatter.resolved;
          unresolvedWikilinks += body.unresolved + frontmatter.unresolved;
          const frontmatterEdits = [...frontmatter.values].flatMap(([key, value]) =>
            kernel.documents.splice.planFrontmatterValue(current, key, value),
          );
          const edits = [...body.edits, ...frontmatterEdits];
          if (edits.length > 0) {
            kernel.documents.splice.apply(open, edits, "obsidian-importer:wikilinks");
          }
        } finally {
          open.release();
        }
      } catch (cause) {
        kernel.log.error(`could not resolve wikilinks in ${note.path}`, cause);
        if (!failed.includes(note.path)) failed.push(note.path);
      }
    }
    finished += 1;
    onProgress(finished, totalWork);
  }

  return {
    imported,
    alreadyImported,
    attachmentsImported,
    attachmentsAlreadyImported,
    failed,
    resolvedWikilinks,
    unresolvedWikilinks,
  };
}

export function prepareDocument(kernel: Kernel, archiveName: string, note: VaultNote): string {
  const slash = note.path.lastIndexOf("/");
  const directory = slash < 0 ? "" : note.path.slice(0, slash);
  const filename = slash < 0 ? note.path : note.path.slice(slash + 1);
  const title = filename.replace(/\.md$/i, "");
  let text = note.text;
  const parsed = kernel.core.parseDocument(text);

  if (typeof parsed.fm["title"] !== "string") {
    text = applyEdits(text, kernel.documents.splice.planFrontmatterValue(text, "title", title));
  }
  if (directory !== "") {
    text = applyEdits(text, kernel.documents.splice.planFrontmatterValue(text, "path", directory));
  }
  text = applyEdits(
    text,
    kernel.documents.splice.planSection(text, [
      { key: "archive", value: archiveName },
      { key: "source_path", value: note.path },
      { key: "source_kind", value: "note" },
    ]),
  );
  return text;
}

async function importAttachment(
  kernel: Kernel,
  service: AttachmentsApi,
  archiveName: string,
  attachment: VaultAttachment,
): Promise<ImportedDocument> {
  const saved = await readCheckpoint(archiveName, attachment.path);
  let uploaded = saved?.attachment;
  if (!uploaded) {
    const bytes = await attachment.bytes();
    const payload = new Uint8Array(bytes.byteLength);
    payload.set(bytes);
    let uploadId = saved?.uploadId;
    const response = await service.upload(new Blob([payload.buffer]), basename(attachment.path), {
      uploadId,
      onSession: async (id) => {
        uploadId = id;
        await writeCheckpoint(checkpoint(archiveName, attachment.path, id));
      },
    });
    uploaded = response.attachment;
    await writeCheckpoint(checkpoint(archiveName, attachment.path, uploadId, uploaded));
  }

  const id = mintUlid();
  await kernel.documents.create({
    id,
    text: prepareAttachmentDocument(kernel, archiveName, attachment.path, uploaded),
  });
  await removeCheckpoint(archiveName, attachment.path);
  return { id, deleted: false, attachmentId: uploaded.id };
}

function checkpoint(
  archive: string,
  path: string,
  uploadId?: string,
  attachment?: UploadedAttachment,
): AttachmentCheckpoint {
  return { key: checkpointKey(archive, path), archive, path, uploadId, attachment };
}

export function prepareAttachmentDocument(
  kernel: Kernel,
  archiveName: string,
  path: string,
  attachment: UploadedAttachment,
): string {
  const directory = dirname(path);
  const filename = attachment.name || basename(path);
  const label = filename
    .replace(/[\r\n]/g, "")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
  const preview = attachment.mime.startsWith("image/") ? "!" : "";
  let text = `${preview}[${label}](attachment://${attachment.id})\n`;
  text = applyEdits(text, kernel.documents.splice.planFrontmatterValue(text, "title", filename));
  if (directory !== "") {
    text = applyEdits(text, kernel.documents.splice.planFrontmatterValue(text, "path", directory));
  }
  text = applyEdits(text, kernel.documents.splice.planFrontmatterValue(text, "attachment", attachment.id));
  text = applyEdits(
    text,
    kernel.documents.splice.planSection(text, [
      { key: "archive", value: archiveName },
      { key: "source_path", value: path },
      { key: "source_kind", value: "attachment" },
      { key: "attachment_id", value: attachment.id },
    ]),
  );
  return text;
}

function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let result = text;
  for (const edit of [...edits].sort((left, right) => right.range.start - left.range.start)) {
    result = result.slice(0, edit.range.start) + edit.text + result.slice(edit.range.end);
  }
  return result;
}

async function importedDocuments(
  kernel: Kernel,
  archiveName: string,
): Promise<ReadonlyMap<string, ImportedDocument>> {
  const documents = new Map<string, ImportedDocument>();
  let offset = 0;
  for (;;) {
    const result = await kernel.documents.query({ limit: 1_000, offset, includeDeleted: true });
    for (const row of result.rows) {
      const section = row.plugins[kernel.pluginId];
      if (!isMap(section) || section["archive"] !== archiveName) continue;
      const path = section["source_path"];
      const attachmentId = section["attachment_id"];
      if (typeof path === "string") {
        documents.set(path, {
          id: row.id,
          deleted: row.deleted,
          attachmentId: typeof attachmentId === "string" ? attachmentId : undefined,
        });
      }
    }
    offset += result.rows.length;
    if (result.rows.length === 0 || offset >= result.total) break;
  }
  return documents;
}

function isMap(value: unknown): value is CoreMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function linkTargets(
  kernel: Kernel,
  archive: VaultArchive,
  documents: ReadonlyMap<string, ImportedDocument>,
): readonly LinkTarget[] {
  const targets: LinkTarget[] = [];
  for (const note of archive.notes) {
    const document = documents.get(note.path);
    if (!document) continue;
    const parsed = kernel.core.parseDocument(note.text);
    const filename = note.path.slice(note.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    targets.push({
      kind: "document",
      id: document.id,
      path: note.path,
      title: typeof parsed.fm["title"] === "string" ? parsed.fm["title"] : filename,
      aliases: aliasesOf(parsed.fm["aliases"] ?? parsed.fm["alias"]),
    });
  }
  for (const attachment of archive.attachments) {
    const document = documents.get(attachment.path);
    if (!document?.attachmentId) continue;
    targets.push({
      kind: "attachment",
      id: document.id,
      attachmentId: document.attachmentId,
      path: attachment.path,
      title: basename(attachment.path),
      aliases: [],
    });
  }
  return targets;
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function mintUlid(now: number = Date.now()): string {
  let time = "";
  let milliseconds = Math.floor(now);
  for (let index = 0; index < 10; index += 1) {
    time = ULID_ALPHABET[milliseconds % 32] + time;
    milliseconds = Math.floor(milliseconds / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let random = "";
  for (const byte of bytes) random += ULID_ALPHABET[byte % 32];
  return time + random;
}

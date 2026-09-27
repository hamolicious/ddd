/**
 * `attachments` — files pasted into the editor become attachments (SPEC §3.6), and
 * every embedded file is shown by a viewer for its type.
 *
 * **Viewers.** `attachments.viewer` is a registry of viewers by file extension; this
 * plugin draws none itself (`native-preview` is the base distribution's). It contributes
 * the `markdown.attachment` renderer that picks one (`view.tsx`), so an
 * `![name](attachment://…)` in Read mode and a wrapper document's full page both go
 * through it. When several viewers claim a type, Settings → Attachments picks.
 *
 * **`/attach`** (a `slash.command`) opens the device's file picker and uploads what is
 * chosen into the spot where it was typed, the same way a paste does.
 *
 * It depends on no plugin: every point it uses is contributed to, and a contribution
 * waits for its point. So turning `editor` off costs pasting, not the viewers, and
 * turning this plugin off leaves `markdown` drawing files the way it did before.
 *
 * A handler on the editor's `editor.paste` point (pastes and drops alike): when the
 * clipboard or the drag holds files, each one is uploaded to `POST /api/attachments` and an "Uploading…" placeholder holds
 * its place in the text until the upload answers. Then the placeholder becomes either a
 * **preview** (`![name](attachment://…)`) or a **link** (`[name](attachment://…)`),
 * chosen per file extension in Settings → Attachments (`kinds.ts`).
 *
 * Pasting into a document only embeds the file; it creates no wrapper document (SPEC
 * §3.6: doc lists don't drown in screenshots). `markdown`'s "promote to document" makes
 * one later.
 *
 * The placeholder is followed through the document by the editor, not by position, so
 * typing elsewhere, a remote edit, or leaving Edit mode during the upload does not put
 * the result in the wrong place. If the user edits or deletes the placeholder before the
 * upload finishes, it is left alone and a notice says the file was uploaded but not put
 * in (the orphan view in Admin → Storage will find it).
 *
 * **Offline** (`docs/SYNC-DECISIONS.md` §8), a file is kept on the device (`queue.ts`)
 * and its placeholder stays, saying it waits for a connection; on reconnect it uploads
 * and the placeholder is swapped for the file, in whatever document it is in.
 */

import type { Kernel, SettingsValue } from "@kernel";

import {
  POINTS,
  attachmentViewerShape,
  type AttachmentViewer,
  type EditorInsertion,
  type EditorPaste,
  type MarkdownAttachment,
  type SettingsSection,
  type SlashCommand,
} from "../../_shared/points.js";
import { extensionOf, pasteAs, placeholder, reference, schema, settingKey, type PasteAs } from "./kinds.js";
import { QUEUE_LIMIT_BYTES, newToken, waiting, waitingPlaceholder, type WaitingUpload } from "./queue.js";
import { FileTypeSettings } from "./FileTypeSettings.js";
import { createAttachmentView, createViewers } from "./view.js";

interface UploadResponse {
  readonly attachment: { readonly id: string; readonly name: string };
}

export default function activate(kernel: Kernel): void {
  try {
    kernel.settings.defineSchema(schema());
  } catch (error) {
    kernel.log.warn("paste settings could not be declared; every file will be linked", error);
  }

  const read = (key: string): SettingsValue | undefined => {
    try {
      return kernel.settings.get(key);
    } catch {
      return undefined;
    }
  };

  const viewerPoint = kernel.extensions.definePoint<AttachmentViewer>({
    name: POINTS.attachmentViewer,
    shape: attachmentViewerShape,
    key: (viewer) => viewer.id,
    description: "A viewer for files of some extensions; the lowest order, or the user's pick, shows them.",
  });
  const viewers = createViewers(kernel, viewerPoint, read);

  kernel.extensions.contribute<MarkdownAttachment>(POINTS.markdownAttachment, {
    id: "attachments",
    component: createAttachmentView(kernel, viewers),
  });

  /**
   * A file type nobody has a setting for gets one, set to what it is being pasted as, so
   * it appears in Settings → Attachments. Best effort: offline, the write can fail, and
   * the paste must not.
   */
  const remember = (extension: string): void => {
    const key = settingKey(extension);
    if (read(key) !== undefined) return;
    kernel.settings.set(key, "link").catch((error: unknown) => {
      kernel.log.debug(`could not remember .${extension} in the paste settings`, error);
    });
  };

  const upload = async (file: Blob, name: string): Promise<UploadResponse> => {
    const body = new FormData();
    // No Content-Type: the browser adds the multipart boundary.
    body.append("file", file, name || "pasted");
    const response = await kernel.session.fetch("/attachments", { method: "POST", body });
    return (await response.json()) as UploadResponse;
  };

  const place = (file: File, slot: EditorInsertion, documentId: string): void => {
    const extension = extensionOf(file.name, file.type);
    if (extension) remember(extension);
    const as = extension ? pasteAs(read(settingKey(extension))) : "link";

    upload(file, file.name)
      .then(({ attachment }) => {
        const text = reference(attachment.name || file.name, attachment.id, as);
        if (slot.replace(text)) return;
        kernel.ui.notify({
          id: `attachments.orphan.${attachment.id}`,
          level: "warning",
          message: `${file.name} was uploaded, but its placeholder was changed, so it was not put in the document.`,
          detail: text,
        });
      })
      .catch(async (error: unknown) => {
        if (unreached(error) && (await keepForLater(file, slot, documentId, as))) return;
        slot.remove();
        kernel.ui.notify({
          id: `attachments.failed.${file.name}`,
          level: "error",
          message: `${file.name || "The pasted file"} could not be uploaded.`,
          detail: describe(error),
        });
      });
  };

  /** Offline: keep the file on the device, and say in the placeholder that it waits. */
  const keepForLater = async (file: File, slot: EditorInsertion, documentId: string, as: PasteAs): Promise<boolean> => {
    try {
      if ((await waiting.bytes()) + file.size > QUEUE_LIMIT_BYTES) return false;
      const token = newToken();
      const name = file.name || "pasted file";
      const entry: WaitingUpload = {
        token,
        documentId,
        placeholder: waitingPlaceholder(name, token),
        name,
        type: file.type,
        as,
        blob: file,
        at: Date.now(),
      };
      await waiting.add(entry);
      if (!slot.replace(entry.placeholder)) {
        // The placeholder was edited or deleted meanwhile: the person no longer wants it.
        await waiting.remove(token);
        return true;
      }
      void announceWaiting();
      return true;
    } catch {
      return false;
    }
  };

  const announceWaiting = async (): Promise<void> => {
    const count = (await waiting.all().catch(() => [])).length;
    if (count === 0) {
      dismissWaiting?.();
      dismissWaiting = undefined;
      return;
    }
    dismissWaiting = kernel.ui.notify({
      id: WAITING_NOTICE,
      level: "info",
      message:
        count === 1
          ? "1 file is kept on this device and uploads when you are back online."
          : `${count} files are kept on this device and upload when you are back online.`,
    });
  };
  let dismissWaiting: (() => void) | undefined;

  /** Put `text` where a waiting file's placeholder is, in whichever document holds it. */
  const replacePlaceholder = async (entry: WaitingUpload, text: string): Promise<boolean> => {
    const doc = await kernel.documents.open(entry.documentId);
    try {
      const at = doc.text.toString().indexOf(entry.placeholder);
      if (at < 0) return false;
      kernel.documents.splice.apply(doc, [{ range: { start: at, end: at + entry.placeholder.length }, text }], "attachments");
      return true;
    } finally {
      doc.release();
    }
  };

  /** Upload what waited, oldest first; stop at the first one the server does not answer. */
  let draining = false;
  const sendWaiting = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      const entries = (await waiting.all()).sort((a, b) => a.at - b.at);
      for (const entry of entries) {
        let text: string;
        try {
          const { attachment } = await upload(entry.blob, entry.name);
          text = reference(attachment.name || entry.name, attachment.id, entry.as);
        } catch (error) {
          if (unreached(error)) break;
          await replacePlaceholder(entry, "").catch(() => false);
          await waiting.remove(entry.token);
          kernel.ui.notify({
            id: `attachments.failed.${entry.token}`,
            level: "error",
            message: `${entry.name} could not be uploaded.`,
            detail: describe(error),
          });
          continue;
        }
        const placed = await replacePlaceholder(entry, text).catch(() => false);
        await waiting.remove(entry.token);
        if (!placed) {
          kernel.ui.notify({
            id: `attachments.orphan.${entry.token}`,
            level: "warning",
            message: `${entry.name} was uploaded, but its placeholder was changed, so it was not put in the document.`,
            detail: text,
          });
        }
      }
    } catch (error) {
      kernel.log.warn("files kept offline could not be uploaded yet", error);
    } finally {
      draining = false;
      void announceWaiting();
    }
  };

  kernel.sync.subscribe((state) => {
    if (state.status === "synced") void sendWaiting();
  });

  /** Upload each file into consecutive slots from `insert`, one per line. */
  const placeAll = (files: readonly File[], documentId: string, insert: (text: string) => EditorInsertion): void => {
    files.forEach((file, index) => {
      if (index > 0) insert("\n");
      place(file, insert(placeholder(file.name || "pasted file")), documentId);
    });
  };

  kernel.extensions.contribute<EditorPaste>(POINTS.editorPaste, {
    id: "attachments.upload",
    paste: (event) => {
      if (event.files.length === 0) return false;
      placeAll(event.files, event.documentId, (text) => event.insert(text));
      return true;
    },
  });

  kernel.extensions.contribute<SlashCommand>(POINTS.slashCommand, {
    id: "attachments.attach",
    title: "Attach file",
    description: "Upload files from this device",
    keywords: ["file", "upload", "image", "photo"],
    icon: "📎",
    order: 10,
    // The native picker, opened inside the key press or tap that chose the command (a
    // browser only opens one from a user gesture). The files go where `/attach` was typed,
    // however long the picker stays open. In the DOM rather than detached, which some
    // mobile browsers need before `click()` opens anything.
    run: ({ documentId, mark, focus }) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.hidden = true;
      const done = (): void => {
        input.remove();
        focus();
      };
      input.addEventListener("change", () => {
        placeAll(Array.from(input.files ?? []), documentId, (text) => mark.insert(text));
        done();
      });
      input.addEventListener("cancel", done);
      document.body.append(input);
      input.click();
    },
  });

  kernel.extensions.contribute<SettingsSection>(POINTS.settingsSection, {
    id: "attachments",
    title: "Attachments",
    order: 40,
    description: "How each file type is pasted, and which viewer shows it.",
    component: () => <FileTypeSettings kernel={kernel} viewers={viewers} />,
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

const WAITING_NOTICE = "attachments.waiting";

/** The server never answered: offline, or down. Worth keeping the file and trying later. */
function unreached(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 0 || status === 401 || (status !== undefined && status >= 500);
}

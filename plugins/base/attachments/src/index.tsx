/**
 * `attachments` — files pasted into the editor become attachments (SPEC §3.6), and
 * every embedded file is shown by a viewer for its type.
 *
 * **Viewers.** The `viewers` port hosts `lm/attachments.viewer`: viewers by file extension,
 * in the wiring's seat order; this plugin draws none itself (`native-preview` is the base
 * distribution's). It offers the `markdown.attachment` renderer that picks one
 * (`view.tsx`), so an `![name](attachment://…)` in Read mode and a wrapper document's
 * full page both go through it. When several viewers claim a type, the first seat shows
 * it unless Settings → Attachments picks another.
 *
 * **`/attach`** (a `slash.command`) opens the device's file picker and uploads what is
 * chosen into the spot where it was typed, the same way a paste does.
 *
 * It consumes no service: everything it offers goes to whichever host is wired to it, and
 * a port with no host is simply unheard. So turning `editor` off costs pasting, not the
 * viewers, and turning this plugin off leaves `markdown` drawing files the way it did
 * before. The uploader itself is served on the `uploads` port (`lm/attachments`).
 *
 * A handler offered on `editor.paste` (pastes and drops alike): when the
 * clipboard or the drag holds files, each one is uploaded in chunks (`uploads.ts`) and a
 * placeholder holds its place in the text until the upload is done — an embed of the file
 * as it is on this device, so Read mode already shows it (`queue.ts`). Each upload has a
 * notice with a progress bar, where it is going, the time left, and Pause, Cancel and
 * Open. Then the placeholder becomes either a
 * **preview** (`![name](attachment://…)`) or a **link** (`[name](attachment://…)`),
 * chosen per file extension in Settings → Attachments (`kinds.ts`).
 *
 * Pasting into a document only embeds the file; it creates no wrapper document (SPEC
 * §3.6: doc lists don't drown in screenshots). `markdown`'s "promote to document" makes
 * one later.
 *
 * The placeholder is followed through the document by the editor, not by position, so
 * typing elsewhere, a remote edit, or leaving Edit mode during the upload does not put
 * the result in the wrong place; when that handle has lost it (Android's keyboard
 * rewriting the line), its unique text is searched for instead. If the user edits or
 * deletes the placeholder before the upload finishes, it is left alone and a notice says
 * the file was uploaded but not put in (the orphan view in Admin → Storage will find it).
 *
 * **Interrupted** — offline (`dev-docs/resolved/SYNC-DECISIONS.md` §8), paused, or the
 * page reloaded — a file is kept on the device (`queue.ts`) and its placeholder stays; the
 * upload carries on from the last chunk the server has, and the placeholder is swapped
 * for the file in whatever document it is in.
 */

import type { Kernel, SettingsValue } from "@kernel";

import type { Attachments } from "@protocols/lm/attachments";
import type { Folders } from "@protocols/lm/folders";
import type { AttachmentViewer } from "@protocols/lm/attachments.viewer";
import type { EditorInsertion, EditorPaste } from "@protocols/lm/editor.paste";
import type { MarkdownAttachment } from "@protocols/lm/markdown.attachment";
import type { SettingsSection } from "@protocols/lm/settings.section";
import type { SlashCommand } from "@protocols/lm/slash.command";

import { extensionOf, pasteAs, schema, settingKey } from "./kinds.js";
import { newToken, waitingPlaceholder, type WaitingUpload } from "./queue.js";
import { createUploads, type Uploads } from "./uploads.js";
import { createAttachmentsApi } from "./uploader.js";
import { FileTypeSettings } from "./FileTypeSettings.js";
import { createAttachmentView, createViewers } from "./view.js";

/** The uploads of the running activation, for `deactivate` to stop. */
let liveUploads: Uploads | undefined;

export default function activate(kernel: Kernel): Attachments {
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

  // The `viewers` host: every viewer wired in, in seat order. The shape and the duplicate
  // `id` rule come from the `lm/attachments.viewer` protocol package.
  const viewers = createViewers(kernel, kernel.ports.collect<AttachmentViewer>("viewers"), read);

  kernel.ports.offer<MarkdownAttachment>("embed", {
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

  const uploads = createUploads(kernel);
  liveUploads = uploads;
  // Files kept on this device by an earlier visit carry on where they stopped.
  void uploads.restore();
  kernel.sync.subscribe((state) => {
    if (state.status === "synced") uploads.reconnected();
  });

  /** Upload each file into consecutive slots from `insert`, one per line. */
  const placeAll = (files: readonly File[], documentId: string, insert: (text: string) => EditorInsertion): void => {
    files.forEach((file, index) => {
      if (index > 0) insert("\n");
      const extension = extensionOf(file.name, file.type);
      const name = file.name || "pasted file";
      const token = newToken();
      const entry: WaitingUpload = {
        token,
        documentId,
        placeholder: waitingPlaceholder(name, token),
        name,
        type: file.type,
        as: extension ? pasteAs(read(settingKey(extension))) : "link",
        blob: file,
        at: Date.now(),
      };
      // After `as` is read: remembering writes the setting this paste would read.
      if (extension) remember(extension);
      void uploads.add(entry, insert(entry.placeholder));
    });
  };

  kernel.ports.offer<EditorPaste>("paste", {
    id: "attachments.upload",
    paste: (event) => {
      if (event.files.length === 0) return false;
      placeAll(event.files, event.documentId, (text) => event.insert(text));
      return true;
    },
  });

  kernel.ports.offer<SlashCommand>("attach", {
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

  kernel.ports.offer<SettingsSection>("settings", {
    id: "attachments",
    title: "Attachments",
    order: 40,
    description: "How each file type is pasted, and which viewer shows it.",
    component: () => <FileTypeSettings kernel={kernel} viewers={viewers} />,
  });

  // The `lm/attachments` service, on the `uploads` port; returned too, for the loader.
  // A wrapper document the server made is filed where "Files go to" says — through
  // `folders`, which owns that setting, when it is wired.
  const sender = createAttachmentsApi(kernel.session.fetch.bind(kernel.session));
  const api: Attachments = {
    upload: async (blob, name, options) => {
      const response = await sender.upload(blob, name, options);
      if (response.document_id !== undefined && kernel.ports.bound("folders")) {
        await kernel.ports
          .use<Pick<Folders, "fileNew">>("folders")
          .fileNew(response.document_id, "file")
          .catch((cause: unknown) => kernel.log.warn("could not file the new file document", cause));
      }
      return response;
    },
  };
  kernel.ports.serve<Attachments>("uploads", api);
  return api;
}

/**
 * What the kernel does not withdraw: the upload timers and the transfers in flight. A file
 * that was kept on this device carries on from its last chunk when the plugin next starts.
 */
export function deactivate(): void {
  liveUploads?.dispose();
  liveUploads = undefined;
}

/**
 * Per file type, two settings.
 *
 * `paste-<ext>`: what a pasted file turns into, a **preview** (`![name](…)`, shown by a
 * viewer) or a **link** (`[name](…)`, a chip). The common ones are declared up front
 * with a default; an extension nobody declared gets its own setting the first time a
 * file of that type is pasted, set to `link`, so it shows up in Settings → Attachments.
 *
 * `view-<ext>`: which viewer shows it, by viewer id, when more than one claims the type.
 * Unset means the lowest `order`; an id that is no longer installed means the same.
 */

import type { SettingsSchema, SettingsValue } from "@kernel";

export type PasteAs = "preview" | "link";

export const PASTE_AS: readonly PasteAs[] = ["preview", "link"];

/** Settings keys are `^[A-Za-z0-9_-]{1,64}$`; the prefix leaves room for the extension. */
const KEY_PREFIX = "paste-";
const VIEW_PREFIX = "view-";

/**
 * Previewed by default: raster images, which sit in a paragraph naturally. A PDF or a
 * video can be previewed too, but takes a screenful of the document, so it starts as a
 * link. SVG is never shown inline (SPEC §3.6), so a preview of one would be a chip.
 */
const PREVIEWED = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"];
/** Linked by default, and listed so they can be changed before the first paste. */
const LINKED = ["pdf", "svg", "txt", "md", "csv", "zip", "mp4", "mp3", "docx", "xlsx"];

export function settingKey(extension: string): string {
  return `${KEY_PREFIX}${extension}`;
}

export function viewKey(extension: string): string {
  return `${VIEW_PREFIX}${extension}`;
}

export function extensionOfKey(key: string): string | undefined {
  return key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : undefined;
}

/**
 * The file's extension, lower case: `Scan.PDF` → `pdf`. A clipboard screenshot usually
 * arrives as `image.png`, but a name without one falls back to the MIME subtype
 * (`image/png` → `png`). `undefined` when neither gives a usable one.
 */
export function extensionOf(name: string, mime: string): string | undefined {
  const dot = name.lastIndexOf(".");
  const fromName = dot > 0 ? name.slice(dot + 1) : "";
  const fromMime = /^[a-z]+\/([a-z0-9]+)$/i.exec(mime)?.[1] ?? "";
  const candidate = (fromName || fromMime).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(candidate) ? candidate : undefined;
}

export function schema(): SettingsSchema {
  const fields: Record<string, SettingsSchema[string]> = {};
  for (const extension of [...PREVIEWED, ...LINKED]) {
    fields[settingKey(extension)] = {
      type: "enum",
      options: PASTE_AS,
      default: PREVIEWED.includes(extension) ? "preview" : "link",
      label: `Pasted .${extension} files`,
      description: "Preview shows the file in the document; link shows its name.",
    };
  }
  return fields;
}

/** Read a stored value; anything unexpected is a link, the choice that never misleads. */
export function pasteAs(value: SettingsValue | undefined): PasteAs {
  return value === "preview" ? "preview" : "link";
}

/** Every extension with a setting, declared or stored, sorted. */
export function knownExtensions(values: Readonly<Record<string, SettingsValue>>): readonly string[] {
  return Object.keys(values)
    .map(extensionOfKey)
    .filter((extension): extension is string => extension !== undefined && extension !== "")
    .sort();
}

/** The markdown for an uploaded file. Brackets and line breaks would end the label early. */
export function reference(name: string, id: string, as: PasteAs): string {
  const label = name.replace(/[[\]\r\n]/g, "");
  return `${as === "preview" ? "!" : ""}[${label}](attachment://${id})`;
}


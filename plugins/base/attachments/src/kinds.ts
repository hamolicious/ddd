import type { SettingsSchema, SettingsValue } from "@kernel";

export type PasteAs = "preview" | "link";

export const PASTE_AS: readonly PasteAs[] = ["preview", "link"];

const KEY_PREFIX = "paste-";
const VIEW_PREFIX = "view-";

const PREVIEWED = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"];
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

export function pasteAs(value: SettingsValue | undefined): PasteAs {
  return value === "preview" ? "preview" : "link";
}

export function knownExtensions(values: Readonly<Record<string, SettingsValue>>): readonly string[] {
  return Object.keys(values)
    .map(extensionOfKey)
    .filter((extension): extension is string => extension !== undefined && extension !== "")
    .sort();
}

export function reference(name: string, id: string, as: PasteAs): string {
  const label = name.replace(/[[\]\r\n]/g, "");
  return `${as === "preview" ? "!" : ""}[${label}](attachment://${id})`;
}


const ID = "[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4,64}";

const LONE_EMBED = new RegExp(
  `^(!?)\\[([^\\]]*)\\]\\(\\s*attachment://(${ID})\\s*(?:"[^"]*"|'[^']*')?\\s*\\)$`,
);

const LONE_URL = new RegExp(`^<?\\s*attachment://(${ID})\\s*>?$`);

export interface AttachmentReference {
  readonly id: string;
  readonly label?: string;
  readonly embedded: boolean;
}

export function wrapperAttachmentOf(body: string): AttachmentReference | undefined {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const candidates = lines.length > 1 && /^#{1,6}\s/.test(lines[0] ?? "") ? lines.slice(1) : lines;
  if (candidates.length !== 1) return undefined;

  const only = candidates[0] ?? "";
  const link = LONE_EMBED.exec(only);
  if (link) {
    const [, bang, label, id] = link;
    return { id: id ?? "", label: label && label.length > 0 ? label : undefined, embedded: bang === "!" };
  }
  const bare = LONE_URL.exec(only);
  if (bare) return { id: bare[1] ?? "", embedded: false };
  return undefined;
}

export function attachmentIdsIn(body: string): readonly string[] {
  const found = new Set<string>();
  const pattern = new RegExp(`attachment://(${ID})`, "g");
  for (const match of body.matchAll(pattern)) {
    const id = match[1];
    if (id) found.add(id);
  }
  return [...found];
}

export type PreviewKind = "image" | "audio" | "video" | "pdf" | "text" | "file";

export function previewKindFor(mime: string | undefined): PreviewKind {
  const type = (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "image/svg+xml") return "file";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("text/") || type === "application/json") return "text";
  return "file";
}

export function formatBytes(size: number | undefined): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) return "unknown size";
  if (size < 1024) return `${size} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

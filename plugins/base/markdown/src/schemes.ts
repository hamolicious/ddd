export const ALLOWED_SCHEMES: readonly string[] = ["http", "https", "mailto", "attachment", "doc"];

export type UrlVerdict =
  | {
      readonly kind: "allowed";
      readonly scheme: string;
      readonly url: string;
      readonly rest: string;
    }
  | { readonly kind: "fragment"; readonly url: string }
  | { readonly kind: "blocked"; readonly reason: string };

const STRIPPED = /[\u0000-\u0020\u007f]/g;

const SCHEME = /^([A-Za-z][A-Za-z0-9+.\-]*):/;

export function classifyUrl(raw: string | null | undefined): UrlVerdict {
  if (typeof raw !== "string") return { kind: "blocked", reason: "no destination" };
  const cleaned = raw.replace(STRIPPED, "");
  if (cleaned.length === 0) return { kind: "blocked", reason: "empty destination" };

  const match = SCHEME.exec(cleaned);
  if (!match) {
    if (cleaned.startsWith("#")) return { kind: "fragment", url: cleaned };
    return {
      kind: "blocked",
      reason: cleaned.startsWith("//") ? "scheme-relative URL" : "relative URL",
    };
  }

  const scheme = (match[1] ?? "").toLowerCase();
  if (!ALLOWED_SCHEMES.includes(scheme)) {
    return { kind: "blocked", reason: `scheme "${scheme}" is not allowlisted` };
  }
  return { kind: "allowed", scheme, url: cleaned, rest: cleaned.slice(match[0].length) };
}

export function isAllowed(raw: string | null | undefined): boolean {
  const verdict = classifyUrl(raw);
  return verdict.kind === "allowed" || verdict.kind === "fragment";
}

export function idFromScheme(
  raw: string | null | undefined,
  scheme: "doc" | "attachment",
): string | null {
  const verdict = classifyUrl(raw);
  if (verdict.kind !== "allowed" || verdict.scheme !== scheme) return null;
  const rest = verdict.rest.startsWith("//") ? verdict.rest.slice(2) : verdict.rest;
  const id = rest.split(/[/?#]/, 1)[0] ?? "";
  return id.length > 0 ? id : null;
}

export function fragmentOf(raw: string | null | undefined): string | null {
  const verdict = classifyUrl(raw);
  const url = verdict.kind === "blocked" ? "" : verdict.url;
  const hash = url.indexOf("#");
  if (hash < 0 || hash === url.length - 1) return null;
  return url.slice(hash + 1);
}

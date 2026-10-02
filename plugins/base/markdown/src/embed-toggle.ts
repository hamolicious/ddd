export interface EmbedLocation {
  readonly at: number;
  readonly source: string;
}

export interface TextEdit {
  readonly range: { readonly start: number; readonly end: number };
  readonly text: string;
}

export function locateEmbed(text: string, base: number, location: EmbedLocation): number | null {
  const { source } = location;
  if (source.length === 0) return null;
  const start = base + location.at;
  if (text.slice(start, start + source.length) === source) return start;
  const first = text.indexOf(source);
  if (first < 0 || text.indexOf(source, first + 1) >= 0) return null;
  return first;
}

export function embedToggle(text: string, base: number, location: EmbedLocation): TextEdit | null {
  const start = locateEmbed(text, base, location);
  if (start === null) return null;
  return location.source.startsWith("!")
    ? { range: { start, end: start + 1 }, text: "" }
    : { range: { start, end: start }, text: "!" };
}

export function embedReplace(
  text: string,
  base: number,
  location: EmbedLocation,
  replacement: string,
): TextEdit | null {
  const start = locateEmbed(text, base, location);
  if (start === null) return null;
  return { range: { start, end: start + location.source.length }, text: replacement };
}

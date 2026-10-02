export const NOTE_EXT = ".md";

export interface LayoutNote {
  readonly id: string;
  readonly title: string;
  readonly parent: string;
  readonly fileName?: string;
}

export interface Placement {
  readonly path: string;
  readonly dir?: string;
}

export type Pinned = ReadonlyMap<string, Placement>;

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_NAME_BYTES = 120;

export function safeName(title: string): string {
  let name = title
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  const encoder = new TextEncoder();
  while (encoder.encode(name).length > MAX_NAME_BYTES) name = [...name].slice(0, -1).join("");
  name = name.trim();
  if (name.length === 0) name = "Untitled";
  if (RESERVED.test(name)) name = `${name}_`;
  return name;
}

export function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

export function joinPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function depth(path: string): number {
  return path.split("/").length;
}

export function nameMatchesTitle(name: string, title: string): boolean {
  const safe = safeName(title);
  if (name === safe) return true;
  const match = /^(.*) \((\d+)\)$/.exec(name);
  return match !== null && match[1] === safe;
}

class Names {
  readonly #taken = new Set<string>();

  reserve(name: string): void {
    this.#taken.add(name.toLowerCase());
  }

  claim(name: string): string {
    const [stem, ext] = splitExt(name);
    let candidate = name;
    for (let n = 2; this.#taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem} (${n})${ext}`;
    this.#taken.add(candidate.toLowerCase());
    return candidate;
  }
}

export function layout(notes: readonly LayoutNote[], pinned: Pinned = new Map()): Map<string, Placement> {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const children = new Map<string, LayoutNote[]>();
  for (const note of notes) {
    const parent = byId.has(note.parent) && note.parent !== note.id ? note.parent : "";
    const list = children.get(parent) ?? [];
    list.push(note);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const out = new Map<string, Placement>();
  const names = new Map<string, Names>();
  const namesIn = (dir: string): Names => {
    let entry = names.get(dir);
    if (!entry) {
      entry = new Names();
      names.set(dir, entry);
    }
    return entry;
  };
  for (const place of pinned.values()) {
    namesIn(dirname(place.dir ?? place.path)).reserve(basename(place.dir ?? place.path));
  }

  const visited = new Set<string>();
  const visit = (parent: string, dir: string): void => {
    for (const note of children.get(parent) ?? []) {
      if (visited.has(note.id)) continue;
      visited.add(note.id);
      const hasChildren = (children.get(note.id)?.length ?? 0) > 0;
      const pin = pinned.get(note.id);
      let place: Placement;
      if (pin) {
        place = pin;
      } else if (hasChildren) {
        const own = joinPath(dir, namesIn(dir).claim(safeName(note.title)));
        const fileName = `${basename(own)}${NOTE_EXT}`;
        namesIn(own).reserve(fileName);
        place = { path: joinPath(own, fileName), dir: own };
      } else if (note.fileName !== undefined) {
        place = { path: joinPath(dir, namesIn(dir).claim(safeName(note.fileName))) };
      } else {
        place = { path: joinPath(dir, namesIn(dir).claim(`${safeName(note.title)}${NOTE_EXT}`)) };
      }
      out.set(note.id, place);
      if (hasChildren) visit(note.id, place.dir ?? dirname(place.path));
    }
  };
  visit("", "");
  return out;
}

export function isIgnored(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith(".")) || /(~|\.swp|\.tmp|\.crswap|\.part)$/i.test(path);
}

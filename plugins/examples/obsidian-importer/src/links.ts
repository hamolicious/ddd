import type { CoreMap, FmValue, TextEdit } from "@kernel";

export interface LinkTarget {
  readonly kind: "document" | "attachment";
  readonly id: string;
  readonly attachmentId?: string;
  readonly path: string;
  readonly title: string;
  readonly aliases: readonly string[];
}

export interface WikilinkRewrite {
  readonly text: string;
  readonly edits: readonly TextEdit[];
  readonly resolved: number;
  readonly unresolved: number;
}

export interface FrontmatterWikilinkRewrite {
  /** Changed top-level fields, ready for `planFrontmatterValue`. */
  readonly values: ReadonlyMap<string, FmValue>;
  readonly resolved: number;
  readonly unresolved: number;
}

interface ParsedWikilink {
  readonly target: string;
  readonly fragment: string;
  readonly label: string | undefined;
}

/** Convert Obsidian wikilinks to Life Manager's stable, id-addressed Markdown links. */
export function rewriteWikilinks(
  text: string,
  sourcePath: string,
  targets: readonly LinkTarget[],
): WikilinkRewrite {
  const resolver = new Resolver(targets);
  const edits: TextEdit[] = [];
  let resolved = 0;
  let unresolved = 0;
  let offset = 0;
  let frontmatter = false;
  let machineSection = false;
  let fence: { readonly mark: string; readonly length: number } | undefined;

  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(offset, end);
    const trimmed = line.trim();

    if (offset === 0 && trimmed === "---") {
      frontmatter = true;
    } else if (frontmatter) {
      if (trimmed === "---" || trimmed === "...") frontmatter = false;
    } else if (machineSection) {
      if (trimmed === "%%%") machineSection = false;
    } else if (/^%%%\s+\S/.test(trimmed)) {
      machineSection = true;
    } else {
      const fenceRun = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (
          fenceRun &&
          fenceRun[0] === fence.mark &&
          fenceRun.length >= fence.length &&
          trimmed === fenceRun
        ) {
          fence = undefined;
        }
      } else if (fenceRun) {
        fence = { mark: fenceRun[0]!, length: fenceRun.length };
      } else {
        rewriteLine(line, offset, sourcePath, resolver, edits, (didResolve) => {
          if (didResolve) resolved += 1;
          else unresolved += 1;
        });
      }
    }
    offset = newline < 0 ? text.length : newline + 1;
  }

  let rewritten = text;
  for (const edit of [...edits].sort((left, right) => right.range.start - left.range.start)) {
    rewritten = rewritten.slice(0, edit.range.start) + edit.text + rewritten.slice(edit.range.end);
  }
  return { text: rewritten, edits, resolved, unresolved };
}

/** Resolve exact wikilink values recursively inside frontmatter lists and maps. */
export function rewriteFrontmatterWikilinks(
  frontmatter: CoreMap,
  sourcePath: string,
  targets: readonly LinkTarget[],
): FrontmatterWikilinkRewrite {
  const resolver = new Resolver(targets);
  const values = new Map<string, FmValue>();
  let resolved = 0;
  let unresolved = 0;

  const visit = (value: FmValue): { readonly value: FmValue; readonly changed: boolean } => {
    if (typeof value === "string") {
      const attachment = attachmentIdFromUrl(value.trim());
      if (attachment) {
        const target = resolver.resolveAttachment(attachment);
        if (!target) {
          unresolved += 1;
          return { value, changed: false };
        }
        resolved += 1;
        return { value: targetUrl(target, ""), changed: true };
      }
      const match = /^\s*!?\[\[([^\]\r\n]+)\]\]\s*$/.exec(value);
      if (!match?.[1]) return { value, changed: false };
      const parsed = parseWikilink(match[1]);
      const target = resolver.resolve(sourcePath, parsed.target);
      if (!target) {
        unresolved += 1;
        return { value, changed: false };
      }
      resolved += 1;
      return { value: targetUrl(target, parsed.fragment), changed: true };
    }
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const visited = visit(item);
        changed ||= visited.changed;
        return visited.value;
      });
      return changed ? { value: next, changed: true } : { value, changed: false };
    }
    if (isValueMap(value)) {
      let changed = false;
      const next: Record<string, FmValue> = {};
      for (const [key, item] of Object.entries(value)) {
        const visited = visit(item);
        changed ||= visited.changed;
        next[key] = visited.value;
      }
      return changed ? { value: next, changed: true } : { value, changed: false };
    }
    return { value, changed: false };
  };

  for (const [key, value] of Object.entries(frontmatter)) {
    const rewritten = visit(value);
    if (rewritten.changed) values.set(key, rewritten.value);
  }
  return { values, resolved, unresolved };
}

function rewriteLine(
  line: string,
  lineOffset: number,
  sourcePath: string,
  resolver: Resolver,
  edits: TextEdit[],
  counted: (resolved: boolean) => void,
): void {
  let cursor = 0;
  let codeTicks = 0;
  while (cursor < line.length) {
    if (line[cursor] === "`") {
      const run = countRun(line, cursor, "`");
      if (codeTicks === 0) codeTicks = run;
      else if (run === codeTicks) codeTicks = 0;
      cursor += run;
      continue;
    }
    const embedded = line.startsWith("![[", cursor);
    const linked = line.startsWith("[[", cursor);
    if (codeTicks === 0 && (embedded || linked) && !isEscaped(line, cursor)) {
      const openLength = embedded ? 3 : 2;
      const close = line.indexOf("]]", cursor + openLength);
      if (close >= 0) {
        const parsed = parseWikilink(line.slice(cursor + openLength, close));
        const target = resolver.resolve(sourcePath, parsed.target);
        if (target) {
          const label = parsed.label ?? defaultLabel(parsed.target, parsed.fragment);
          const url = targetUrl(target, parsed.fragment);
          const attachmentLabel = parsed.label && !/^\d+(?:x\d+)?$/.test(parsed.label) ? parsed.label : target.title;
          const replacement = embedded
            ? target.kind === "attachment"
              ? `![${escapeLabel(attachmentLabel)}](${url})`
              : `![](${url})`
            : `[${escapeLabel(label)}](${url})`;
          edits.push({
            range: { start: lineOffset + cursor, end: lineOffset + close + 2 },
            text: replacement,
          });
          counted(true);
        } else {
          counted(false);
        }
        cursor = close + 2;
        continue;
      }
    }
    if (codeTicks === 0 && !isEscaped(line, cursor)) {
      const markdown = markdownLinkAt(line, cursor);
      if (markdown) {
        const importedAttachment = attachmentIdFromUrl(markdown.destination);
        if (importedAttachment) {
          const target = resolver.resolveAttachment(importedAttachment);
          if (target) {
            edits.push({
              range: { start: lineOffset + cursor, end: lineOffset + cursor + markdown.length },
              text: `${markdown.embedded ? "!" : ""}[${markdown.label}](${targetUrl(target, "")})`,
            });
            counted(true);
          } else {
            counted(false);
          }
        } else if (isLocalDestination(markdown.destination)) {
          const parsed = parseMarkdownDestination(markdown.destination);
          const target = resolver.resolve(sourcePath, parsed.target);
          if (target) {
            edits.push({
              range: { start: lineOffset + cursor, end: lineOffset + cursor + markdown.length },
              text: `${markdown.embedded ? "!" : ""}[${markdown.label}](${targetUrl(target, parsed.fragment)})`,
            });
            counted(true);
          } else {
            counted(false);
          }
        }
        cursor += markdown.length;
        continue;
      }
    }
    cursor += 1;
  }
}

interface ParsedMarkdownLink {
  readonly embedded: boolean;
  readonly label: string;
  readonly destination: string;
  readonly length: number;
}

function markdownLinkAt(line: string, start: number): ParsedMarkdownLink | undefined {
  const match = /^(!?)\[([^\]\r\n]*)\]\((<[^>\r\n]+>|[^\s)\r\n]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/.exec(
    line.slice(start),
  );
  if (!match?.[3]) return undefined;
  const raw = match[3];
  return {
    embedded: match[1] === "!",
    label: match[2] ?? "",
    destination: raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw,
    length: match[0].length,
  };
}

function isLocalDestination(destination: string): boolean {
  return (
    destination !== "" &&
    !destination.startsWith("#") &&
    !destination.startsWith("//") &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(destination)
  );
}

function parseMarkdownDestination(destination: string): Pick<ParsedWikilink, "target" | "fragment"> {
  const hash = destination.indexOf("#");
  return {
    target: hash < 0 ? destination : destination.slice(0, hash),
    fragment: hash < 0 ? "" : decodeTarget(destination.slice(hash + 1)),
  };
}

function parseWikilink(value: string): ParsedWikilink {
  const separator = unescapedIndex(value, "|");
  const destination = (separator < 0 ? value : value.slice(0, separator)).trim();
  const label = separator < 0 ? undefined : unescapeObsidian(value.slice(separator + 1).trim());
  const hash = destination.indexOf("#");
  const block = hash < 0 ? destination.indexOf("^") : -1;
  const fragmentAt = hash >= 0 ? hash : block;
  const fragmentStart = block >= 0 ? block : fragmentAt + 1;
  return {
    target: unescapeObsidian(fragmentAt < 0 ? destination : destination.slice(0, fragmentAt)).trim(),
    fragment: unescapeObsidian(fragmentAt < 0 ? "" : destination.slice(fragmentStart)).trim(),
    label,
  };
}

class Resolver {
  readonly #paths = new Map<string, LinkTarget>();
  readonly #names = new Map<string, LinkTarget[]>();
  readonly #attachments = new Map<string, LinkTarget>();
  readonly #attachmentStemPaths = new Map<string, LinkTarget[]>();
  readonly #attachmentStems = new Map<string, LinkTarget[]>();

  constructor(targets: readonly LinkTarget[]) {
    for (const target of targets) {
      if (target.attachmentId) this.#attachments.set(target.attachmentId, target);
      const path = target.kind === "document" ? withoutMarkdown(target.path) : target.path;
      this.#paths.set(normalizePath(path), target);
      for (const name of [basename(path), target.title, ...target.aliases]) {
        addTarget(this.#names, normalizeName(name), target);
      }
      if (target.kind === "attachment") {
        addTarget(this.#attachmentStemPaths, normalizePath(withoutExtension(path)), target);
        addTarget(this.#attachmentStems, normalizeName(withoutExtension(basename(path))), target);
      }
    }
  }

  resolve(sourcePath: string, rawTarget: string): LinkTarget | undefined {
    if (rawTarget.trim() === "") {
      const own = normalizePath(withoutMarkdown(sourcePath));
      return this.#paths.get(own);
    }
    const decoded = decodeTarget(rawTarget);
    const sourceDirectory = dirname(withoutMarkdown(sourcePath));
    const exact = [decoded, withoutMarkdown(decoded)]
      .flatMap((candidate) => [normalizePath(joinPath(sourceDirectory, candidate)), normalizePath(candidate)])
      .map((candidate) => this.#paths.get(candidate))
      .find((candidate) => candidate !== undefined);
    if (exact) return exact;

    const candidates = namedTargets(this.#names, [basename(decoded), basename(withoutMarkdown(decoded))]);
    if (candidates.length > 0) return nearest(candidates, sourceDirectory);

    if (hasExtension(decoded)) return undefined;
    const stemPathCandidates = [
      normalizePath(joinPath(sourceDirectory, decoded)),
      normalizePath(decoded),
    ].flatMap((path) => this.#attachmentStemPaths.get(path) ?? []);
    const stemCandidates = dedupeTargets(
      stemPathCandidates.length > 0
        ? stemPathCandidates
        : namedTargets(this.#attachmentStems, [basename(decoded)]),
    );
    return nearest(stemCandidates, sourceDirectory);
  }

  resolveAttachment(id: string): LinkTarget | undefined {
    return this.#attachments.get(id);
  }
}

function addTarget(index: Map<string, LinkTarget[]>, key: string, target: LinkTarget): void {
  if (key === "") return;
  const list = index.get(key) ?? [];
  if (!list.some((entry) => entry.id === target.id)) list.push(target);
  index.set(key, list);
}

function namedTargets(index: ReadonlyMap<string, readonly LinkTarget[]>, names: readonly string[]): LinkTarget[] {
  return dedupeTargets(names.flatMap((name) => index.get(normalizeName(name)) ?? []));
}

function dedupeTargets(targets: readonly LinkTarget[]): LinkTarget[] {
  return targets.filter(
    (target, index, all) => all.findIndex((candidate) => candidate.id === target.id) === index,
  );
}

function nearest(candidates: readonly LinkTarget[], sourceDirectory: string): LinkTarget | undefined {
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) return undefined;
    const ranked = candidates
      .map((target) => ({ target, distance: directoryDistance(sourceDirectory, dirname(target.path)) }))
      .sort((left, right) => left.distance - right.distance || left.target.path.localeCompare(right.target.path));
    return ranked.length > 1 && ranked[0]!.distance === ranked[1]!.distance ? undefined : ranked[0]?.target;
}

function targetUrl(target: LinkTarget, fragment: string): string {
  const suffix = target.kind === "document" && fragment !== "" ? `#${encodeURIComponent(fragment)}` : "";
  return `doc://${target.id}${suffix}`;
}

function attachmentIdFromUrl(value: string): string | undefined {
  return /^attachment:(?:\/\/)?([^/?#\s]+)(?:[/?#].*)?$/i.exec(value)?.[1];
}

export function aliasesOf(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function defaultLabel(target: string, fragment: string): string {
  const name = basename(withoutMarkdown(target));
  return name || fragment || "link";
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function unescapeObsidian(value: string): string {
  return value.replace(/\\([|#^\\])/g, "$1");
}

function unescapedIndex(value: string, needle: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === needle && !isEscaped(value, index)) return index;
  }
  return -1;
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function countRun(value: string, start: number, character: string): number {
  let end = start;
  while (value[end] === character) end += 1;
  return end - start;
}

function withoutMarkdown(value: string): string {
  return value.replace(/\.md$/i, "");
}

function withoutExtension(value: string): string {
  return value.replace(/\.[^./]+$/, "");
}

function hasExtension(value: string): boolean {
  return /\.[^./]+$/.test(basename(value));
}

function normalizeName(value: string): string {
  return value.trim().normalize("NFC").toLocaleLowerCase();
}

function normalizePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    const trimmed = part.trim();
    if (trimmed === "" || trimmed === ".") continue;
    if (trimmed === "..") parts.pop();
    else parts.push(trimmed);
  }
  return normalizeName(parts.join("/"));
}

function joinPath(left: string, right: string): string {
  return left === "" ? right : `${left}/${right}`;
}

function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

function decodeTarget(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function directoryDistance(left: string, right: string): number {
  const a = normalizePath(left).split("/").filter(Boolean);
  const b = normalizePath(right).split("/").filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  return a.length - common + b.length - common;
}

function isValueMap(value: FmValue): value is CoreMap {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { KernelError, type FmValue, type TextEdit } from "@kernel";

export interface SectionKeyEdit {
  readonly key: string;
  readonly value?: FmValue;
}

export const MAX_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_KEY_LEN = 64;
export const MAX_MACHINE_SECTIONS = 64;

export class SpliceError extends KernelError {}

export function isValidKey(key: string): boolean {
  if (key.length === 0 || utf8Length(key) > MAX_KEY_LEN) return false;
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i);
    const ok =
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      c === 0x5f ||
      c === 0x2d;
    if (!ok) return false;
  }
  return true;
}

export function setFrontmatterValue(text: string, key: string, value: FmValue): TextEdit[] {
  guard(text);
  requireKey(key);
  const serialized = toYamlInline(value);

  if (findBlock(text) === undefined) {
    let block = `---\n${key}: ${serialized}\n---\n`;
    if (text.length > 0 && !text.startsWith("\n")) block += "\n";
    return [{ range: { start: 0, end: 0 }, text: block }];
  }

  const span = valueSpan(text, key);
  if (span !== undefined) {
    const needsSpace = text.slice(0, span.start).endsWith(":");
    return [{ range: span, text: needsSpace ? ` ${serialized}` : serialized }];
  }

  const at = frontmatterInsertPoint(text) ?? 0;
  return [{ range: { start: at, end: at }, text: `${key}: ${serialized}\n` }];
}

export function removeFrontmatterKey(text: string, key: string): TextEdit[] {
  guard(text);
  return sortEdits(
    frontmatterLineSpans(text, key).map((range) => ({ range, text: "" })),
  );
}

export function spliceSection(
  text: string,
  pluginId: string,
  edits: readonly SectionKeyEdit[],
): TextEdit[] {
  guard(text);
  requireKey(pluginId);
  for (const edit of edits) requireKey(edit.key);

  const ordered: SectionKeyEdit[] = [];
  for (const edit of edits) {
    const index = ordered.findIndex((kept) => kept.key === edit.key);
    if (index >= 0) ordered[index] = edit;
    else ordered.push(edit);
  }

  const parsed = parseSections(text);
  const section = lastSection(parsed, pluginId);

  if (section === undefined) {
    const body = ordered
      .filter((edit) => !isRemoval(edit))
      .map((edit) => `${edit.key}: ${toYamlInline(edit.value as FmValue)}\n`)
      .join("");
    return [newSection(text, parsed, pluginId, body)];
  }

  const out: TextEdit[] = [];
  let appended = "";
  for (const edit of ordered) {
    const spans = keyLineSpans(text, section, edit.key);
    const last = spans.pop();
    for (const range of spans) out.push({ range, text: "" });
    const removal = isRemoval(edit);
    if (last !== undefined && !removal) {
      out.push({ range: last, text: `${edit.key}: ${toYamlInline(edit.value as FmValue)}\n` });
    } else if (last !== undefined) {
      out.push({ range: last, text: "" });
    } else if (!removal) {
      appended += `${edit.key}: ${toYamlInline(edit.value as FmValue)}\n`;
    }
  }
  if (appended.length > 0) {
    const at = section.bodySpan.end;
    out.push({ range: { start: at, end: at }, text: appended });
  }
  return sortEdits(out);
}

function newSection(text: string, parsed: ParsedSections, pluginId: string, body: string): TextEdit {
  const fenced = `%%% ${pluginId}\n${body}%%%\n`;
  if (parsed.runSpan !== undefined) {
    const at = parsed.runSpan.end;
    return { range: { start: at, end: at }, text: fenced };
  }
  let separator = "";
  if (text.length > 0) {
    if (!text.endsWith("\n")) separator = "\n\n";
    else if (!text.endsWith("\n\n")) separator = "\n";
  }
  return { range: { start: text.length, end: text.length }, text: `${separator}${fenced}` };
}

export type ListActionInput =
  | { readonly action: "push"; readonly value: FmValue }
  | { readonly action: "insert"; readonly index: number; readonly value: FmValue }
  | { readonly action: "remove"; readonly value: FmValue }
  | { readonly action: "pop" };

export interface ListEdit {
  readonly edits: TextEdit[];
  readonly popped?: FmValue;
}

const DEFAULT_INDENT = "  ";

export function frontmatterList(text: string, key: string, action: ListActionInput): ListEdit {
  guard(text);
  requireKey(key);
  requireItem(action);
  const block = findBlock(text);
  if (block === undefined) {
    const item = createdItem(action);
    if (item === undefined) return { edits: [] };
    let created = `---\n${key}:\n${itemLine(DEFAULT_INDENT, item.value)}---\n`;
    if (text.length > 0 && !text.startsWith("\n")) created += "\n";
    return { edits: [{ range: { start: 0, end: 0 }, text: created }] };
  }
  return regionList(text, block.inner, key, action);
}

export function sectionList(
  text: string,
  pluginId: string,
  key: string,
  action: ListActionInput,
): ListEdit {
  guard(text);
  requireKey(pluginId);
  requireKey(key);
  requireItem(action);
  const parsed = parseSections(text);
  const section = lastSection(parsed, pluginId);
  if (section === undefined) {
    const item = createdItem(action);
    if (item === undefined) return { edits: [] };
    const body = `${key}:\n${itemLine(DEFAULT_INDENT, item.value)}`;
    return { edits: [newSection(text, parsed, pluginId, body)] };
  }
  return regionList(text, section.bodySpan, key, action);
}

function createdItem(action: ListActionInput): { readonly value: FmValue } | undefined {
  return action.action === "push" || action.action === "insert" ? { value: action.value } : undefined;
}

function requireItem(action: ListActionInput): void {
  if (action.action === "pop") return;
  const value = action.value;
  if (value !== null && typeof value === "object") {
    throw new SpliceError("splice target not found: list items must be scalars");
  }
}

interface Occurrence {
  readonly span: Span;
  readonly header: Span;
  readonly block: readonly ListItem[] | undefined;
  readonly inline: FmValue | undefined;
}

interface ListItem {
  readonly line: Span;
  readonly indent: string;
  readonly value: FmValue | undefined;
}

function occurrences(text: string, region: Span, key: string): Occurrence[] {
  const lines = splitLines(text.slice(region.start, region.end));
  const at = (offset: number): number => region.start + offset;
  const out: Occurrence[] = [];
  for (const [index, line] of lines.entries()) {
    if (lineKey(line.content) !== key) continue;
    const header: Span = { start: at(line.start), end: at(line.fullEnd) };
    const split = splitKey(line.content.trim());
    if (split !== undefined && split[1].trim().length === 0) {
      const items: ListItem[] = [];
      let end = line.fullEnd;
      const first = lines[index + 1];
      const indent = first ? blockItemIndent(first.content) : undefined;
      if (indent !== undefined) {
        for (const item of lines.slice(index + 1)) {
          if (blockItemIndent(item.content) !== indent) break;
          const rest = item.content.slice(indent);
          const raw = rest === "-" ? "" : rest.slice(2);
          items.push({
            line: { start: at(item.start), end: at(item.fullEnd) },
            indent: item.content.slice(0, indent),
            value: parseValue(raw, 2),
          });
          end = item.fullEnd;
        }
      }
      out.push({ span: { start: at(line.start), end: at(end) }, header, block: items, inline: undefined });
    } else {
      const inline = split === undefined ? undefined : parseValue(split[1], 1);
      out.push({ span: header, header, block: undefined, inline });
    }
  }
  return out;
}

function inlineItems(value: FmValue | undefined): FmValue[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return [...(value as readonly FmValue[])];
  return [value];
}

function itemLine(indent: string, value: FmValue): string {
  return `${indent}- ${toYamlInline(value)}\n`;
}

function sameValue(left: FmValue | undefined, right: FmValue | undefined): boolean {
  if (left === right) return true;
  if (left === null || right === null || left === undefined || right === undefined) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    const a = left as readonly FmValue[];
    const b = right as readonly FmValue[];
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  const a = left as Record<string, FmValue>;
  const b = right as Record<string, FmValue>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && sameValue(a[k], b[k]));
}

const includesValue = (list: readonly FmValue[], value: FmValue): boolean =>
  list.some((item) => sameValue(item, value));

function regionList(text: string, region: Span, key: string, action: ListActionInput): ListEdit {
  const found = occurrences(text, region, key);
  const last = found.pop();
  if (last === undefined) {
    const item = createdItem(action);
    if (item === undefined) return { edits: [] };
    return {
      edits: [{ range: { start: region.end, end: region.end }, text: `${key}:\n${itemLine(DEFAULT_INDENT, item.value)}` }],
    };
  }

  const edits: TextEdit[] = [];
  const folded: FmValue[] = [];
  for (const earlier of found) {
    edits.push({ range: earlier.span, text: "" });
    if (earlier.block !== undefined) {
      for (const item of earlier.block) if (item.value !== undefined) folded.push(item.value);
    } else {
      folded.push(...inlineItems(earlier.inline));
    }
  }

  const popped =
    last.block !== undefined
      ? blockList(edits, last, last.block, folded, action)
      : rewriteList(edits, key, last, folded, action);
  return popped === undefined ? { edits: sortEdits(edits) } : { edits: sortEdits(edits), popped };
}

function blockList(
  edits: TextEdit[],
  last: Occurrence,
  items: readonly ListItem[],
  folded: readonly FmValue[],
  action: ListActionInput,
): FmValue | undefined {
  const indent = items[0]?.indent ?? DEFAULT_INDENT;
  const tail = items.length > 0 ? (items[items.length - 1] as ListItem).line.end : last.header.end;

  const present = items.flatMap((item) => (item.value === undefined ? [] : [item.value]));
  const appended: FmValue[] = [];
  for (const value of folded) {
    if (!includesValue(present, value) && !includesValue(appended, value)) appended.push(value);
  }

  let popped: FmValue | undefined;
  switch (action.action) {
    case "push":
      appended.push(action.value);
      break;
    case "insert": {
      const item = items[action.index];
      if (item !== undefined) {
        edits.push({ range: { start: item.line.start, end: item.line.start }, text: itemLine(indent, action.value) });
      } else appended.push(action.value);
      break;
    }
    case "remove":
      for (const item of items) {
        if (item.value !== undefined && sameValue(item.value, action.value)) edits.push({ range: item.line, text: "" });
      }
      break;
    case "pop": {
      const item = items[items.length - 1];
      if (item !== undefined) {
        popped = item.value;
        edits.push({ range: item.line, text: "" });
      }
      break;
    }
  }

  if (appended.length > 0) {
    edits.push({
      range: { start: tail, end: tail },
      text: appended.map((value) => itemLine(indent, value)).join(""),
    });
  }
  return popped;
}

function rewriteList(
  edits: TextEdit[],
  key: string,
  last: Occurrence,
  folded: readonly FmValue[],
  action: ListActionInput,
): FmValue | undefined {
  const before = inlineItems(last.inline);
  const items = [...before];
  for (const value of folded) if (!includesValue(items, value)) items.push(value);
  let popped: FmValue | undefined;
  switch (action.action) {
    case "push":
      items.push(action.value);
      break;
    case "insert":
      items.splice(Math.min(action.index, items.length), 0, action.value);
      break;
    case "remove":
      for (let i = items.length - 1; i >= 0; i -= 1) if (sameValue(items[i], action.value)) items.splice(i, 1);
      break;
    case "pop":
      popped = items.pop();
      break;
  }
  if (sameValue(items, before) && edits.length === 0) return popped;
  edits.push({
    range: last.header,
    text: `${key}:\n${items.map((item) => itemLine(DEFAULT_INDENT, item)).join("")}`,
  });
  return popped;
}

export function removeSection(text: string, pluginId: string): TextEdit[] {
  guard(text);
  return sortEdits(
    parseSections(text)
      .sections.filter((section) => section.pluginId === pluginId)
      .map((section) => ({ range: section.span, text: "" })),
  );
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort(
    (a, b) => b.range.start - a.range.start || b.range.end - a.range.end,
  );
  let out = text;
  for (const edit of ordered) {
    const start = clamp(out, edit.range.start);
    const end = clamp(out, Math.max(edit.range.end, edit.range.start));
    out = out.slice(0, start) + edit.text + out.slice(end);
  }
  return out;
}

function isRemoval(edit: SectionKeyEdit): boolean {
  return !("value" in edit) || edit.value === undefined;
}

export interface Span {
  readonly start: number;
  readonly end: number;
}

interface Line {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly fullEnd: number;
  readonly content: string;
}

function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  let index = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) {
      let end = text.length;
      if (end > start && text[end - 1] === "\r") end -= 1;
      out.push({ index, start, end, fullEnd: text.length, content: text.slice(start, end) });
      break;
    }
    let end = newline;
    if (end > start && text[end - 1] === "\r") end -= 1;
    out.push({ index, start, end, fullEnd: newline + 1, content: text.slice(start, end) });
    start = newline + 1;
    index += 1;
  }
  return out;
}

function splitKey(text: string): [string, string] | undefined {
  let depth = 0;
  let quote: string | undefined;
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (quote !== undefined) {
      if (quote === '"' && c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "[" || c === "{") {
      depth += 1;
    } else if (c === "]" || c === "}") {
      depth -= 1;
    } else if (c === ":" && depth === 0) {
      const next = i + 1 < text.length ? text[i + 1] : undefined;
      if (next === undefined || next === " " || next === "\t") {
        return [text.slice(0, i), text.slice(i + 1)];
      }
    }
    i += 1;
  }
  return undefined;
}

function unquoteKey(key: string): string {
  const k = key.trim();
  const double = doubleQuoted(k);
  if (double !== undefined) return unescapeDouble(double);
  const single = singleQuoted(k);
  if (single !== undefined) return single.replaceAll("''", "'");
  return k;
}

function lineKey(content: string): string | undefined {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return undefined;
  if (content.startsWith(" ") || content.startsWith("\t")) return undefined;
  const split = splitKey(trimmed);
  if (!split) return undefined;
  const key = unquoteKey(split[0]);
  return isValidKey(key) ? key : undefined;
}

function expandedValueEnd(lines: readonly Line[], header: number): Line | undefined {
  const line = lines[header];
  if (!line || line.content.startsWith(" ") || line.content.startsWith("\t")) return undefined;
  const split = splitKey(line.content.trim());
  if (!split || split[1].trim().length > 0) return undefined;
  const first = lines[header + 1];
  const indent = first ? blockItemIndent(first.content) : undefined;
  if (indent === undefined) return undefined;
  let last = first;
  for (const item of lines.slice(header + 2)) {
    if (blockItemIndent(item.content) !== indent) break;
    last = item;
  }
  return last;
}

function blockItemIndent(content: string): number | undefined {
  let indent = 0;
  while (content[indent] === " " || content[indent] === "\t") indent += 1;
  const trimmed = content.slice(indent);
  if (indent === 0 || (trimmed !== "-" && !trimmed.startsWith("- "))) return undefined;
  return indent;
}

const FM_FENCE = "---";

export function findBlock(text: string): { outer: Span; inner: Span } | undefined {
  const lines = splitLines(text);
  const first = lines[0];
  if (!first || first.content !== FM_FENCE) return undefined;
  for (const line of lines.slice(1)) {
    if (line.content === FM_FENCE) {
      return {
        outer: { start: 0, end: line.fullEnd },
        inner: { start: first.fullEnd, end: line.start },
      };
    }
  }
  return undefined;
}

export function valueSpan(text: string, key: string): Span | undefined {
  const block = findBlock(text);
  if (!block) return undefined;
  let found: Span | undefined;
  const lines = splitLines(text.slice(block.inner.start, block.inner.end));
  for (const [index, line] of lines.entries()) {
    if (lineKey(line.content) !== key) continue;
    const lineStart = block.inner.start + line.start;
    const lineEnd = block.inner.start + line.end;
    const colon = line.content.indexOf(":");
    if (colon < 0) return undefined;
    const after = lineStart + colon + 1;
    const rest = text.slice(after, lineEnd);
    const lead = rest.length - trimStartSpaces(rest).length;
    const trail = rest.length - trimEndSpaces(rest).length;
    const start = after + lead;
    const end = Math.max(lineEnd - trail, start);
    const expanded = expandedValueEnd(lines, index);
    found = {
      start,
      end: expanded ? block.inner.start + expanded.end : end,
    };
  }
  return found;
}

export function frontmatterLineSpans(text: string, key: string): Span[] {
  const block = findBlock(text);
  if (!block) return [];
  const lines = splitLines(text.slice(block.inner.start, block.inner.end));
  return lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => lineKey(line.content) === key)
    .map(({ line, index }) => ({
      start: block.inner.start + line.start,
      end: block.inner.start + (expandedValueEnd(lines, index)?.fullEnd ?? line.fullEnd),
    }));
}

export function frontmatterInsertPoint(text: string): number | undefined {
  return findBlock(text)?.inner.end;
}

const SECTION_FENCE = "%%%";
const SECTION_FENCE_OPEN = "%%% ";

export interface MachineSectionSpans {
  readonly pluginId: string;
  readonly span: Span;
  readonly bodySpan: Span;
}

export interface ParsedSections {
  readonly sections: readonly MachineSectionSpans[];
  readonly runSpan: Span | undefined;
}

function openFenceId(content: string): string | undefined {
  if (!content.startsWith(SECTION_FENCE_OPEN)) return undefined;
  const id = content.slice(SECTION_FENCE_OPEN.length);
  return isValidKey(id) ? id : undefined;
}

export function parseSections(text: string): ParsedSections {
  const lines = splitLines(text);
  let cursor = lines.length;
  const pairs: [number, number][] = [];
  for (;;) {
    while (cursor > 0 && (lines[cursor - 1] as Line).content.trim().length === 0) cursor -= 1;
    if (cursor === 0) break;
    const close = cursor - 1;
    if ((lines[close] as Line).content !== SECTION_FENCE) break;
    let open: number | undefined;
    let probe = close;
    while (probe > 0) {
      probe -= 1;
      const content = (lines[probe] as Line).content;
      if (content === SECTION_FENCE) break;
      if (openFenceId(content) !== undefined) {
        open = probe;
        break;
      }
    }
    if (open === undefined) break;
    pairs.push([open, close]);
    cursor = open;
  }
  pairs.reverse();

  if (pairs.length === 0) return { sections: [], runSpan: undefined };

  const firstPair = pairs[0] as [number, number];
  const lastPair = pairs[pairs.length - 1] as [number, number];
  const runSpan: Span = {
    start: (lines[firstPair[0]] as Line).start,
    end: (lines[lastPair[1]] as Line).fullEnd,
  };

  const sections: MachineSectionSpans[] = [];
  for (const [index, [open, close]] of pairs.entries()) {
    if (index >= MAX_MACHINE_SECTIONS) break;
    const openLine = lines[open] as Line;
    const closeLine = lines[close] as Line;
    sections.push({
      pluginId: openFenceId(openLine.content) as string,
      span: { start: openLine.start, end: closeLine.fullEnd },
      bodySpan: { start: openLine.fullEnd, end: closeLine.start },
    });
  }
  return { sections, runSpan };
}

export function lastSection(
  parsed: ParsedSections,
  pluginId: string,
): MachineSectionSpans | undefined {
  for (let i = parsed.sections.length - 1; i >= 0; i -= 1) {
    const section = parsed.sections[i] as MachineSectionSpans;
    if (section.pluginId === pluginId) return section;
  }
  return undefined;
}

export function keyLineSpans(
  text: string,
  section: MachineSectionSpans,
  key: string,
): Span[] {
  const body = text.slice(section.bodySpan.start, section.bodySpan.end);
  const lines = splitLines(body);
  return lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => lineKey(line.content) === key)
    .map(({ line, index }) => ({
      start: section.bodySpan.start + line.start,
      end: section.bodySpan.start + (expandedValueEnd(lines, index)?.fullEnd ?? line.fullEnd),
    }));
}

export function toYamlInline(value: FmValue): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return needsQuoting(value) ? quoteDouble(value) : value;
  if (Array.isArray(value)) {
    return `[${(value as readonly FmValue[]).map(toYamlInline).join(", ")}]`;
  }
  const entries = Object.entries(value as Record<string, FmValue>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${key}: ${toYamlInline(item)}`).join(", ")}}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "null";
  if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) {
    return String(value);
  }
  const text = String(value);
  return text.includes(".") || text.includes("e") || text.includes("E") ? text : `${text}.0`;
}

function needsQuoting(s: string): boolean {
  if (s.length === 0 || s !== s.trim()) return true;
  const scalar = parseScalar(s);
  if (!(typeof scalar === "string" && scalar === s)) return true;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20) return true;
    if ("\n\r\t#,[]{}:\"'".includes(s[i] as string)) return true;
  }
  return "-?&*!|>%@`".includes(s[0] as string);
}

function quoteDouble(s: string): string {
  let out = '"';
  for (const c of s) {
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if ((c.codePointAt(0) as number) < 0x20) {
      out += `\\u${(c.codePointAt(0) as number).toString(16).padStart(4, "0")}`;
    } else out += c;
  }
  return `${out}"`;
}

export function parseValue(raw: string, depth: number): FmValue | undefined {
  if (depth > 5) return undefined;
  const s = stripComment(raw.trim()).trim();
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) return undefined;
    const parts = splitFlow(s.slice(1, -1));
    if (parts === undefined || parts.length > 1000) return undefined;
    const out: FmValue[] = [];
    for (const part of parts) {
      const value = parseValue(part, depth + 1);
      if (value === undefined) return undefined;
      out.push(value);
    }
    return out;
  }
  if (s.startsWith("{")) {
    if (!s.endsWith("}")) return undefined;
    const parts = splitFlow(s.slice(1, -1));
    if (parts === undefined || parts.length > 1000) return undefined;
    const map: Record<string, FmValue> = {};
    for (const part of parts) {
      const split = splitKey(part);
      if (split === undefined) return undefined;
      const key = unquoteKey(split[0]);
      if (!isValidKey(key)) return undefined;
      const value = parseValue(split[1], depth + 1);
      if (value === undefined) return undefined;
      map[key] = value;
    }
    return map;
  }
  if ("&*!|>?".includes(s[0] ?? " ") || s === "---" || s === "...") return undefined;
  if (s.startsWith('"') && doubleQuoted(s) === undefined) return undefined;
  if (s.startsWith("'") && singleQuoted(s) === undefined) return undefined;
  if (s.endsWith("]") || s.endsWith("}")) return undefined;
  return parseScalar(s);
}

function splitFlow(inner: string): string[] | undefined {
  const parts: string[] = [];
  if (inner.trim().length === 0) return parts;
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  let i = 0;
  while (i < inner.length) {
    const c = inner[i] as string;
    if (quote !== undefined) {
      if (quote === '"' && c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "[" || c === "{") {
      depth += 1;
    } else if (c === "]" || c === "}") {
      depth -= 1;
      if (depth < 0) return undefined;
    } else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  if (quote !== undefined || depth !== 0) return undefined;
  const tail = inner.slice(start);
  if (tail.trim().length > 0 || parts.length === 0) parts.push(tail);
  return parts;
}

function parseScalar(raw: string): string | number | boolean | null {
  const s = stripComment(raw.trim()).trim();
  if (s.length === 0) return null;
  const double = doubleQuoted(s);
  if (double !== undefined) return unescapeDouble(double);
  const single = singleQuoted(s);
  if (single !== undefined) return single.replaceAll("''", "'");
  if (s === "null" || s === "Null" || s === "NULL" || s === "~") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (intShape(s)) {
    const parsed = Number(s);
    return Number.isFinite(parsed) ? parsed : s;
  }
  if (floatShape(s)) {
    const parsed = Number(s);
    if (Number.isFinite(parsed)) return parsed;
  }
  return s;
}

function stripComment(s: string): string {
  let quote: string | undefined;
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (quote !== undefined) {
      if (quote === '"' && c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || s[i - 1] === " " || s[i - 1] === "\t")) {
      return trimEndSpaces(s.slice(0, i));
    }
    i += 1;
  }
  return s;
}

function doubleQuoted(s: string): string | undefined {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return undefined;
  const inner = s.slice(1, -1);
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "\\") i += 2;
    else if (inner[i] === '"') return undefined;
    else i += 1;
  }
  return i > inner.length ? undefined : inner;
}

function singleQuoted(s: string): string | undefined {
  if (s.length < 2 || !s.startsWith("'") || !s.endsWith("'")) return undefined;
  const inner = s.slice(1, -1);
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "'") {
      if (inner[i + 1] === "'") i += 2;
      else return undefined;
    } else i += 1;
  }
  return inner;
}

function unescapeDouble(inner: string): string {
  let out = "";
  let i = 0;
  while (i < inner.length) {
    const c = inner[i] as string;
    i += 1;
    if (c !== "\\") {
      out += c;
      continue;
    }
    if (i >= inner.length) {
      out += "\\";
      break;
    }
    const next = inner[i] as string;
    i += 1;
    switch (next) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "0": out += "\0"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "/": out += "/"; break;
      case "u": {
        const hex = inner.slice(i, i + 4);
        i += hex.length;
        const code = /^[0-9a-fA-F]{4}$/.test(hex) ? Number.parseInt(hex, 16) : undefined;
        out += code === undefined ? `\\u${hex}` : String.fromCodePoint(code);
        break;
      }
      default:
        out += `\\${next}`;
        break;
    }
  }
  return out;
}

function intShape(s: string): boolean {
  const body = s.startsWith("+") || s.startsWith("-") ? s.slice(1) : s;
  if (body.length === 0) return false;
  for (let i = 0; i < body.length; i += 1) {
    const c = body.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

function floatShape(s: string): boolean {
  const body = s.startsWith("+") || s.startsWith("-") ? s.slice(1) : s;
  if (body.length === 0) return false;
  const exponentAt = body.search(/[eE]/);
  const mantissa = exponentAt < 0 ? body : body.slice(0, exponentAt);
  const exponent = exponentAt < 0 ? undefined : body.slice(exponentAt + 1);
  if (mantissa.length === 0) return false;
  const dot = mantissa.indexOf(".");
  const digits = dot < 0 ? mantissa : mantissa.slice(0, dot) + mantissa.slice(dot + 1);
  if (dot < 0 && exponent === undefined) return false;
  if (digits.length === 0 || !/^[0-9]*$/.test(digits)) return false;
  if (exponent !== undefined) {
    const expBody = exponent.startsWith("+") || exponent.startsWith("-") ? exponent.slice(1) : exponent;
    if (expBody.length === 0 || !/^[0-9]+$/.test(expBody)) return false;
  }
  return true;
}

function sortEdits(edits: TextEdit[]): TextEdit[] {
  edits.sort((a, b) => b.range.start - a.range.start || b.range.end - a.range.end);
  return edits;
}

function guard(text: string): void {
  if (text.length > MAX_DOCUMENT_BYTES) {
    throw new SpliceError(`document text exceeds ${MAX_DOCUMENT_BYTES} bytes`, {
      limit: MAX_DOCUMENT_BYTES,
    });
  }
  if (text.length * 3 <= MAX_DOCUMENT_BYTES) return;
  const bytes = utf8Length(text);
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new SpliceError(`document text exceeds ${MAX_DOCUMENT_BYTES} bytes`, {
      len: bytes,
      limit: MAX_DOCUMENT_BYTES,
    });
  }
}

function requireKey(key: string): void {
  if (!isValidKey(key)) {
    throw new SpliceError(
      `"${key}" is not a writable key (^[A-Za-z0-9_-]{1,64}$)`,
      { key },
    );
  }
}

function clamp(text: string, offset: number): number {
  const bounded = Math.max(0, Math.min(offset, text.length));
  if (bounded > 0 && isLowSurrogate(text.charCodeAt(bounded)) && isHighSurrogate(text.charCodeAt(bounded - 1))) {
    return bounded - 1;
  }
  return bounded;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

const trimStartSpaces = (s: string): string => s.replace(/^[ \t]+/, "");
const trimEndSpaces = (s: string): string => s.replace(/[ \t]+$/, "");

function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isHighSurrogate(code) && i + 1 < s.length && isLowSurrogate(s.charCodeAt(i + 1))) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadCore, type CoreBindings, type ParsedDocument } from "../../kernel/src/wasm/index.js";

const PKG = new URL("../../kernel/src/wasm/pkg/", import.meta.url);

export interface HarnessCore extends CoreBindings {
  parseAsMaterialized(text: string): ParsedDocument;
}

let cached: Promise<HarnessCore> | undefined;

export function harnessCore(): Promise<HarnessCore> {
  cached ??= (async () => {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(
        await readFile(fileURLToPath(new URL("./ddd_core_bg.wasm", PKG))),
      );
    } catch {
      throw new Error(
        "the shared core is not built for the client: run `mise run wasm` " +
          "(the harness parses the converged text with the same Rust code the server runs, " +
          "so this assertion cannot be skipped — SPEC §9 M2)",
      );
    }
    const core = await loadCore(bytes);
    const normalizeDate = core.normalizeDate;
    return {
      ...core,
      parseAsMaterialized: (text: string) => {
        const parsed = core.parseDocument(text);
        return {
          title: parsed.title,
          fm: canonicalizeDates(parsed.fm, normalizeDate) as Record<string, unknown>,
          plugins: canonicalizeDates(parsed.plugins, normalizeDate) as Record<string, unknown>,
          fm_parse_error: parsed.fm_parse_error,
        } as ParsedDocument;
      },
    };
  })();
  return cached;
}

export function canonicalizeDates(value: unknown, normalizeDate: (input: string) => string): unknown {
  if (typeof value === "string") return normalizeDate(value);
  if (Array.isArray(value)) return value.map((item) => canonicalizeDates(item, normalizeDate));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = canonicalizeDates(inner, normalizeDate);
    }
    return out;
  }
  return value;
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === "number" && typeof right === "number") {
    return left === right || (Number.isNaN(left) && Number.isNaN(right));
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: number, length: number): string {
  let remaining = Math.floor(value);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out = (CROCKFORD[remaining % 32] ?? "0") + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

export function mintUlid(random: () => number, timeMs = Date.UTC(2026, 8, 24)): string {
  let tail = "";
  for (let index = 0; index < 16; index += 1) {
    tail += CROCKFORD[Math.floor(random() * 32)] ?? "0";
  }
  return encodeBase32(timeMs, 10) + tail;
}

export function ulidForIndex(index: number, salt = 0): string {
  let state = (index * 2654435761 + salt * 40503 + 1) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return mintUlid(next);
}

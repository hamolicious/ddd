/**
 * The shared-core side of the harness: parsing the converged text with the *same*
 * Rust code the server runs (SPEC §2, "parity by construction"), so the
 * materialization-equality assertion of SPEC §9 M2 compares like with like.
 *
 * Two things live here that the assertion cannot do without:
 *
 * 1. **Loading the Wasm core in Node** — `loadCore()` is the kernel's own loader;
 *    Node hands it the `.wasm` bytes (the browser resolves them itself).
 * 2. **Date canonicalization.** The server canonicalizes every date-looking
 *    string when it materializes (`docstore::materialize_parsed` →
 *    `canonicalize_dates`, SPEC §3.4) so lexicographic sort is chronological.
 *    `parse_document` does **not**, so a raw client parse of `date: 2026-9-3`
 *    disagrees with the server's `2026-09-03`. The harness applies the core's own
 *    `normalize_date` recursively before comparing — see the INTEGRATION note in
 *    this file.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadCore, type CoreBindings, type ParsedDocument } from "../../kernel/src/wasm/index.js";

const PKG = new URL("../../kernel/src/wasm/pkg/", import.meta.url);

export interface HarnessCore extends CoreBindings {
  /** `Date::normalize_str` — the server's canonical ISO-8601 form (SPEC §3.4). */
  normalizeDate(input: string): string;
  /** A parse canonicalized exactly the way materialization canonicalizes it. */
  parseAsMaterialized(text: string): ParsedDocument;
}

let cached: Promise<HarnessCore> | undefined;

/**
 * Load the Wasm core for the harness process.
 *
 * A missing package is a hard failure with the fix in the message: the
 * materialization half of the M2 gate cannot be faked, and silently skipping it
 * would turn a red gate green.
 */
export function harnessCore(): Promise<HarnessCore> {
  cached ??= (async () => {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(
        await readFile(fileURLToPath(new URL("./life_manager_core_bg.wasm", PKG))),
      );
    } catch {
      throw new Error(
        "the shared core is not built for the client: run `mise run wasm` " +
          "(the harness parses the converged text with the same Rust code the server runs, " +
          "so this assertion cannot be skipped — SPEC §9 M2)",
      );
    }
    const core = await loadCore(bytes);
    // `normalize_date` is exported by the Wasm ABI but is not part of the frozen
    // `CoreBindings` surface, so it is reached through the generated module here.
    // INTEGRATION (wasm area): if `CoreBindings` grows `normalizeDate`, drop this.
    const mod = await import("@life-manager/core-wasm");
    const normalizeDate = (input: string): string => mod.normalize_date(input);
    return {
      ...core,
      normalizeDate,
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

/** Recursively normalize date-looking strings, the way the server materializes. */
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

/** Structural equality for the shared-core value model (null/bool/num/str/list/map). */
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

// ---------------------------------------------------------------------------
// Client-mintable ULIDs (SPEC §3.5: ids are minted offline, by the client)
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encode `value` as `length` Crockford base32 characters, most significant first. */
function encodeBase32(value: number, length: number): string {
  let remaining = Math.floor(value);
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out = (CROCKFORD[remaining % 32] ?? "0") + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

/**
 * A valid ULID from a deterministic stream: 10 characters of timestamp plus 16 of
 * randomness. Deterministic on purpose — re-running the perf seeder mints the
 * same 5 000 ids, so seeding is idempotent and a failing convergence run can be
 * replayed against the same documents.
 */
export function mintUlid(random: () => number, timeMs = Date.UTC(2026, 8, 24)): string {
  let tail = "";
  for (let index = 0; index < 16; index += 1) {
    tail += CROCKFORD[Math.floor(random() * 32)] ?? "0";
  }
  return encodeBase32(timeMs, 10) + tail;
}

/** The nth deterministic ULID of a run: stable across processes and machines. */
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

/**
 * The bridge contract as **data**: `app/bridge_fixtures/*.json`, loaded for tests.
 *
 * Three implementations parse the same envelope — the Dart handlers in `app/lib/bridge/`,
 * the Rust serializer in `routes/shell.rs`, and the shim in `capabilities.ts` /
 * `shell-bridge.ts` / `app/src/boot/shell.ts`. None of them can see the others at build
 * time, so "we agree" is otherwise a claim rather than a check. The fixtures are the
 * shared artefact each side validates itself against: a renamed field, a changed error
 * code or a dropped method breaks a test on *every* side rather than producing a shell
 * that installs cleanly and then does nothing.
 *
 * **Test support only.** This module reads the filesystem (`node:fs`) and nothing in the
 * shipped kernel imports it — deliberately not re-exported from `runtime/index.ts`, so it
 * can never reach a browser bundle.
 *
 * INTEGRATION (shell-bridge / shell-updater): the Dart half of this pairing does not exist
 * yet — no file under `app/test/` reads `app/bridge_fixtures/`. See the note in the M5
 * report; the fixtures are laid out to be read directly
 * (`File('bridge_fixtures/envelope.json')` relative to the Flutter package root) and
 * `index.json` names every case file, so a Dart suite needs no hard-coded list.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** `app/bridge_fixtures/`, resolved from this file rather than from `process.cwd()`. */
export const BRIDGE_FIXTURES_DIR = fileURLToPath(
  new URL("../../../../app/bridge_fixtures/", import.meta.url),
);

/** One request/response pair, exactly as it crosses the handler (`BRIDGE.md` §2). */
export interface BridgeFixtureCase {
  readonly name: string;
  readonly note?: string;
  /** The bare method name within the capability; absent in `envelope.json`. */
  readonly method?: string;
  /** `true` when the *request* is deliberately not a well-formed envelope. */
  readonly malformed?: boolean;
  /** An object for every real call; anything at all for a malformed one. */
  readonly request: unknown;
  readonly response: BridgeFixtureResponse;
  /** `notifications.schedule`: the epoch-ms spelling of `params.atIso`. */
  readonly atMs?: number;
  /** `filesystem.export`: the same bytes in both spellings. */
  readonly bytes?: { readonly base64: string; readonly utf8: string };
}

export interface BridgeFixtureRequest {
  readonly v?: unknown;
  readonly id?: unknown;
  readonly capability?: unknown;
  readonly method?: unknown;
  readonly params?: Record<string, unknown>;
}

export interface BridgeFixtureResponse {
  readonly v: number;
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface BridgeFixtureFile {
  readonly capability?: string;
  readonly note?: string;
  readonly cases: readonly BridgeFixtureCase[];
}

export interface BridgeFixtureIndex {
  readonly bridgeVersion: number;
  readonly handler: string;
  readonly errorCodes: readonly string[];
  /** `capability.method`, sorted — what the shell registers and injects. */
  readonly methods: readonly string[];
  /** JavaScript spellings that map onto one registered method (`scheduled` → `list`). */
  readonly jsAliases: Readonly<Record<string, string>>;
  readonly capabilities: readonly string[];
  /** The capabilities reachable through `kernel.capabilities`; `auth`/`boot` are not. */
  readonly pluginFacing: readonly string[];
  readonly envelopeKeys: {
    readonly request: readonly string[];
    readonly response: readonly string[];
    readonly error: readonly string[];
  };
  /** Case files, each a {@link BridgeFixtureFile}. */
  readonly cases: readonly string[];
  /** Everything else in the directory. */
  readonly other: readonly string[];
}

/** One row of the `window.shell` detection table (`BRIDGE.md` §3). */
export interface ShellDetectionCase {
  readonly name: string;
  readonly note?: string;
  /** What to put on `globalThis.shell`; ignored when `absent`. */
  readonly shell: unknown;
  /** `true` means "no `window.shell` at all" — a plain browser tab. */
  readonly absent?: boolean;
  readonly detected: boolean;
  readonly bridgeVersion?: number;
  /** `null` means "must be ignored"; a string means "must be exactly this". */
  readonly serverBaseUrl?: string | null;
  /** Whether the shell, rather than the page's cookie, holds the session. */
  readonly ownsSession?: boolean;
}

export interface WindowShellFixture {
  readonly note?: string;
  readonly injected: {
    readonly version: number;
    readonly bridgeVersion: number;
    readonly platform: string;
    readonly serverBaseUrl: string;
    readonly bearerToken: string;
    readonly capabilities: readonly string[];
    readonly methods: readonly string[];
    /** The JavaScript members `bootstrapScript` defines, dotted for nesting. */
    readonly functions: readonly string[];
  };
  /**
   * The "a new bundle is staged" signal (`app/BRIDGE.md` §5, §7) — not a bridge method:
   * the shell `evaluateJavascript`s a dispatch and the page listens.
   *
   * It is in the fixture because the two halves were written months apart: the listeners
   * shipped here in M5 and nothing in the Dart shell fired them, so the contract was dead
   * on a device while both sides' own unit tests passed. A shared string makes that a
   * failing test instead of a code review.
   */
  readonly updateReady: {
    readonly note?: string;
    readonly event: string;
    readonly functionSpelling: string;
    readonly detailKey: string;
    /** Exactly what the shell evaluates, for `scriptVersion`. */
    readonly script: string;
    readonly scriptVersion: string;
  };
  /** "Files in the chosen folder changed" (`app/BRIDGE.md` §4.5) — a dispatch, like `updateReady`. */
  readonly folderChanged: {
    readonly note?: string;
    readonly event: string;
    readonly detailKey: string;
    readonly script: string;
    readonly scriptPaths: readonly string[];
  };
  readonly detection: readonly ShellDetectionCase[];
}

export interface ManifestFixtureFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ManifestFixture {
  readonly note?: string;
  readonly valid: {
    readonly bundle_version: string;
    readonly min_bridge_version: number;
    readonly index_csp: string;
    readonly files: readonly ManifestFixtureFile[];
  };
  readonly synthesized: readonly string[];
  readonly excluded: readonly string[];
  readonly verify: readonly {
    readonly name: string;
    readonly utf8: string;
    readonly base64?: string;
    readonly sha256: string;
    readonly size: number;
  }[];
  readonly invalid: readonly { readonly name: string; readonly manifest: unknown }[];
  readonly unsafePaths: readonly string[];
}

/** Read one fixture file. Throws with the path when it is missing or unparseable. */
export function readFixture<T>(file: string): T {
  const path = `${BRIDGE_FIXTURES_DIR}${file}`;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`bridge fixture ${file} is missing (${path})`, { cause });
  }
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new Error(`bridge fixture ${file} is not valid JSON`, { cause });
  }
}

export const fixtureIndex = (): BridgeFixtureIndex => readFixture<BridgeFixtureIndex>("index.json");

/** One case by name, so a test names what it is asserting and fails loudly if it moved. */
export function fixtureCase(file: BridgeFixtureFile, name: string): BridgeFixtureCase {
  const found = file.cases.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(
      `no bridge fixture case named "${name}" (have: ${file.cases.map((c) => c.name).join(", ")})`,
    );
  }
  return found;
}

/** A case's request as an envelope. Never call it on a `malformed` case. */
export function fixtureRequest(entry: BridgeFixtureCase): BridgeFixtureRequest {
  if (typeof entry.request !== "object" || entry.request === null) {
    throw new Error(`bridge fixture case "${entry.name}" has a non-object request`);
  }
  return entry.request as BridgeFixtureRequest;
}

/** A case's `params`, which is always an object on the wire (`BRIDGE.md` §2). */
export function fixtureParams(entry: BridgeFixtureCase): Record<string, unknown> {
  return fixtureRequest(entry).params ?? {};
}

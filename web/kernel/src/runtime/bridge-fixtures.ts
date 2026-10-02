import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BRIDGE_FIXTURES_DIR = fileURLToPath(
  new URL("../../../../app/bridge_fixtures/", import.meta.url),
);

export interface BridgeFixtureCase {
  readonly name: string;
  readonly note?: string;
  readonly method?: string;
  readonly malformed?: boolean;
  readonly request: unknown;
  readonly response: BridgeFixtureResponse;
  readonly atMs?: number;
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
  readonly methods: readonly string[];
  readonly jsAliases: Readonly<Record<string, string>>;
  readonly capabilities: readonly string[];
  readonly pluginFacing: readonly string[];
  readonly envelopeKeys: {
    readonly request: readonly string[];
    readonly response: readonly string[];
    readonly error: readonly string[];
  };
  readonly cases: readonly string[];
  readonly other: readonly string[];
}

export interface ShellDetectionCase {
  readonly name: string;
  readonly note?: string;
  readonly shell: unknown;
  readonly absent?: boolean;
  readonly detected: boolean;
  readonly bridgeVersion?: number;
  readonly serverBaseUrl?: string | null;
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
    readonly functions: readonly string[];
  };
  readonly updateReady: {
    readonly note?: string;
    readonly event: string;
    readonly functionSpelling: string;
    readonly detailKey: string;
    readonly script: string;
    readonly scriptVersion: string;
  };
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

export function fixtureCase(file: BridgeFixtureFile, name: string): BridgeFixtureCase {
  const found = file.cases.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(
      `no bridge fixture case named "${name}" (have: ${file.cases.map((c) => c.name).join(", ")})`,
    );
  }
  return found;
}

export function fixtureRequest(entry: BridgeFixtureCase): BridgeFixtureRequest {
  if (typeof entry.request !== "object" || entry.request === null) {
    throw new Error(`bridge fixture case "${entry.name}" has a non-object request`);
  }
  return entry.request as BridgeFixtureRequest;
}

export function fixtureParams(entry: BridgeFixtureCase): Record<string, unknown> {
  return fixtureRequest(entry).params ?? {};
}

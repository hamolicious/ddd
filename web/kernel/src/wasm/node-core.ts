/**
 * Loading the shared core outside a browser — Vitest and the Node harness.
 *
 * The generated package targets `web`: `init()` with no argument resolves the
 * `.wasm` relative to `import.meta.url` through `fetch`, which Node will not do
 * for a file URL. So the bytes are read and handed in explicitly, exactly as
 * `scripts/wasm-smoke.mjs` does.
 *
 * It also answers "has anyone run `mise run wasm` in this checkout?", because
 * `npm run typecheck` and `npm run test` must both pass in a clean tree that
 * never has (web/CONTRACTS.md) — tests that need the real core skip themselves
 * when it is absent, rather than failing on a missing artifact.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadCore, type CoreBindings } from "./index.js";

/** Absolute path of the generated `.wasm`, built or not. */
export function coreArtifactPath(): string {
  return fileURLToPath(new URL("./pkg/ddd_core_bg.wasm", import.meta.url));
}

/** `true` when `mise run wasm` has produced the artifact in this checkout. */
export function coreArtifactExists(): boolean {
  return existsSync(coreArtifactPath());
}

/** Load the shared core in Node. Idempotent — `loadCore` caches. */
export async function loadCoreForNode(): Promise<CoreBindings> {
  const bytes = await readFile(coreArtifactPath());
  return await loadCore(bytes);
}

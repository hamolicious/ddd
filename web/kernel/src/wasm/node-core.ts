import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadCore, type CoreBindings } from "./index.js";

export function coreArtifactPath(): string {
  return fileURLToPath(new URL("./pkg/ddd_core_bg.wasm", import.meta.url));
}

export function coreArtifactExists(): boolean {
  return existsSync(coreArtifactPath());
}

export async function loadCoreForNode(): Promise<CoreBindings> {
  const bytes = await readFile(coreArtifactPath());
  return await loadCore(bytes);
}

#!/usr/bin/env node
/**
 * Compose a plugin registry directory out of already-built plugins.
 *
 * **Why this exists.** In M3 the registry *is* the directory the server scans
 * (`PLUGINS_DIR`); enable/disable and the approval flow are M4 endpoints, and
 * `DISABLE_PLUGINS` is all-or-nothing (SPEC §6.1). So "disable the built-in editor and
 * enable `alt-editor` instead" — the M3 acceptance criterion — is expressed the only way
 * M3 can express it: a directory that contains the one and not the other. This script
 * builds that directory, and the acceptance test points a server at it.
 *
 * It copies rather than symlinks: the server refuses a symlinked plugin path
 * (`plugins.rs`, traversal hardening), and a test that quietly depended on symlinks
 * following would be testing the wrong server.
 *
 * ```
 * node web/scripts/compose-plugins.mjs <outDir> [--exclude=id,id] [--include-examples=id,id]
 * ```
 *
 * With no flags it is a copy of the base distribution.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseDist = resolve(web, "..", "plugins", "base", "dist");
const examplesDist = resolve(web, "..", "plugins", "examples", "dist");

const args = process.argv.slice(2);
const positional = args.filter((arg) => !arg.startsWith("--"));
const flag = (name) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3).split(",").filter(Boolean) : [];
};

const outDir = positional[0];
if (!outDir) {
  console.error("usage: compose-plugins.mjs <outDir> [--exclude=id,…] [--include-examples=id,…]");
  process.exit(1);
}
const out = resolve(outDir);
const exclude = new Set(flag("exclude"));
const examples = flag("include-examples");

for (const [label, dir] of [
  ["base", baseDist],
  ...(examples.length > 0 ? [["examples", examplesDist]] : []),
]) {
  if (!existsSync(dir)) {
    console.error(`${label} distribution not built: ${dir} does not exist`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const copied = [];
for (const id of readdirSync(baseDist).sort()) {
  if (exclude.has(id)) continue;
  cpSync(join(baseDist, id), join(out, id), { recursive: true });
  copied.push(id);
}
for (const id of examples) {
  const source = join(examplesDist, id);
  if (!existsSync(source)) {
    console.error(`example plugin not built: ${source}`);
    process.exit(1);
  }
  cpSync(source, join(out, id), { recursive: true });
  copied.push(`${id} (example)`);
}

console.log(`composed ${copied.length} plugins into ${out}`);
if (exclude.size > 0) console.log(`excluded: ${[...exclude].join(", ")}`);
console.log(copied.join("\n"));

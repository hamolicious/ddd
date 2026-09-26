#!/usr/bin/env node
/**
 * Build the example plugins in `plugins/examples/` into `plugins/examples/dist/`.
 *
 * Same layout, same reference Vite config and same externals as the base
 * distribution — the *only* difference is the source directory, which is the whole
 * point: `plugins/examples/alt-editor` is built with exactly the tooling a third
 * party would use, and the server cannot tell the two directories apart.
 *
 * `plugins/examples/dist` is **not** served directly. `scripts/compose-plugins.mjs`
 * builds a registry directory out of a chosen subset of base plus examples; that is
 * how the M3 acceptance test swaps `editor` for `alt-editor` without a server feature
 * that does not exist until M4 (the registry *is* the directory — see
 * `backend/CONTRACTS.md`, area server-static).
 *
 * Usage: `node web/scripts/build-examples.mjs [id …]`
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { pluginConfig } from "../../plugins/base/_shared/vite.plugin-config.mjs";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = resolve(web, "..", "plugins", "examples");
const distRoot = join(examplesDir, "dist");

const requested = process.argv.slice(2);

const plugins = readdirSync(examplesDir)
  .filter((name) => !name.startsWith("_") && !name.startsWith(".") && name !== "dist")
  .filter((name) => statSync(join(examplesDir, name)).isDirectory())
  // A *frontend* plugin source directory is one with a manifest, exactly as in
  // `build-plugins.mjs`. `examples/hello-backend` is a Rust-only host fixture — no manifest,
  // no frontend half, built by `build-wasm-plugins.mjs` — and reading a manifest it has
  // never had crashed this script *after* it had written every real example's output, so
  // the documented e2e setup step exited non-zero while appearing to have worked.
  .filter((name) => existsSync(join(examplesDir, name, "manifest.json")))
  .filter((name) => requested.length === 0 || requested.includes(name))
  .sort();

if (plugins.length === 0) {
  console.error(`no example plugins in ${examplesDir}`);
  process.exit(1);
}

if (requested.length === 0) rmSync(distRoot, { recursive: true, force: true });

for (const id of plugins) {
  const root = join(examplesDir, id);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (manifest.id !== id) {
    console.error(`! ${id}: manifest id is "${manifest.id}" — the directory name is the plugin id`);
    process.exit(1);
  }
  const outDir = join(distRoot, manifest.id, manifest.version);
  await build(pluginConfig({ root, outDir, tailwind: manifest["x-tailwind"] === true, resolveFrom: web }));
  console.log(`+ ${manifest.id}@${manifest.version} -> ${outDir}`);
}

console.log(`\n${plugins.length} example plugin(s) built into ${distRoot}`);

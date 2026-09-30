#!/usr/bin/env node
/**
 * Build every plugin in `plugins/base/` into the layout the server serves.
 *
 * ```
 * plugins/base/dist/<id>/<version>/
 * ├── manifest.json
 * └── frontend/
 *     ├── index.mjs
 *     ├── index.d.ts     the exports' types: `declare module "plugin:<id>"`
 *     └── style.css
 * ```
 *
 * That is deliberately the *installed* layout, not a build directory: `/plugins/<id>/<version>/…`
 * maps to it one-to-one, which is what makes plugin URLs immutable and cacheable forever
 * (SPEC §8), and it is the same shape M4's zip installer will extract into. Nothing about
 * the server changes when installs become real — only who writes the directory.
 *
 * Run from anywhere: `node web/scripts/build-plugins.mjs [id …]`, or `mise run plugins`.
 * Vite and its plugins resolve from `web/node_modules`; the plugin sources themselves
 * import only relative files and the externalized runtime layer, so they need no
 * `node_modules` of their own.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { pluginConfig } from "../../plugins/base/_shared/vite.plugin-config.mjs";
import { buildPluginDts } from "./build-plugin-dts.mjs";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseDir = resolve(web, "..", "plugins", "base");
const distRoot = join(baseDir, "dist");

const requested = process.argv.slice(2);

const plugins = readdirSync(baseDir)
  .filter((name) => !name.startsWith("_") && name !== "dist")
  .filter((name) => statSync(join(baseDir, name)).isDirectory())
  // A plugin source directory is one with a manifest. Anything else here is not a plugin
  // and is skipped rather than crashing the build on a missing `manifest.json` — the case
  // that found this was `PLUGIN_STAGING_DIR`, which defaults to `<PLUGINS_DIR>.staging`
  // and therefore lands as a sibling of the sources when `PLUGINS_DIR` is the default.
  .filter((name) => existsSync(join(baseDir, name, "manifest.json")))
  .filter((name) => requested.length === 0 || requested.includes(name))
  .sort();

if (plugins.length === 0) {
  console.error(`no plugins to build in ${baseDir}${requested.length ? ` matching ${requested.join(", ")}` : ""}`);
  process.exit(1);
}

// A full run replaces the whole tree, so a renamed or removed plugin does not linger as
// an installed one. A partial run (ids given) leaves the others alone.
if (requested.length === 0) rmSync(distRoot, { recursive: true, force: true });

const built = [];
for (const id of plugins) {
  const root = join(baseDir, id);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (!manifest.frontend?.module) {
    console.log(`- ${id}: no frontend half, skipped`);
    continue;
  }
  if (manifest.id !== id) {
    console.error(`! ${id}: manifest id is "${manifest.id}" — the directory name is the plugin id`);
    process.exit(1);
  }
  const outDir = join(distRoot, manifest.id, manifest.version);
  await build(pluginConfig({ root, outDir, resolveFrom: web }));
  // The types of its exports, as `declare module "plugin:<id>"` (`frontend/index.d.ts`).
  await buildPluginDts({ root, outDir });
  built.push(`${manifest.id}@${manifest.version}`);
  console.log(`+ ${manifest.id}@${manifest.version} -> ${outDir}`);
}

console.log(`\n${built.length} plugin${built.length === 1 ? "" : "s"} built into ${distRoot}`);
console.log("The server serves this directory as PLUGINS_DIR (backend/CONTRACTS.md, area server-static).");

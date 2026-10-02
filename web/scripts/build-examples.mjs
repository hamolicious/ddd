#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { pluginConfig } from "../../plugins/base/_shared/vite.plugin-config.mjs";
import { buildPluginDts } from "./build-plugin-dts.mjs";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const examplesDir = resolve(web, "..", "plugins", "examples");
const distRoot = join(examplesDir, "dist");

const requested = process.argv.slice(2);

const plugins = readdirSync(examplesDir)
  .filter((name) => !name.startsWith("_") && !name.startsWith(".") && name !== "dist")
  .filter((name) => statSync(join(examplesDir, name)).isDirectory())
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
  await build(pluginConfig({ root, outDir, resolveFrom: web }));
  await buildPluginDts({ root, outDir });
  console.log(`+ ${manifest.id}@${manifest.version} -> ${outDir}`);
}

console.log(`\n${plugins.length} example plugin(s) built into ${distRoot}`);

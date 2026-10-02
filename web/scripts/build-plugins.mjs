#!/usr/bin/env node

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
  .filter((name) => existsSync(join(baseDir, name, "manifest.json")))
  .filter((name) => requested.length === 0 || requested.includes(name))
  .sort();

if (plugins.length === 0) {
  console.error(`no plugins to build in ${baseDir}${requested.length ? ` matching ${requested.join(", ")}` : ""}`);
  process.exit(1);
}

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
  await buildPluginDts({ root, outDir });
  built.push(`${manifest.id}@${manifest.version}`);
  console.log(`+ ${manifest.id}@${manifest.version} -> ${outDir}`);
}

console.log(`\n${built.length} plugin${built.length === 1 ? "" : "s"} built into ${distRoot}`);
console.log("The server serves this directory as PLUGINS_DIR (backend/CONTRACTS.md, area server-static).");

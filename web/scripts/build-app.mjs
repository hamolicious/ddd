#!/usr/bin/env node
/**
 * Build the PWA, in the one order that works:
 *
 * 1. **runtime layer** — one chunk per blessed specifier, plus
 *    `runtime-manifest.json` for the server's import map;
 * 2. **app bundle** — with those specifiers left external, so kernel and plugins
 *    share the chunks from step 1;
 * 3. **service worker** — last, because its precache list is read from steps 1–2.
 *
 * Each step is a separate Vite build with its own config; this script only clears
 * `app/dist` first (all three write into it) and runs them in sequence.
 */

import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(web, "app", "dist");

rmSync(dist, { recursive: true, force: true });

for (const config of ["vite.runtime.config.ts", "vite.app.config.ts", "vite.sw.config.ts"]) {
  console.log(`\n=== ${config} ===`);
  await build({ configFile: join(web, config) });
}

console.log(`\napp bundle: ${dist}`);

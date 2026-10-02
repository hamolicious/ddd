#!/usr/bin/env node

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

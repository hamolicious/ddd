/**
 * Standalone build for one plugin — copy this next to your `manifest.json`, install
 * `vite` and `typescript`, and run `vite build`.
 *
 * ```
 * my-plugin/
 * ├── manifest.json
 * ├── vite.config.mjs      ← this file
 * └── src/
 *     ├── index.tsx        ← `export default function activate(kernel) { … }`
 *     └── style.css
 * ```
 *
 * Types: fetch `/kernel.d.ts` from your server and reference it, or add
 * `@ddd/kernel` to `devDependencies` once it is published. Both are the same
 * file; the served one is what the running server actually implements, which is the one
 * that matters when a workspace is behind.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { pluginConfig } from "./vite.plugin-config.mjs";

export default pluginConfig({ root: dirname(fileURLToPath(import.meta.url)) });

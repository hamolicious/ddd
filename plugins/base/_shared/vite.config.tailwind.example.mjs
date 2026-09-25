/*
 * Tailwind variant of vite.config.example.mjs. Install vite, typescript,
 * tailwindcss, @tailwindcss/postcss and postcss in this plugin, then run vite build.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { pluginConfig } from "./vite.plugin-config.mjs";

const root = dirname(fileURLToPath(import.meta.url));

export default pluginConfig({
  root,
  tailwind: true,
  // Standalone plugins resolve Tailwind from their own node_modules.
  resolveFrom: root,
});

/*
 * The reference plugin build (SPEC §6.4), copied from the Life Manager repository into
 * tools/. `vite build` writes the installed layout into dist/: manifest.json,
 * frontend/index.mjs and frontend/style.css.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { pluginConfig } from "./tools/vite.plugin-config.mjs";

export default pluginConfig({ root: dirname(fileURLToPath(import.meta.url)) });

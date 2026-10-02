import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { pluginConfig } from "./vite.plugin-config.mjs";

export default pluginConfig({ root: dirname(fileURLToPath(import.meta.url)) });

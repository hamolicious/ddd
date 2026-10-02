import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { pluginConfig } from "./vite.plugin-config.mjs";

const root = dirname(fileURLToPath(import.meta.url));

export default pluginConfig({
  root,
  tailwind: true,
  resolveFrom: root,
});

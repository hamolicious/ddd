/**
 * `emoji`'s build step, run by the reference config after the module is built
 * (`_shared/vite.plugin-config.mjs`: a plugin's own `build.mjs`).
 *
 * Packs the set pinned in `gemoji.json` next to the module:
 *
 * ```
 * frontend/gemoji/
 * ├── index.json      [emoji, shortcodes, words] per emoji, in gemoji's order
 * └── LICENSE         gemoji's MIT licence
 * ```
 *
 * `shortcodes` and `words` are space-separated: the first shortcode is the one the
 * autocomplete writes, `words` (tags and description) only help it find one.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { extract, fetchTarball } from "../_shared/npm-tarball.mjs";

/** @param {{ root: string, outDir: string, resolveFrom: string }} options */
export default async function build({ root, outDir, resolveFrom }) {
  const pin = JSON.parse(readFileSync(join(root, "gemoji.json"), "utf8"));
  const spec = `${pin.package}@${pin.version}`;
  const cache = join(resolveFrom, "node_modules", ".cache", "lm-emoji");
  const tarball = fetchTarball(spec, pin.integrity, cache, "gemoji.json");

  // `index.js` is an ES module with no imports: one exported array literal.
  const source = extract(tarball, "index.js").toString("utf8");
  const { gemoji } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  if (!Array.isArray(gemoji) || gemoji.length === 0) throw new Error(`${spec}: index.js exports no gemoji`);

  const seen = new Set();
  const index = gemoji.map(({ emoji, names, tags, description }) => {
    for (const name of names) {
      if (!/^[a-z0-9_+-]+$/.test(name)) throw new Error(`${spec}: shortcode ${JSON.stringify(name)} is not [a-z0-9_+-]`);
      if (seen.has(name)) throw new Error(`${spec}: shortcode ${name} is used twice`);
      seen.add(name);
    }
    return [emoji, names.join(" "), [...tags, description].join(" ").toLowerCase()];
  });

  const dir = join(outDir, "frontend", "gemoji");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.json"), JSON.stringify(index));
  writeFileSync(join(dir, "LICENSE"), extract(tarball, "license"));
}

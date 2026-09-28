/**
 * `icons`' build step, run by the reference config after the module is built
 * (`_shared/vite.plugin-config.mjs`: a plugin's own `build.mjs`).
 *
 * Packs the icon set pinned in `tabler.json` next to the module:
 *
 * ```
 * frontend/tabler/
 * ├── index.json      every icon's name, category and tags, and the suggested few: for search
 * ├── <c>.json        the drawings of every icon whose name starts with `c`
 * └── LICENSE         Tabler's MIT licence, which travels with the drawings
 * ```
 *
 * Drawings are sharded by first character so a tree showing three icons downloads a
 * few shards, not the whole set; search needs only `index.json`. Every Tabler node is a
 * `<path>`, so a drawing is its paths: a `d` string, or `{ d, fill, … }` for the few that
 * carry attributes. Filled variants are separate icons named `<name>-filled`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { extract, fetchTarball } from "../_shared/npm-tarball.mjs";

/** @param {{ root: string, outDir: string, resolveFrom: string }} options */
export default async function build({ root, outDir, resolveFrom }) {
  const pin = JSON.parse(readFileSync(join(root, "tabler.json"), "utf8"));
  const spec = `${pin.package}@${pin.version}`;
  const cache = join(resolveFrom, "node_modules", ".cache", "lm-icons");
  const tarball = fetchTarball(spec, pin.integrity, cache, "tabler.json");
  const json = (path) => JSON.parse(extract(tarball, path).toString("utf8"));

  const outline = json("tabler-nodes-outline.json");
  const filled = json("tabler-nodes-filled.json");
  const meta = json("icons.json");

  /** name → drawing */
  const drawings = new Map();
  /** [name, category index, tags] */
  const index = [];
  const categories = [];
  const categoryOf = (name) => {
    const category = meta[name]?.category || "Other";
    let at = categories.indexOf(category);
    if (at === -1) at = categories.push(category) - 1;
    return at;
  };
  const drawing = (name, nodes) =>
    nodes.map(([tag, attributes]) => {
      if (tag !== "path") throw new Error(`${spec}: ${name} has a <${tag}>; only <path> is packed`);
      const { d, ...rest } = attributes;
      return Object.keys(rest).length === 0 ? d : { d, ...rest };
    });

  for (const [name, nodes] of Object.entries(outline)) {
    if (name.endsWith("-filled")) throw new Error(`${spec}: outline icon ${name} collides with the filled naming`);
    drawings.set(name, drawing(name, nodes));
    index.push([name, categoryOf(name), (meta[name]?.tags ?? []).map(String).join(" ")]);
  }
  for (const [name, nodes] of Object.entries(filled)) {
    const id = `${name}-filled`;
    drawings.set(id, drawing(id, nodes));
    index.push([id, categoryOf(name), ["filled", ...(meta[name]?.tags ?? []).map(String)].join(" ")]);
  }
  index.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const missing = pin.suggested.filter((name) => !drawings.has(name));
  if (missing.length) throw new Error(`tabler.json suggests icons ${spec} does not have: ${missing.join(", ")}`);

  const dir = join(outDir, "frontend", "tabler");
  mkdirSync(dir, { recursive: true });
  const shards = new Map();
  for (const [name, paths] of drawings) {
    const key = name[0];
    if (!/^[a-z0-9]$/.test(key)) throw new Error(`${spec}: ${name} does not start with [a-z0-9]`);
    if (!shards.has(key)) shards.set(key, {});
    shards.get(key)[name] = paths;
  }
  for (const [key, shard] of shards) writeFileSync(join(dir, `${key}.json`), JSON.stringify(shard));
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify({ version: pin.version, categories, suggested: pin.suggested, icons: index }),
  );
  writeFileSync(join(dir, "LICENSE"), extract(tarball, "LICENSE"));
  console.log(`  icons: ${drawings.size} Tabler ${pin.version} icons in ${shards.size} shards`);
}

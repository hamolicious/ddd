#!/usr/bin/env -S npx vite-node
/**
 * Check the dependency graph of the plugins in this repository (`@kernel` 3.0) — the
 * failures the server would otherwise report only at load time, as a list of lines here.
 *
 * For every plugin in `plugins/base/` and `plugins/examples/`:
 *
 * 1. each id under `dependencies` and `optionalDependencies` is a plugin in the repo (or
 *    one a repo plugin stands in for with `provides`), and its version satisfies the range;
 * 2. the graph over both kinds of dependency has no cycle (both order the load);
 * 3. every static `import … from "plugin:<id>"` in the plugin's code — its `src/` and the
 *    `plugins/base/_shared` files it reaches — names a plugin listed under `dependencies`;
 * 4. no plugin statically imports an `optionalDependencies` id: an optional dependency is
 *    only ever reached with `kernel.plugins.optional(id)`, because a static import of an
 *    absent plugin fails the whole module. Type-only imports (`import type`) are erased and
 *    are allowed for either kind of dependency.
 *
 * Run through vite-node (it reads the kernel's own `satisfies` and manifest validator
 * from TypeScript): `npm run check:plugins` in `web/`, or
 * `npx vite-node scripts/check-plugin-graph.mjs [plugin-tree …]`. Exits 1 with one line
 * per problem.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePluginRef, satisfies, validateManifest } from "../kernel-api/src/manifest.ts";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(web, "..");
/** The plugin trees to check: the arguments, or the repository's two. */
const trees = process.argv.length > 2
  ? process.argv.slice(2).map((dir) => resolve(dir))
  : [join(repo, "plugins", "base"), join(repo, "plugins", "examples")];

/** @type {Map<string, { dir: string, manifest: any }>} */
const plugins = new Map();
const problems = [];
const say = (id, message) => problems.push(`${id}: ${message}`);

for (const tree of trees) {
  if (!existsSync(tree)) continue;
  for (const name of readdirSync(tree).sort()) {
    const dir = join(tree, name);
    if (name.startsWith("_") || name.startsWith(".") || name === "dist" || !statSync(dir).isDirectory()) continue;
    const path = join(dir, "manifest.json");
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    for (const problem of validateManifest(manifest)) say(name, `manifest ${problem.field || "(root)"} ${problem.message}`);
    if (plugins.has(manifest.id)) say(manifest.id, `defined twice (${relative(repo, plugins.get(manifest.id).dir)} and ${relative(repo, dir)})`);
    plugins.set(manifest.id, { dir, manifest });
  }
}

/** The version `id` answers with: its own, or the one a stand-in provides for it. */
function candidates(id) {
  const found = [];
  const own = plugins.get(id);
  if (own) found.push({ by: id, version: own.manifest.version });
  for (const [other, { manifest }] of plugins) {
    const ref = typeof manifest.provides === "string" ? parsePluginRef(manifest.provides) : undefined;
    if (ref?.id === id) found.push({ by: other, version: ref.version });
  }
  return found;
}

// 1. Existence and ranges.
for (const [id, { manifest }] of plugins) {
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (dep === id) {
        say(id, `lists itself under ${field}`);
        continue;
      }
      const options = candidates(dep);
      if (options.length === 0) {
        // An optional dependency may name a plugin that lives outside this repository.
        if (field === "dependencies") say(id, `depends on "${dep}", which is not a plugin in this repository`);
        continue;
      }
      if (!options.some((option) => satisfies(option.version, range))) {
        const have = options.map((o) => (o.by === dep ? o.version : `${o.version} (provided by ${o.by})`)).join(", ");
        say(id, `${field}.${dep} is "${range}", but the repository has ${have}`);
      }
    }
  }
}

// 2. Cycles, over both kinds of edge (resolved through `provides` to real plugins).
{
  const edges = new Map();
  for (const [id, { manifest }] of plugins) {
    const targets = new Set();
    for (const dep of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]) {
      for (const option of candidates(dep)) if (option.by !== id) targets.add(option.by);
    }
    edges.set(id, [...targets].sort());
  }
  const state = new Map(); // id → "visiting" | "done"
  const stack = [];
  const reported = new Set();
  const visit = (id) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      const cycle = [...stack.slice(stack.indexOf(id)), id];
      const key = [...cycle].slice(0, -1).sort().join(",");
      if (!reported.has(key)) {
        reported.add(key);
        problems.push(`cycle: ${cycle.join(" -> ")}`);
      }
      return;
    }
    state.set(id, "visiting");
    stack.push(id);
    for (const next of edges.get(id) ?? []) visit(next);
    stack.pop();
    state.set(id, "done");
  };
  for (const id of [...plugins.keys()].sort()) visit(id);
}

// 3 and 4. Static `plugin:` imports against the manifest.
const IMPORT = /(?:^|[;\n])\s*(import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/g;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

function resolveRelative(from, specifier) {
  const base = resolve(dirname(from), specifier);
  const stem = base.replace(/\.(?:m?js|jsx)$/, "");
  for (const candidate of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mjs`, `${stem}.js`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Every file the plugin's code reaches through relative imports, from `src/` outwards. */
function reachable(dir) {
  const src = join(dir, "src");
  if (!existsSync(src)) return [];
  const seen = new Set();
  const queue = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE.test(name) && !/\.test\.[jt]sx?$/.test(name)) queue.push(full);
    }
  };
  walk(src);
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT)) {
      const specifier = match[3];
      if (!specifier.startsWith(".")) continue;
      const target = resolveRelative(file, specifier);
      if (target && SOURCE.test(target) && !seen.has(target)) queue.push(target);
    }
  }
  return [...seen];
}

for (const [id, { dir, manifest }] of plugins) {
  const required = new Set(Object.keys(manifest.dependencies ?? {}));
  const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
  for (const file of reachable(dir)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT)) {
      const specifier = match[3];
      if (!specifier.startsWith("plugin:")) continue;
      const target = specifier.slice("plugin:".length);
      const typeOnly = match[2] !== undefined;
      const where = relative(repo, file);
      if (target === id) {
        // A shared helper may name its host's types (`_shared/text-mark.ts` → `plugin:editor`);
        // a value import of yourself would be a second instance of your own module.
        if (!typeOnly) say(id, `${where} imports its own "plugin:${id}"; import the file instead`);
      } else if (typeOnly) {
        if (!required.has(target) && !optional.has(target)) {
          say(id, `${where} imports types from "plugin:${target}", which is not in dependencies or optionalDependencies`);
        }
      } else if (optional.has(target) && !required.has(target)) {
        say(id, `${where} statically imports "plugin:${target}", an optional dependency; use kernel.plugins.optional("${target}")`);
      } else if (!required.has(target)) {
        say(id, `${where} imports "plugin:${target}", which is not listed under dependencies`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`plugin graph: ${problems.length} problem${problems.length === 1 ? "" : "s"}`);
  for (const line of problems) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`plugin graph: ${plugins.size} plugins, dependencies resolve, no cycles, imports declared`);

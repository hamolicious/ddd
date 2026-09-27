/**
 * `syntax-highlight`'s build step, run by the reference config after the module is built
 * (`_shared/vite.plugin-config.mjs`: a plugin's own `build.mjs`).
 *
 * Puts what the plugin serves next to its module:
 *
 * ```
 * frontend/
 * ├── tree-sitter.wasm              the runtime web-tree-sitter loads
 * └── languages/
 *     ├── index.json                 id → download size, for Settings
 *     └── <id>/grammar.wasm, highlights.scm
 * ```
 *
 * Grammars come from npm, pinned in `languages.json`. They are fetched with `npm pack`
 * rather than installed, because installing would run each package's native build — we
 * only want the prebuilt `.wasm` and the queries inside the tarball. Each tarball is
 * checked against its pinned `integrity` and kept in `node_modules/.cache`, so a rebuild
 * does not touch the network.
 *
 * Then every grammar is loaded, and its query compiled, in the same web-tree-sitter the
 * module bundles: a grammar built for another ABI, or a query naming a node the grammar
 * does not have, fails the build here instead of failing quietly on someone's phone.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** @param {{ root: string, outDir: string, resolveFrom: string }} options */
export default async function build({ root, outDir, resolveFrom }) {
  const require = createRequire(join(resolveFrom, "noop.cjs"));
  const catalog = JSON.parse(readFileSync(join(root, "languages.json"), "utf8")).languages;
  const byId = new Map(catalog.map((language) => [language.id, language]));
  const cache = join(resolveFrom, "node_modules", ".cache", "lm-grammars");
  mkdirSync(cache, { recursive: true });

  const frontend = join(outDir, "frontend");
  const runtimeWasm = join(require.resolve("web-tree-sitter"), "..", "web-tree-sitter.wasm");
  copyFileSync(runtimeWasm, join(frontend, "tree-sitter.wasm"));

  const tarballs = new Map();
  const tarballOf = (language) => {
    const spec = `${language.package}@${language.version}`;
    let file = tarballs.get(spec);
    if (!file) {
      file = fetchTarball(spec, language.integrity, cache);
      tarballs.set(spec, file);
    }
    return file;
  };

  const sizes = {};
  for (const language of catalog) {
    const dir = join(frontend, "languages", language.id);
    mkdirSync(dir, { recursive: true });
    const wasm = extract(tarballOf(language), language.wasm);
    writeFileSync(join(dir, "grammar.wasm"), wasm);

    const queries = language.highlights.map((entry) => {
      const [owner, path] = entry.includes(":") ? entry.split(":") : [language.id, entry];
      const from = byId.get(owner);
      if (!from) throw new Error(`${language.id}: highlights entry "${entry}" names no language`);
      return `; ${from.package}@${from.version} ${path}\n${extract(tarballOf(from), path).toString("utf8")}`;
    });
    const highlights = queries.join("\n");
    writeFileSync(join(dir, "highlights.scm"), highlights);
    sizes[language.id] = wasm.length + Buffer.byteLength(highlights);
  }
  writeFileSync(join(frontend, "languages", "index.json"), `${JSON.stringify({ sizes }, null, 2)}\n`);

  await verify(require, frontend, catalog);
}

/** `npm pack` into the cache unless a tarball with the pinned integrity is already there. */
function fetchTarball(spec, integrity, cache) {
  const [algorithm, expected] = String(integrity ?? "").split("-", 2);
  if (!algorithm || !expected) throw new Error(`${spec}: languages.json pins no integrity`);
  const name = `${spec.replace(/^@/, "").replace(/[/@]/g, "-")}.tgz`;
  const file = join(cache, name);
  const matches = () =>
    existsSync(file) && createHash(algorithm).update(readFileSync(file)).digest("base64") === expected;
  if (matches()) return file;

  const packed = JSON.parse(
    execFileSync("npm", ["pack", spec, "--json", "--pack-destination", cache], { encoding: "utf8" }),
  )[0].filename;
  // npm names scoped tarballs `scope-name-version.tgz`; ours is the same shape, but be exact.
  const packedFile = join(cache, packed.replace(/^@/, "").replace(/\//g, "-"));
  if (packedFile !== file) copyFileSync(packedFile, file);
  if (!matches()) throw new Error(`${spec}: the tarball does not match the integrity pinned in languages.json`);
  return file;
}

/** One file out of an npm tarball. */
function extract(tarball, path) {
  try {
    return execFileSync("tar", ["-xzOf", tarball, `package/${path}`], { maxBuffer: 64 * 1024 * 1024 });
  } catch {
    throw new Error(`${tarball}: has no ${path}`);
  }
}

async function verify(require, frontend, catalog) {
  const { Parser, Language, Query } = await import(pathToFileURL(require.resolve("web-tree-sitter")).href);
  await Parser.init();
  const problems = [];
  for (const language of catalog) {
    const dir = join(frontend, "languages", language.id);
    try {
      const grammar = await Language.load(readFileSync(join(dir, "grammar.wasm")));
      new Query(grammar, readFileSync(join(dir, "highlights.scm"), "utf8")).delete();
    } catch (error) {
      problems.push(`${language.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (problems.length) throw new Error(`grammars that do not load:\n  ${problems.join("\n  ")}`);
  const count = readdirSync(join(frontend, "languages")).filter((name) => name !== "index.json").length;
  console.log(`  syntax-highlight: ${count} languages checked`);
}

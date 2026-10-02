import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { extract, fetchTarball } from "../_shared/npm-tarball.mjs";

export default async function build({ root, outDir, resolveFrom }) {
  const require = createRequire(join(resolveFrom, "noop.cjs"));
  const catalog = JSON.parse(readFileSync(join(root, "languages.json"), "utf8")).languages;
  const byId = new Map(catalog.map((language) => [language.id, language]));
  const cache = join(resolveFrom, "node_modules", ".cache", "ddd-grammars");
  mkdirSync(cache, { recursive: true });

  const frontend = join(outDir, "frontend");
  const runtimeWasm = join(require.resolve("web-tree-sitter"), "..", "web-tree-sitter.wasm");
  copyFileSync(runtimeWasm, join(frontend, "tree-sitter.wasm"));

  const tarballs = new Map();
  const tarballOf = (language) => {
    const spec = `${language.package}@${language.version}`;
    let file = tarballs.get(spec);
    if (!file) {
      file = fetchTarball(spec, language.integrity, cache, "languages.json");
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

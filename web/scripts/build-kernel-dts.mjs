#!/usr/bin/env node
/**
 * Build `web/kernel-api/dist/kernel.d.ts` — the single file SPEC §6.4 promises at
 * `/kernel.d.ts`, and the only thing a plugin author needs to type-check against
 * the kernel without installing this repository.
 *
 * How: `tsc --emitDeclarationOnly` over `kernel-api/src`, then flatten the emitted
 * files into one ambient `declare module "@kernel" { … }`.
 *
 * Why flatten rather than ship the directory: a plugin's tsconfig resolves the
 * bare specifier `@kernel` (that is what the import map serves at runtime), and an
 * ambient module declaration is the one shape that makes a bare specifier
 * resolvable from a single file with no `paths` entry, no `node_modules`, and no
 * package.json `exports`.
 *
 * The flattening is safe because of two invariants the contract holds itself to,
 * checked below rather than assumed:
 *
 * - every declaration name in `kernel-api/src` is unique across files, so
 *   concatenation cannot collide;
 * - the only cross-file references are relative type imports, which are dropped
 *   (the declarations they point at are in the same output), while imports of
 *   *external* packages — `react`, `yjs`, both import-map singletons — are kept and
 *   hoisted.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const api = join(web, "kernel-api");
const types = join(api, "dist", "types");
const outFile = join(api, "dist", "kernel.d.ts");

rmSync(join(api, "dist"), { recursive: true, force: true });
mkdirSync(join(api, "dist"), { recursive: true });

execFileSync(process.execPath, [
  join(web, "node_modules", "typescript", "bin", "tsc"),
  "-p",
  join(api, "tsconfig.build.json"),
], { stdio: "inherit", cwd: web });

/** `index.d.ts` first: its re-exports are dropped, but its constants are not. */
const files = readdirSync(types)
  .filter((name) => name.endsWith(".d.ts"))
  .sort((a, b) => (a === "index.d.ts" ? -1 : b === "index.d.ts" ? 1 : a.localeCompare(b)));

const externalImports = new Set();
const bodies = [];
const declared = new Map();

const DECLARATION = /^export (?:declare )?(?:abstract )?(?:class|interface|type|const|function|enum) ([A-Za-z0-9_$]+)/;

for (const name of files) {
  const source = readFileSync(join(types, name), "utf8");
  const kept = [];
  for (const line of source.split("\n")) {
    // Re-exports and relative imports: the target declarations are in this bundle.
    if (/^export\s+(?:type\s+)?[{*].*from\s+["']\.[^"']*["'];?$/.test(line.trim())) continue;
    const importMatch = /^import\s+(?:type\s+)?.*from\s+["']([^"']+)["'];?$/.exec(line.trim());
    if (importMatch) {
      const specifier = importMatch[1];
      if (specifier.startsWith(".")) continue;
      externalImports.add(line.trim());
      continue;
    }
    if (line.startsWith("//# sourceMappingURL")) continue;
    const declaration = DECLARATION.exec(line);
    if (declaration) {
      const [, identifier] = declaration;
      const previous = declared.get(identifier);
      if (previous && previous !== name) {
        throw new Error(
          `duplicate exported name \`${identifier}\` in ${previous} and ${name}: ` +
            "the flattened kernel.d.ts needs unique names across kernel-api/src",
        );
      }
      declared.set(identifier, name);
    }
    // `declare` is illegal inside an already-ambient module body.
    kept.push(line.replace(/^(\s*export\s+)declare\s+/, "$1"));
  }
  const body = kept.join("\n").trim();
  if (body.length > 0) bodies.push(`  // ---- ${name.replace(/\.d\.ts$/, ".ts")} ${"-".repeat(Math.max(0, 58 - name.length))}\n${indent(body)}`);
}

const header = `/**
 * \`@kernel\` — the Life Manager plugin contract.
 *
 * Generated from web/kernel-api/src by web/scripts/build-kernel-dts.mjs.
 * Do not edit: edit the source and re-run \`npm run kernel:dts\`.
 *
 * Contract version: ${readVersion()}
 * Served by the server at /kernel.d.ts (SPEC §6.4).
 */
`;

const body = [
  header,
  'declare module "@kernel" {',
  ...[...externalImports].sort().map((line) => `  ${line}`),
  "",
  bodies.join("\n\n"),
  "}",
  "",
].join("\n");

writeFileSync(outFile, body, "utf8");
console.log(`kernel.d.ts: ${declared.size} exported declarations -> ${outFile}`);

function indent(text) {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n");
}

function readVersion() {
  const source = readFileSync(join(api, "src", "index.ts"), "utf8");
  return /KERNEL_API_VERSION\s*=\s*"([^"]+)"/.exec(source)?.[1] ?? "unknown";
}

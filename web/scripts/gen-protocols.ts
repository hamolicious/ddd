/**
 * Generate every protocol package from its one hand-written file (PLUGIN-PROTOCOLS §3).
 *
 * ```
 * plugins/<tree>/<owner>/protocols/<name>/
 *   shape.mjs        # authored: id, version, kind, shape, docs, TypeScript notes
 *   protocol.json    # generated: what the server registers and ships to clients
 *   index.d.ts       # generated: the types plugins compile against
 *   README.md        # generated: what a provider promises
 * plugins/base/_protocols/<publisher>/<name>.d.ts   # generated: `@protocols/<id>` for tsconfig
 * ```
 *
 * Run through vite-node so `shape.mjs` can `import { s } from "@kernel"`:
 *
 * ```
 * cd web && npx vite-node scripts/gen-protocols.ts [--check]
 * ```
 *
 * `--check` writes nothing and exits non-zero naming every stale or missing file.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  isProtocolId,
  isValidVersion,
  type BuiltShape,
  type ProtocolPackage,
  type ProtocolSource,
  type Shape,
} from "@kernel";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const check = process.argv.includes("--check");
const trees = ["plugins/base", "plugins/examples"];
const reexportRoot = join(repo, "plugins/base/_protocols");

const GENERATED = "GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.";

interface Found {
  readonly owner: string;
  readonly tree: string;
  readonly dir: string;
  readonly name: string;
}

function findPackages(): Found[] {
  const found: Found[] = [];
  for (const tree of trees) {
    const root = join(repo, tree);
    if (!existsSync(root)) continue;
    for (const owner of readdirSync(root).sort()) {
      const protocols = join(root, owner, "protocols");
      if (owner.startsWith("_") || owner === "dist" || !existsSync(protocols)) continue;
      for (const name of readdirSync(protocols).sort()) {
        const dir = join(protocols, name);
        if (statSync(dir).isDirectory() && existsSync(join(dir, "shape.mjs"))) {
          found.push({ owner, tree, dir, name });
        }
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// TypeScript from a shape
// ---------------------------------------------------------------------------

const built = (shape: Shape<unknown>): BuiltShape<unknown> | undefined =>
  typeof (shape as BuiltShape<unknown>).toJSON === "function" ? (shape as BuiltShape<unknown>) : undefined;

let usesReact = { component: false, node: false };

function tsOf(shape: Shape<unknown>, indent: string): string {
  if (shape.ts !== undefined) {
    if (/\bReactNode\b/.test(shape.ts)) usesReact.node = true;
    if (/\bComponentType\b/.test(shape.ts)) usesReact.component = true;
    return shape.ts;
  }
  const node = built(shape);
  const json = node?.toJSON() ?? "any";
  if (typeof json === "string") {
    switch (json) {
      case "func":
        return "(...args: never[]) => unknown";
      case "promise":
        return "Promise<unknown>";
      case "component":
        usesReact.component = true;
        return "ComponentType<never>";
      case "any":
        return "unknown";
      default:
        return json;
    }
  }
  if ("literal" in json) return json.literal.map((v) => JSON.stringify(v)).join(" | ");
  if ("union" in json) return (node?.parts?.members ?? []).map((m) => tsOf(m, indent)).join(" | ");
  if ("array" in json) return `readonly (${tsOf(node!.parts!.item!, indent)})[]`;
  if ("record" in json) return `Readonly<Record<string, ${tsOf(node!.parts!.item!, indent)}>>`;
  if ("optional" in json) return tsOf(node!.parts!.item!, indent);
  if ("object" in json) return `{\n${fieldsOf(node!, `${indent}  `)}${indent}}`;
  return "unknown";
}

function fieldsOf(node: BuiltShape<unknown>, indent: string): string {
  let out = "";
  for (const [key, field] of Object.entries(node.parts?.fields ?? {})) {
    const optional = typeof field.toJSON() === "object" && "optional" in (field.toJSON() as object);
    const doc = field.doc ?? (optional ? field.parts?.item?.doc : undefined);
    if (doc) out += `${indent}/** ${doc} */\n`;
    const safe = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
    out += `${indent}readonly ${safe}${optional ? "?" : ""}: ${tsOf(field, indent)};\n`;
  }
  return out;
}

function renderTypes(source: ProtocolSource, pkg: ProtocolPackage): string {
  usesReact = { component: false, node: false };
  const node = built(source.shape);
  const json = node?.toJSON();
  const body =
    json && typeof json === "object" && "object" in json && source.shape.ts === undefined
      ? `export interface ${source.name} {\n${fieldsOf(node!, "  ")}}\n`
      : `export type ${source.name} = ${tsOf(source.shape, "")};\n`;
  const declarations = source.declarations?.trim() ?? "";
  for (const text of [declarations, source.imports ?? ""]) {
    if (/\bReactNode\b/.test(text)) usesReact.node = true;
    if (/\bComponentType\b/.test(text)) usesReact.component = true;
  }
  const imports = (source.imports ?? "").trim().split("\n").filter(Boolean);
  const react = [usesReact.component ? "ComponentType" : "", usesReact.node ? "ReactNode" : ""].filter(Boolean);
  if (react.length > 0 && !imports.some((line) => /from "react"/.test(line))) {
    imports.unshift(`import type { ${react.join(", ")} } from "react";`);
  }
  let out = `/**\n * ${pkg.id}@${pkg.version}: ${pkg.kind}, owned by \`${pkg.owner}\`.\n *\n`;
  for (const line of wrap(source.description, 88)) out += line ? ` * ${line}\n` : " *\n";
  out += ` *\n * ${GENERATED}\n */\n\n`;
  if (imports.length) out += `${imports.join("\n")}\n\n`;
  out += `/** The protocol this package describes. */\nexport type ProtocolId = ${JSON.stringify(pkg.id)};\n`;
  out += `export type ProtocolVersion = ${JSON.stringify(pkg.version)};\n\n`;
  if (declarations) out += `${declarations}\n\n`;
  if (source.shape.doc) out += `/** ${source.shape.doc} */\n`;
  out += body;
  return out;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.trim().split(/\n\s*\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line && line.length + 1 + word.length > width) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
    lines.push("");
  }
  lines.pop();
  return lines;
}

function renderReadme(source: ProtocolSource, pkg: ProtocolPackage): string {
  const key = pkg.key === undefined ? "" : ` · key \`${Array.isArray(pkg.key) ? pkg.key.join("|") : pkg.key}\``;
  let out = `# ${pkg.id}\n\n\`${pkg.version}\` · ${pkg.kind} · owned by \`${pkg.owner}\`${key}${pkg.sticky ? " · sticky" : ""}\n\n`;
  out += `${source.description.trim()}\n\n`;
  const node = built(source.shape);
  const fields = node?.parts?.fields;
  if (fields && Object.keys(fields).length > 0) {
    out += `| Key | Type | Required | |\n|---|---|---|---|\n`;
    for (const [name, field] of Object.entries(fields)) {
      const json = field.toJSON();
      const optional = typeof json === "object" && "optional" in json;
      const doc = (field.doc ?? (optional ? field.parts?.item?.doc : undefined) ?? "").replace(/\|/g, "\\|");
      const type = tsOf(field, "").replace(/\s+/g, " ").replace(/\|/g, "\\|");
      out += `| \`${name}\` | \`${type}\` | ${optional ? "" : "yes"} | ${doc} |\n`;
    }
    out += "\n";
  }
  out += `Types: \`index.d.ts\`. ${GENERATED}\n`;
  return out;
}

// ---------------------------------------------------------------------------

const problems: string[] = [];
const outputs = new Map<string, string>();
const seen = new Map<string, string>();

for (const found of findPackages()) {
  const where = relative(repo, found.dir);
  const module = (await import(pathToFileURL(join(found.dir, "shape.mjs")).href)) as { default?: ProtocolSource };
  const source = module.default;
  if (!source) {
    problems.push(`${where}/shape.mjs has no default export`);
    continue;
  }
  const [publisher, ...rest] = source.id.split("/");
  const name = rest.join("/");
  if (!isProtocolId(source.id)) problems.push(`${where}: "${source.id}" is not a protocol id`);
  if (name !== found.name) problems.push(`${where}: the id "${source.id}" does not end in the directory name "${found.name}"`);
  if (publisher === "lm" && found.tree !== "plugins/base") problems.push(`${where}: lm/ is reserved for the base distribution`);
  if (!isValidVersion(source.version)) problems.push(`${where}: "${source.version}" is not a semver version`);
  if (!["service", "slot", "event"].includes(source.kind)) problems.push(`${where}: kind "${source.kind}"`);
  if (!/^[A-Z][A-Za-z0-9]*$/.test(source.name ?? "")) problems.push(`${where}: name "${source.name}" is not a TypeScript type name`);
  if (seen.has(source.id)) problems.push(`${where}: ${source.id} is also defined in ${seen.get(source.id)}`);
  seen.set(source.id, where);
  const json = built(source.shape)?.toJSON();
  if (!json) {
    problems.push(`${where}: the shape must be built with s.*`);
    continue;
  }
  const keys = source.key === undefined ? [] : Array.isArray(source.key) ? source.key : [source.key];
  if (keys.length && source.kind !== "slot") problems.push(`${where}: only a slot has a key`);
  for (const key of keys) {
    if (!(typeof json === "object" && "object" in json && key in json.object)) {
      problems.push(`${where}: key "${key}" is not a field of the shape`);
    }
  }
  if (source.sticky && source.kind !== "event") problems.push(`${where}: only an event is sticky`);

  const pkg: ProtocolPackage = {
    id: source.id,
    version: source.version,
    kind: source.kind,
    owner: found.owner,
    types: "index.d.ts",
    ...(source.description ? { description: source.description.trim().split(/\n\s*\n/)[0]!.replace(/\s+/g, " ") } : {}),
    ...(source.key !== undefined ? { key: source.key } : {}),
    ...(source.sticky ? { sticky: true } : {}),
    shape: json,
  };
  outputs.set(join(found.dir, "protocol.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  outputs.set(join(found.dir, "index.d.ts"), renderTypes(source, pkg));
  outputs.set(join(found.dir, "README.md"), renderReadme(source, pkg));
  if (found.tree === "plugins/base") {
    const reexport = join(reexportRoot, publisher!, `${name}.d.ts`);
    const target = relative(dirname(reexport), join(found.dir, "index.js")).split("\\").join("/");
    outputs.set(reexport, `// ${GENERATED}\nexport * from "${target.startsWith(".") ? target : `./${target}`}";\n`);
  }
}

// Re-exports for protocols that no longer exist.
const stale: string[] = [];
if (existsSync(reexportRoot)) {
  for (const publisher of readdirSync(reexportRoot)) {
    for (const file of readdirSync(join(reexportRoot, publisher))) {
      const path = join(reexportRoot, publisher, file);
      if (!outputs.has(path)) stale.push(path);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`! ${problem}`);
  process.exit(1);
}

let dirty = 0;
for (const [path, content] of outputs) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (current === content) continue;
  if (check) {
    dirty += 1;
    console.error(`stale: ${relative(repo, path)}`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`wrote ${relative(repo, path)}`);
  }
}
for (const path of stale) {
  if (check) {
    dirty += 1;
    console.error(`stale: ${relative(repo, path)} (its protocol is gone)`);
  } else {
    rmSync(path);
    console.log(`removed ${relative(repo, path)}`);
  }
}
if (dirty > 0) {
  console.error("run `cd web && npx vite-node scripts/gen-protocols.ts`");
  process.exit(1);
}
console.log(`${seen.size} protocol${seen.size === 1 ? "" : "s"}${check ? " up to date" : ""}`);

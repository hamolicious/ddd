#!/usr/bin/env node
/**
 * Package a built plugin as the installable `.zip` of SPEC §6.2.
 *
 * ```
 * my-plugin-1.2.0.zip
 * ├── manifest.json
 * ├── backend.wasm        ← only if the manifest declares one
 * ├── frontend/…
 * └── protocols/<name>/   ← protocol.json, index.d.ts, README.md (PLUGIN-PROTOCOLS §3)
 * ```
 *
 * The input is the **built** plugin directory (`plugins/base/dist/<id>/<version>`), not the
 * source tree: that directory is already exactly the installed layout, which is the layout
 * the installer extracts back into. Run `mise run plugins` (and `mise run wasm-plugins` for a
 * plugin with a backend half) first.
 *
 * The installer is deliberately strict — SPEC §6.2 says *reject* entries outside
 * `frontend/**` plus the declared wasm module — so this script writes exactly that set and
 * nothing else. It is the reason the script exists rather than a `zip -r` in a README: a
 * `zip -r` of a directory a build tool touched picks up whatever else is in there, and the
 * install then fails naming a file the author did not know was in their package.
 *
 * Usage:
 *   node web/scripts/package-plugin.mjs <id> [version] [--out <dir>]
 *
 * Writes `<out>/<id>-<version>.zip` (default out: `dist-packages/`) and prints the path.
 */

import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(web, "..");
const distRoot = join(repo, "plugins", "base", "dist");

const argv = process.argv.slice(2);
const outFlag = argv.indexOf("--out");
const outDir = outFlag === -1 ? join(repo, "dist-packages") : resolve(argv[outFlag + 1]);
const positional = argv.filter((arg, index) => {
  if (arg.startsWith("--")) return false;
  if (outFlag !== -1 && index === outFlag + 1) return false;
  return true;
});

const [id, versionArg] = positional;
if (!id) {
  console.error("usage: node web/scripts/package-plugin.mjs <id> [version] [--out <dir>]");
  process.exit(2);
}

const pluginRoot = join(distRoot, id);
if (!existsSync(pluginRoot)) {
  console.error(`! ${id} is not built — run \`mise run plugins\` (and \`wasm-plugins\`) first`);
  console.error(`  looked in ${pluginRoot}`);
  process.exit(1);
}

const versions = readdirSync(pluginRoot).filter((name) =>
  statSync(join(pluginRoot, name)).isDirectory(),
);
const version = versionArg ?? versions.sort().at(-1);
if (!version || !versions.includes(version)) {
  console.error(`! ${id} has no built version ${versionArg ?? ""} (found: ${versions.join(", ")})`);
  process.exit(1);
}

const root = join(pluginRoot, version);
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
if (manifest.id !== id || manifest.version !== version) {
  console.error(
    `! ${root}/manifest.json declares ${manifest.id}@${manifest.version}, not ${id}@${version}`,
  );
  process.exit(1);
}

/** Every file under `dir`, as archive-relative POSIX paths. */
const walk = (dir, prefix) => {
  const found = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walk(full, posix.join(prefix, name)));
    else found.push({ name: posix.join(prefix, name), full });
  }
  return found;
};

// The allowlist, in the order the installer reads it: the manifest first (it is what
// validates), then the declared module, then `frontend/**`.
const entries = [{ name: "manifest.json", full: join(root, "manifest.json") }];

const module = manifest.backend?.module;
if (module) {
  const full = join(root, module);
  if (!existsSync(full)) {
    console.error(`! the manifest declares backend.module "${module}" but ${full} does not exist`);
    console.error("  run `mise run wasm-plugins` (it builds the backend half into this layout)");
    process.exit(1);
  }
  entries.push({ name: module, full });
}

const frontendDir = join(root, "frontend");
if (existsSync(frontendDir)) entries.push(...walk(frontendDir, "frontend"));

// Protocol packages the plugin owns (PLUGIN-PROTOCOLS §3): `protocols/<name>/<file>`, and
// only the files the installer's allowlist admits.
const protocolsDir = join(root, "protocols");
if (existsSync(protocolsDir)) {
  const allowed = new Set(["protocol.json", "index.d.ts", "README.md", "conformance.mjs"]);
  entries.push(
    ...walk(protocolsDir, "protocols").filter(({ name }) => {
      const parts = name.split("/");
      return parts.length === 3 && allowed.has(parts[2]);
    }),
  );
}

// ---- the archive ----------------------------------------------------------------
// A ~60-line zip writer instead of a dependency: this is the only place in the repo that
// *writes* a zip, the format's stored/deflate subset is small, and the reader on the other
// side is `plugininstall::zipcheck`, which accepts exactly this subset.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

// One fixed DOS timestamp for every entry (1980-01-01 00:00). Reproducibility is the point:
// the same built plugin packaged twice must hash the same, so `module_sha256` in the admin
// screen is comparable between an operator's package and a rebuild of it.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const locals = [];
const centrals = [];
let offset = 0;

for (const entry of entries) {
  const raw = readFileSync(entry.full);
  const name = Buffer.from(entry.name, "utf8");
  const deflated = deflateRawSync(raw, { level: 9 });
  // Stored when deflate does not help — a tiny already-compressed file can grow.
  const stored = deflated.length >= raw.length;
  const body = stored ? raw : deflated;
  const method = stored ? 0 : 8;
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags — no data descriptor, sizes are known up front
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 30); // extra + comment lengths, disk number
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36); // internal attributes
  // External attributes: `0644 << 16`. The installer copies no permissions (SPEC §6.2), so
  // this is only what a human unzipping the package gets.
  // (`<<` is a *signed* 32-bit shift in JS, so this needs the `>>> 0`.)
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);

  offset += local.length + name.length + body.length;
}

const centralBuffer = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuffer.length, 12);
end.writeUInt32LE(offset, 16);

const archive = Buffer.concat([...locals, centralBuffer, end]);

mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${id}-${version}.zip`);
writeFileSync(out, archive);

const sha = createHash("sha256").update(archive).digest("hex");
console.log(`+ ${id}@${version} -> ${out}`);
console.log(`  ${entries.length} entries, ${archive.length} bytes, sha256 ${sha}`);
for (const entry of entries) console.log(`  · ${entry.name}`);
console.log("\nUpload it in Admin → Plugins, or drop it into PLUGIN_INBOX_DIR.");
console.log("It lands *pending*: activation is an explicit approval click (SPEC §6.2).");

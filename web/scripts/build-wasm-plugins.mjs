#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(web, "..");
const pluginsRoot = join(repo, "plugins");
const baseDir = join(pluginsRoot, "base");
const distRoot = join(baseDir, "dist");

const argv = process.argv.slice(2);
const debug = argv.includes("--debug");
const withExamples = argv.includes("--examples");
const prebuilt = argv.includes("--prebuilt");
const requested = argv.filter((arg) => !arg.startsWith("--"));
const profile = debug ? "debug" : "release";

const crateName = (cargoToml) => {
  const text = readFileSync(cargoToml, "utf8");
  const match = /^\s*name\s*=\s*"([^"]+)"/m.exec(text);
  if (!match) throw new Error(`${cargoToml} has no [package] name`);
  return match[1];
};

const artifactName = (crate) => `${crate.replaceAll("-", "_")}.wasm`;

const targets = [];

for (const name of readdirSync(baseDir).sort()) {
  if (name.startsWith("_") || name === "dist") continue;
  const root = join(baseDir, name);
  if (!statSync(root).isDirectory()) continue;
  if (requested.length > 0 && !requested.includes(name)) continue;

  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.backend?.module) continue;

  const cargoToml = join(root, "backend", "Cargo.toml");
  if (!existsSync(cargoToml)) {
    console.error(
      `! ${name}: the manifest declares backend.module "${manifest.backend.module}" but ${cargoToml} does not exist`,
    );
    process.exit(1);
  }
  targets.push({
    id: manifest.id,
    version: manifest.version,
    crate: crateName(cargoToml),
    module: manifest.backend.module,
    outDir: join(distRoot, manifest.id, manifest.version),
  });
}

if (withExamples || requested.length === 0) {
  const examplesDir = join(pluginsRoot, "examples");
  if (existsSync(examplesDir)) {
    for (const name of readdirSync(examplesDir).sort()) {
      const cargoToml = join(examplesDir, name, "Cargo.toml");
      if (!existsSync(cargoToml)) continue;
      if (requested.length > 0 && !requested.includes(name)) continue;
      targets.push({ id: name, version: null, crate: crateName(cargoToml), module: null });
    }
  }
}

if (targets.length === 0) {
  console.log("no plugin backend halves to build");
  process.exit(0);
}

if (prebuilt) {
  console.log(`installing prebuilt ${profile} artifacts from ${pluginsRoot}/target`);
} else {
  const crates = targets.flatMap((target) => ["-p", target.crate]);
  const args = ["build", ...crates, "--target", "wasm32-unknown-unknown"];
  if (!debug) args.push("--release");

  console.log(`cargo ${args.join(" ")}   (in ${pluginsRoot})`);
  try {
    execFileSync("cargo", args, { cwd: pluginsRoot, stdio: "inherit" });
  } catch {
    console.error(
      "\ncargo failed. The wasm target has to be installed once:\n" +
        "  rustup target add wasm32-unknown-unknown",
    );
    process.exit(1);
  }
}

const built = [];
for (const target of targets) {
  const artifact = join(
    pluginsRoot,
    "target",
    "wasm32-unknown-unknown",
    profile,
    artifactName(target.crate),
  );
  if (!existsSync(artifact)) {
    console.error(
      prebuilt
        ? `! ${target.crate}: no prebuilt ${artifact} — did the build stage produce it?`
        : `! ${target.crate}: cargo produced no ${artifact}`,
    );
    process.exit(1);
  }
  if (!target.module) {
    console.log(`= ${target.crate} -> ${artifact} (fixture, not installed)`);
    continue;
  }
  mkdirSync(join(target.outDir, dirname(target.module)), { recursive: true });
  const destination = join(target.outDir, target.module);
  copyFileSync(artifact, destination);
  const bytes = statSync(destination).size;
  built.push(`${target.id}@${target.version} (${(bytes / 1024).toFixed(0)} KiB)`);
  console.log(`+ ${target.id}@${target.version} -> ${destination}`);
}

if (built.length > 0) {
  console.log(`\n${built.length} backend half/halves installed: ${built.join(", ")}`);
  console.log(
    "Run `mise run plugins` too — a plugin directory without its frontend half and manifest is not installable.",
  );
}

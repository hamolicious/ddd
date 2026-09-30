#!/usr/bin/env node
/*
 * Build the backend half for wasm32 and put it where the manifest says
 * (`backend.module`, next to the frontend half in dist/). Runs after `vite build`,
 * which empties dist/ first.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const backend = join(root, "backend");

// `--target` spelled out: cargo reads backend/.cargo/config.toml only when run from there.
execFileSync(
  "cargo",
  ["build", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", join(backend, "Cargo.toml")],
  { stdio: "inherit" },
);

const out = join(root, "dist", manifest.backend.module);
mkdirSync(dirname(out), { recursive: true });
copyFileSync(join(backend, "target", "wasm32-unknown-unknown", "release", "{{crate}}.wasm"), out);
console.log(`+ ${manifest.backend.module}`);

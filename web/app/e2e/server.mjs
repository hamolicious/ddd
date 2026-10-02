#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = resolve(web, "..");

const port = process.env["DDD_E2E_PORT"] ?? "8121";
const database = process.env["DDD_E2E_DB"] ?? "ddd_e2e";

const pluginsDir = process.env["DDD_E2E_PLUGINS"] ?? composeDefaultRegistry();

function composeDefaultRegistry() {
  const out = resolve(web, "app", "e2e", ".plugins", "default");
  const compose = spawnSync(
    process.execPath,
    [
      resolve(web, "scripts", "compose-plugins.mjs"),
      out,
      "--include-examples=extra-task-states",
    ],
    { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (compose.status !== 0) {
    console.error("[e2e] could not compose the plugin registry");
    console.error("[e2e] build the plugins first:  mise run web-build && node web/scripts/build-examples.mjs");
    process.exit(1);
  }
  console.log(`[e2e] composed registry: ${out}`);
  return out;
}
const mongoUri = process.env["DDD_MONGO_URI"] ?? process.env["MONGO_URI"] ?? "mongodb://127.0.0.1:27017";
const binary =
  process.env["DDD_E2E_BINARY"] ?? resolve(repo, "backend", "target", "debug", "ddd");
const webDist = resolve(web, "app", "dist");

for (const [what, path] of [
  ["the server binary", binary],
  ["the app bundle", resolve(webDist, "index.html")],
  ["the plugin registry", pluginsDir],
]) {
  if (existsSync(path)) continue;
  console.error(
    `[e2e] ${what} is missing: ${path}\n` +
      `[e2e] build it first:  cargo build --bin ddd   &&   mise run web-build`,
  );
  process.exit(1);
}

if (process.env["DDD_E2E_KEEP_DB"] !== "1") {
  const drop = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      resolve(repo, "docker-compose.yaml"),
      "exec",
      "-T",
      "mongo",
      "mongosh",
      "--quiet",
      "--eval",
      `db.getSiblingDB(${JSON.stringify(database)}).dropDatabase()`,
    ],
    { cwd: repo, encoding: "utf8" },
  );
  if (drop.status !== 0) {
    console.error(`[e2e] could not drop ${database}: ${drop.stderr ?? drop.error?.message ?? ""}`);
    console.error("[e2e] is the compose stack up?  docker compose up -d --wait mongo");
    process.exit(1);
  }
  console.log(`[e2e] dropped ${database}`);
}

const origin = `http://localhost:${port}`;
const child = spawn(binary, ["serve"], {
  cwd: repo,
  stdio: "inherit",
  env: {
    ...process.env,
    SESSION_SECRET: "ddd-e2e-session-secret-0123456789abcdef",
    MONGO_URI: mongoUri,
    MONGO_DATABASE: database,
    BIND_ADDR: `127.0.0.1:${port}`,
    APP_ORIGIN: `${origin},http://127.0.0.1:${port}`,
    COOKIE_SECURE: "false",
    LOG_FORMAT: "text",
    RUST_LOG: process.env["RUST_LOG"] ?? "info",
    WEB_DIST_DIR: webDist,
    PLUGINS_DIR: pluginsDir,
    KERNEL_DTS_PATH: resolve(web, "kernel-api", "dist", "kernel.d.ts"),
    MATERIALIZE_DEBOUNCE_MS: process.env["MATERIALIZE_DEBOUNCE_MS"] ?? "50",
  },
});

const stop = (signal) => {
  child.kill(signal);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

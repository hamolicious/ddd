#!/usr/bin/env node
/**
 * The server the app E2E suite drives: the **real** binary, serving the **real**
 * built bundle and a real plugin registry directory, over one origin.
 *
 * Why the suite owns its server instead of reusing `mise run dev`:
 *
 * - **Registration only works for the first user** (SPEC §5.1). Half the journeys
 *   ("register", "admin creates an invite", "a second user registers with it") are
 *   about the first-user transition, and they are only repeatable against a database
 *   that starts empty. So this drops the test database before every run.
 * - The import map, the CSP nonce, the service worker and the plugin URLs only exist
 *   on the real server (SPEC §6.4, §8). A Vite dev server would test a different
 *   application.
 * - The acceptance spec needs a *second* server over a *different* plugin directory
 *   (see `acceptance.spec.ts`), and that is only cheap if starting one is one call.
 *
 * Usage (Playwright's `webServer.command` runs the first form):
 *
 * ```
 * node app/e2e/server.mjs                       # port 8121, base plugins, fresh DB
 * LM_E2E_PORT=8122 LM_E2E_PLUGINS=/tmp/x  node app/e2e/server.mjs
 * ```
 *
 * Env: `LM_E2E_PORT`, `LM_E2E_DB`, `LM_E2E_PLUGINS`, `LM_E2E_KEEP_DB=1`,
 * `LM_E2E_BINARY`, `LM_MONGO_URI`.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repo = resolve(web, "..");

const port = process.env["LM_E2E_PORT"] ?? "8121";
const database = process.env["LM_E2E_DB"] ?? "life_manager_e2e";

/**
 * The default registry is **base plus `extra-task-states`**, not base alone.
 *
 * Two journeys need a plugin the base distribution does not contain. The custom
 * task-state one needs it by necessity: `[ ]` and `[x]` are `markdown`'s own default
 * contributions *and* the only two markers remark-gfm recognises, so clicking those
 * cannot distinguish "the registry decides marker semantics" (SPEC §6.6) from "GFM
 * does". `[/]` can only come from a contribution. The safe-mode journey needs a
 * *non-base* plugin to break, since `?safe=1` is defined as "base only".
 *
 * A workspace with one extra plugin installed is also simply the normal case.
 */
const pluginsDir = process.env["LM_E2E_PLUGINS"] ?? composeDefaultRegistry();

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
const mongoUri = process.env["LM_MONGO_URI"] ?? process.env["MONGO_URI"] ?? "mongodb://127.0.0.1:27017";
const binary =
  process.env["LM_E2E_BINARY"] ?? resolve(repo, "backend", "target", "debug", "life-manager");
const webDist = resolve(web, "app", "dist");

for (const [what, path] of [
  ["the server binary", binary],
  ["the app bundle", resolve(webDist, "index.html")],
  ["the plugin registry", pluginsDir],
]) {
  if (existsSync(path)) continue;
  console.error(
    `[e2e] ${what} is missing: ${path}\n` +
      `[e2e] build it first:  cargo build --bin life-manager   &&   mise run web-build`,
  );
  process.exit(1);
}

/**
 * Drop the database so the first request really is a first-user registration.
 *
 * Through `docker compose exec` rather than a Mongo driver: `web/` has no Mongo
 * dependency and adding one to drop a database in a test launcher would be a poor
 * trade. A compose stack that is not running is a clear failure here rather than a
 * confusing one later.
 */
if (process.env["LM_E2E_KEEP_DB"] !== "1") {
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
    // A fixed secret: these sessions live for the length of one test run, and a
    // random one would only make a failed run harder to poke at by hand.
    SESSION_SECRET: "life-manager-e2e-session-secret-0123456789abcdef",
    MONGO_URI: mongoUri,
    MONGO_DATABASE: database,
    BIND_ADDR: `127.0.0.1:${port}`,
    // 127.0.0.1 as well as localhost: the socket's Origin check is exact (SPEC §4.3),
    // and a test that navigates to one while the config names the other fails as a
    // WebSocket that will not open.
    APP_ORIGIN: `${origin},http://127.0.0.1:${port}`,
    // No TLS in front of the test server, so `Secure` cookies would never be stored.
    COOKIE_SECURE: "false",
    LOG_FORMAT: "text",
    RUST_LOG: process.env["RUST_LOG"] ?? "info",
    WEB_DIST_DIR: webDist,
    PLUGINS_DIR: pluginsDir,
    KERNEL_DTS_PATH: resolve(web, "kernel-api", "dist", "kernel.d.ts"),
    // Materialization is debounced (SPEC §3.5). 500 ms is right in production and is
    // dead time in a suite that asserts on `content` after an edit; 50 ms keeps the
    // debounce real (it still coalesces a burst) without the waiting.
    MATERIALIZE_DEBOUNCE_MS: process.env["MATERIALIZE_DEBOUNCE_MS"] ?? "50",
  },
});

const stop = (signal) => {
  child.kill(signal);
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

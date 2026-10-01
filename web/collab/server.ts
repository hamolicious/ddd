/**
 * The server a collaboration file drives: the real binary on its own port and its
 * own database, started through `app/e2e/server.mjs` so the prerequisites checks and
 * the environment are the E2E suite's, not a second copy of them.
 *
 * Each file owns one server because some scenarios **restart** it mid-test (edits made
 * while the server is down must still arrive), and a restart is only safe when nobody
 * else is using the process. `DDD_COLLAB_SERVER` points a run at a server you started
 * yourself instead; the restart scenarios then skip.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface CollabServer {
  readonly url: string;
  /** `false` for an external server: it cannot be restarted from here. */
  readonly owned: boolean;
  /** Kill the process and wait for it to go. The database is kept. */
  stop(): Promise<void>;
  /** Start it again on the same port and database, with `env` on top of the usual. */
  start(env?: Record<string, string>): Promise<void>;
  restart(env?: Record<string, string>): Promise<void>;
}

export async function startServer(options: { port: number; database: string }): Promise<CollabServer> {
  const external = process.env["DDD_COLLAB_SERVER"];
  if (external) {
    await waitHealthy(external, 10_000);
    const refuse = () => Promise.reject(new Error("DDD_COLLAB_SERVER is set: this suite does not own the server"));
    return { url: external, owned: false, stop: refuse, start: refuse, restart: refuse };
  }

  const url = `http://localhost:${options.port}`;
  let child: ChildProcess | undefined;
  let log = "";

  const launch = async (keepDb: boolean, extra: Record<string, string> = {}): Promise<void> => {
    log = "";
    child = spawn(process.execPath, [resolve(web, "app", "e2e", "server.mjs")], {
      cwd: web,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DDD_E2E_PORT: String(options.port),
        DDD_E2E_DB: options.database,
        DDD_E2E_KEEP_DB: keepDb ? "1" : "0",
        RUST_LOG: process.env["RUST_LOG"] ?? "warn",
        ...extra,
      },
    });
    const collect = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-8_000);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const exited = new Promise<never>((_, reject) =>
      child?.once("exit", (code) => reject(new Error(`server exited (${code}) before it was healthy:\n${log}`))),
    );
    await Promise.race([waitHealthy(url, 60_000), exited]);
  };

  const stop = async (): Promise<void> => {
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null) return;
    const gone = new Promise<void>((done) => running.once("exit", () => done()));
    running.kill("SIGTERM");
    const timer = setTimeout(() => running.kill("SIGKILL"), 5_000);
    await gone;
    clearTimeout(timer);
    await waitDown(url);
  };

  await launch(false);
  return {
    url,
    owned: true,
    stop,
    start: (env) => launch(true, env),
    restart: async (env) => {
      await stop();
      await launch(true, env);
    },
  };
}

async function waitHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(new URL("/healthz", url));
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${url} was not healthy within ${timeoutMs} ms`);
    await new Promise((done) => setTimeout(done, 150));
  }
}

async function waitDown(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await (await fetch(new URL("/healthz", url))).arrayBuffer();
    } catch {
      return;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

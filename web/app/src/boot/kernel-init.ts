/**
 * Kernel init: the M2 substrate, assembled once, wrapped in a {@link KernelHost}.
 *
 * Boot order matters and is visible here on purpose (it is the same order the demo
 * page proved out in M2):
 *
 * 1. the **Wasm core** first — the query engine needs the filter evaluator, and a
 *    core that failed to load must degrade loudly rather than let the client invent
 *    its own semantics (SPEC §2);
 * 2. the **projection store**, so the workspace is readable before any socket opens;
 * 3. the **query engine** with the search index in its Worker (SPEC §4.2), warmed up
 *    so a cold index is built off the main thread;
 * 4. the **sync client**, last — the app is usable offline, so the socket is an
 *    enhancement, not a prerequisite.
 *
 * **Where the server is, is an input** (M5, `app/BRIDGE.md` §6). In a browser the API is
 * same-origin and every default here is already right. Inside the Flutter shell the page
 * is served by a loopback bundle server, so the REST base, the bootstrap URL, the sync
 * socket and the `too_large` hydration fallback all have to be pointed at
 * `window.shell.serverBaseUrl` — four call sites, one option, and the reason the shell
 * could sign in and then never sync.
 *
 * Note what is *not* re-based: plugin modules and the import map. Those are part of the
 * downloaded bundle and are served by the loopback origin itself (`app/BRIDGE.md` §5), so
 * they stay page-relative and keep working with no network at all.
 */

import { IdbDocPersistence, IdbProjectionStore } from "@kernel/store/index.js";
import { QueryEngine, createSearchIndex } from "@kernel/query/index.js";
import { SyncClient } from "@kernel/sync/index.js";
import { loadCore, type CoreBindings } from "@kernel/wasm/index.js";
import { KernelHost, type PluginProblem } from "@kernel/runtime/index.js";
import type { BootMode, LogoutOptions, SessionUser } from "@kernel";

export interface KernelInitOptions {
  readonly user: SessionUser;
  /** Present only in a shell (SPEC §5.2); browsers authenticate with the cookie. */
  readonly bearerToken?: string;
  /**
   * Absolute server origin, e.g. `https://life.example.com` — the shell only
   * (`boot/shell.ts`). Absent means "this page's origin", which is what a browser wants.
   */
  readonly serverBaseUrl?: string;
  readonly root: HTMLElement;
  readonly bootMode: BootMode;
  /** Sign-out: warn on unsynced edits, clear local data, reload (SPEC §5.3). */
  readonly logout: (options: LogoutOptions) => Promise<void>;
  readonly onPluginProblem?: (problem: PluginProblem) => void;
  /** Reported once, so the boot screen can say "filters are disabled". */
  readonly onCoreUnavailable?: (error: Error) => void;
}

export interface KernelRuntime {
  readonly host: KernelHost;
  readonly store: IdbProjectionStore;
  readonly engine: QueryEngine;
  readonly sync: SyncClient;
  readonly core: CoreBindings;
}

export async function initKernel(options: KernelInitOptions): Promise<KernelRuntime> {
  let core: CoreBindings;
  try {
    core = await loadCore();
  } catch (error) {
    // Everything that does not need Rust semantics keeps working; anything that
    // would silently diverge from the server refuses instead (the demo's rule).
    const reason = error instanceof Error ? error : new Error(String(error));
    options.onCoreUnavailable?.(reason);
    core = unavailableCore(reason.message);
  }

  const store = new IdbProjectionStore();
  await store.open();

  const engine = new QueryEngine(store, core, createSearchIndex());
  engine.warmUp().catch((error: unknown) => console.warn("[search] warm-up failed", error));

  // The socket and the two REST paths inside the sync layer take absolute URLs, so the
  // shell is served by passing options — no kernel file has to know the shell exists.
  const server = options.serverBaseUrl;
  const sync = new SyncClient(store, {
    transport: {
      ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
      ...(server ? { url: `${server}/api/sync` } : {}),
    },
    ...(server || options.bearerToken
      ? {
          bootstrap: {
            ...(server ? { url: `${server}/api/sync/bootstrap` } : {}),
            ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
          },
        }
      : {}),
    hydrator: {
      persistence: new IdbDocPersistence(store),
      ...(server ? { restBaseUrl: server } : {}),
    },
    onState: (state) => {
      host.sync.update(state);
      // 4401 is "re-authenticate", and nothing else — local data is untouched
      // (SPEC §5.3). Plugins hear it through `session.onAuthRequired`.
      if (state.status === "auth-required") host.session.authRequired();
    },
  });

  const host = new KernelHost({
    root: options.root,
    engine,
    sync,
    core,
    bootMode: options.bootMode,
    session: {
      user: options.user,
      via: options.bearerToken ? "bearer" : "cookie",
      ...(options.bearerToken ? { token: options.bearerToken } : {}),
      // `kernel.session.fetch` is what every plugin and `DocumentsHost` call the server
      // through; its default is `/api` on the page origin (SPEC §5.1).
      ...(server ? { apiBase: `${server}/api` } : {}),
      logout: options.logout,
    },
    ...(options.onPluginProblem ? { onPluginProblem: options.onPluginProblem } : {}),
  });

  // Per-user settings are documents (SPEC §6.4), so the live query behind
  // `kernel.settings` opens here — before any plugin activates, so a plugin can read
  // a setting synchronously inside `activate()`. A failure here is not fatal: every
  // `get()` falls back to the schema default and the notice says why.
  await host.settings.start().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    host.notices.notify({
      id: "kernel:settings-unavailable",
      level: "warning",
      message: "Your settings could not be read; defaults are in use.",
      detail: reason,
    });
  });

  // The kernel has no DOM; the app owns these three triggers (PROTOCOL.md §8).
  addEventListener("online", () => sync.reconnectNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync.reconnectNow();
  });
  await sync.start();

  // SPEC §6.4: ask for persistent storage at first login, warn if denied.
  void host.capabilities.requestPersistence().then((report) => {
    if (report.persisted) return;
    host.notices.notify({
      id: "kernel:storage-not-persisted",
      level: "warning",
      message: "This browser may evict offline data.",
      detail:
        "Storage persistence was not granted, so the browser can clear the local workspace copy under disk pressure. Unsynced edits are the only thing at risk.",
    });
  });

  return { host, store, engine, sync, core };
}

/** Stand-in for a core that failed to load (`mise run wasm` never run). */
function unavailableCore(reason: string): CoreBindings {
  const fail = (): never => {
    throw new Error(`the shared Wasm core is unavailable (${reason}); run \`mise run wasm\``);
  };
  return {
    parseDocument: fail,
    evaluateFilter: fail,
    resolveTitle: fail,
    normalizeDate: fail,
    semanticsVersion: () => -1,
  };
}

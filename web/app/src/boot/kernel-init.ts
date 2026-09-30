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

import { shellOwnsSession } from "./shell.js";

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
  /**
   * The server's plugin set changed (`plugins.changed`, or a `welcome` naming a different
   * version than the first one this page saw). Default: `location.reload()`.
   */
  readonly onPluginsChanged?: (version: number | string) => void;
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
      // Every note keeps an editable copy on the device (dev-docs/resolved/SYNC-DECISIONS.md §7):
      // nothing is pruned; a purge is what drops one.
      persistedReplicas: Number.POSITIVE_INFINITY,
      ...(server ? { restBaseUrl: server } : {}),
      // A write the server refused as too large must not look saved: say which
      // document, and what to do. It clears itself once a trimmed version goes through.
      onError: (id, error) => {
        if (error.code !== "too_large" || error.hint === "rest") return;
        void store
          .get(id)
          .catch(() => undefined)
          .then((row) => {
            host.notices.notify({
              id: `kernel:too-large:${id}`,
              level: "error",
              message: `“${row?.title ?? "A document"}” is over the size limit, so your latest changes are not saved to the server.`,
              detail:
                "They are kept on this device. Remove some text (or move part of it to another document) and it saves again.",
              actions: [{ label: "Open it", run: () => void (location.hash = `#/doc/${id}`) }],
            });
          });
      },
      onRefusalCleared: (id) => host.notices.dismiss(`kernel:too-large:${id}`),
      // Offline changes show in the list at once (dev-docs/resolved/SYNC-DECISIONS.md §2).
      onLocalEdit: (id, text) => host.documents.onLocalEdit(id, text),
      onOfflineEditsSent: (id) => host.documents.onOfflineEditsSent(id),
      // Deleted for good elsewhere while this device held edits the server never got
      // (SPEC §4.1). The id can never come back, so the text is saved as a new note
      // straight away, before anything else can lose it, and the person is told.
      onReplicaDiscarded: ({ id, hadUnsyncedEdits, text }) => {
        if (!hadUnsyncedEdits || text.trim() === "") return;
        const recover = (): void => {
          host.documents
            .create({ text })
            .then((recovered) => {
              host.notices.notify({
                id: `kernel:recovered:${id}`,
                level: "warning",
                message:
                  "A note you had changed on this device was deleted for good elsewhere. Your version was saved as a new note.",
                actions: [{ label: "Open it", run: () => void (location.hash = `#/doc/${recovered}`) }],
              });
            })
            .catch((cause: unknown) => {
              host.notices.notify({
                id: `kernel:recovered:${id}`,
                level: "error",
                message:
                  "A note you had changed on this device was deleted for good elsewhere, and your version could not be saved yet.",
                detail: `${cause instanceof Error ? cause.message : String(cause)}\n\nYour text:\n${text}`,
                actions: [{ label: "Try again", run: recover }],
              });
            });
        };
        recover();
      },
    },
    authProbe: async () => {
      try {
        const response = await fetch(`${server ?? ""}/api/auth/me`, {
          credentials: "same-origin",
          ...(options.bearerToken ? { headers: { authorization: `Bearer ${options.bearerToken}` } } : {}),
        });
        return response.status === 401 ? "unauthenticated" : "ok";
      } catch {
        return "unreachable";
      }
    },
    onConnected: () => void host.documents.afterConnect(),
    ...(options.onPluginsChanged ? { onPluginsChanged: options.onPluginsChanged } : {}),
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
      message: "Your settings could not be read, so defaults are in use. Reload to try again.",
      detail: reason,
    });
  });

  // The kernel has no DOM; the app owns these three triggers (PROTOCOL.md §8).
  addEventListener("online", () => sync.reconnectNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync.reconnectNow();
  });
  await host.documents.start();
  await sync.start();

  // SPEC §6.4: ask for persistent storage at first sign-in on this device, and warn
  // only when that ask is refused (dev-docs/resolved/SYNC-DECISIONS.md §12). Asking on every boot
  // made some browsers prompt every time, and the warning showed on every launch.
  //
  // **Not inside the shell.** `navigator.storage.persist()` answers for a *browser*
  // profile's eviction policy; in the Flutter webview the workspace lives in the app's
  // own private storage, which Android clears only when the app is uninstalled or the
  // user clears its data.
  // The desktop shell is a browser profile of its own, so it asks like a tab does.
  if (!shellOwnsSession()) void askForPersistentStorage(host);

  return { host, store, engine, sync, core };
}

/** Remembers, per device, that the browser has been asked. */
const STORAGE_ASKED_KEY = "life-manager:storage-asked";

async function askForPersistentStorage(host: KernelHost): Promise<void> {
  let asked: string | null = null;
  try {
    asked = localStorage.getItem(STORAGE_ASKED_KEY);
  } catch {
    // No storage access: ask every time, which is the old behaviour.
  }
  if (asked !== null) return;
  const ask = async (): Promise<void> => {
    const report = await host.capabilities.requestPersistence();
    try {
      localStorage.setItem(STORAGE_ASKED_KEY, report.persisted ? "granted" : "refused");
    } catch {
      /* see above */
    }
    if (report.persisted) {
      host.notices.dismiss("kernel:storage-not-persisted");
      return;
    }
    host.notices.notify({
      id: "kernel:storage-not-persisted",
      level: "warning",
      // Risk and remedy in one breath, in the message: a `<details>` the reader has to
      // open is not where you put the half that tells them what to do.
      message:
        "The browser may delete this workspace's offline copy if storage runs low: it did not agree to keep it for good. Sync while you are online so nothing is lost.",
      actions: [{ label: "Ask again", run: () => void ask() }],
    });
  };
  await ask();
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

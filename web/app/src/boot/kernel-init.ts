import { IdbDocPersistence, IdbProjectionStore } from "@kernel/store/index.js";
import { QueryEngine, createSearchIndex } from "@kernel/query/index.js";
import { SyncClient } from "@kernel/sync/index.js";
import { loadCore, type CoreBindings } from "@kernel/wasm/index.js";
import { KernelHost, type PluginProblem } from "@kernel/runtime/index.js";
import type { BootMode, LogoutOptions, SessionUser } from "@kernel";

import { shellOwnsSession } from "./shell.js";

export interface KernelInitOptions {
  readonly user: SessionUser;
  readonly bearerToken?: string;
  readonly serverBaseUrl?: string;
  readonly root: HTMLElement;
  readonly bootMode: BootMode;
  readonly logout: (options: LogoutOptions) => Promise<void>;
  readonly onPluginProblem?: (problem: PluginProblem) => void;
  readonly onPluginsChanged?: (version: number | string) => void;
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
    const reason = error instanceof Error ? error : new Error(String(error));
    options.onCoreUnavailable?.(reason);
    core = unavailableCore(reason.message);
  }

  const store = new IdbProjectionStore();
  await store.open();

  const engine = new QueryEngine(store, core, createSearchIndex());
  engine.warmUp().catch((error: unknown) => console.warn("[search] warm-up failed", error));

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
      persistedReplicas: Number.POSITIVE_INFINITY,
      ...(server ? { restBaseUrl: server } : {}),
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
      onLocalEdit: (id, text) => host.documents.onLocalEdit(id, text),
      onOfflineEditsSent: (id) => host.documents.onOfflineEditsSent(id),
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
      ...(server ? { apiBase: `${server}/api` } : {}),
      logout: options.logout,
    },
    ...(options.onPluginProblem ? { onPluginProblem: options.onPluginProblem } : {}),
  });

  await host.settings.start().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    host.notices.notify({
      id: "kernel:settings-unavailable",
      level: "warning",
      message: "Your settings could not be read, so defaults are in use. Reload to try again.",
      detail: reason,
    });
  });

  addEventListener("online", () => sync.reconnectNow());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync.reconnectNow();
  });
  await host.documents.start();
  await sync.start();

  if (!shellOwnsSession()) void askForPersistentStorage(host);

  return { host, store, engine, sync, core };
}

const STORAGE_ASKED_KEY = "ddd:storage-asked";

async function askForPersistentStorage(host: KernelHost): Promise<void> {
  let asked: string | null = null;
  try {
    asked = localStorage.getItem(STORAGE_ASKED_KEY);
  } catch {
  }
  if (asked !== null) return;
  const ask = async (): Promise<void> => {
    const report = await host.capabilities.requestPersistence();
    try {
      localStorage.setItem(STORAGE_ASKED_KEY, report.persisted ? "granted" : "refused");
    } catch {
    }
    if (report.persisted) {
      host.notices.dismiss("kernel:storage-not-persisted");
      return;
    }
    host.notices.notify({
      id: "kernel:storage-not-persisted",
      level: "warning",
      message:
        "The browser may delete this workspace's offline copy if storage runs low: it did not agree to keep it for good. Sync while you are online so nothing is lost.",
      actions: [{ label: "Ask again", run: () => void ask() }],
    });
  };
  await ask();
}

function unavailableCore(reason: string): CoreBindings {
  const fail = (): never => {
    throw new Error(`the shared Wasm core is unavailable (${reason}); run \`mise run wasm\``);
  };
  return {
    parseDocument: fail,
    evaluateFilter: fail,
    resolveTitle: fail,
    normalizeDate: fail,
    queryEngine: fail,
    semanticsVersion: () => -1,
  };
}

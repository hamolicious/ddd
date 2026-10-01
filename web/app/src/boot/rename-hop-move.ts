/**
 * RENAME-HOP: move this device from the old domain to the canonical one.
 *
 * Browser storage belongs to an origin, so nothing can be carried across. During the
 * hop the server answers on both domains and says which one is canonical
 * (`GET /api/auth/bootstrap` → `public_url`). A page on any other origin tells the
 * person, waits until everything this device holds has reached the server — the
 * socket is up, nothing is pending or unsent, no file is waiting to upload, two polls
 * in a row — and only then clears this origin and goes. On the new domain they sign in
 * again and the replica downloads afresh. Until it is safe it keeps syncing and keeps
 * waiting; nothing is cleared on a failure.
 *
 * Not in the Flutter shell (its page origin is a loopback server; the owner accepts it
 * breaking). Deleted, with `rename-hop.ts`, by the cleanup release.
 */

import { authBootstrap } from "./api.js";
import { hardRefresh } from "./hard-refresh.js";
import type { KernelRuntime } from "./kernel-init.js";
import { shellOwnsSession } from "./shell.js";

/** How often readiness is checked. */
export const POLL_MS = 2_000;
/** How long to wait before asking the server again when it could not be reached. */
const RETRY_MS = 30_000;
/** Readiness must hold this many polls in a row. */
const SETTLED_POLLS = 2;

const ATTACHMENT_QUEUE_DB = "ddd:attachments";
const ATTACHMENT_QUEUE_STORE = "waiting";
const SEARCH_DB = "ddd-search";

export interface Readiness {
  readonly connected: boolean;
  /** Edits the socket has not carried. */
  readonly pending: number;
  /** Documents with changes the server has not acknowledged. */
  readonly unsent: number;
  /** Files waiting to upload. */
  readonly uploads: number;
}

export interface MoveDeps {
  /** `public_url` from the server; rejects when it cannot be reached. */
  publicUrl(): Promise<string | null | undefined>;
  readonly origin: string;
  /** The Flutter shell, which is left alone. */
  readonly shellOwnsSession: boolean;
  readiness(): Promise<Readiness>;
  /** Show (or update) the persistent notice. */
  announce(host: string): void;
  /** Clear everything this origin holds. Best-effort per step. */
  cleanup(): Promise<void>;
  /** Go to the canonical origin. */
  move(origin: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  warn?(message: string, cause?: unknown): void;
}

/** The canonical origin to move to, or `undefined` to stay. */
export function canonicalOrigin(publicUrl: string | null | undefined, origin: string): string | undefined {
  if (!publicUrl) return undefined;
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return url.origin === origin ? undefined : url.origin;
}

/** Everything this device holds has reached the server. */
export const settled = (r: Readiness): boolean => r.connected && r.pending === 0 && r.unsent === 0 && r.uploads === 0;

/** Wait for a safe moment, then clear this origin and move. Resolves `"stay"` when there is nowhere to go. */
export async function runDomainMove(deps: MoveDeps): Promise<"stay" | "moved"> {
  const warn = deps.warn ?? ((message: string, cause?: unknown) => console.warn(`[rename-hop] ${message}`, cause ?? ""));
  if (deps.shellOwnsSession) return "stay";

  let target: string | undefined;
  for (;;) {
    try {
      target = canonicalOrigin(await deps.publicUrl(), deps.origin);
      break;
    } catch (cause) {
      warn("the server could not be asked for its canonical address; trying again", cause);
      await deps.sleep(RETRY_MS);
    }
  }
  if (target === undefined) return "stay";
  deps.announce(new URL(target).host);

  let streak = 0;
  for (;;) {
    let ok = false;
    try {
      ok = settled(await deps.readiness());
    } catch (cause) {
      warn("readiness could not be checked", cause);
    }
    streak = ok ? streak + 1 : 0;
    if (streak >= SETTLED_POLLS) break;
    await deps.sleep(POLL_MS);
  }

  await deps.cleanup();
  await deps.move(target);
  return "moved";
}

/** RENAME-HOP: the wiring for a running app. Fire and forget; it never throws. */
export function moveToCanonicalDomain(runtime: KernelRuntime): void {
  const { host } = runtime;
  runDomainMove({
    publicUrl: async () => (await authBootstrap()).public_url,
    origin: location.origin,
    shellOwnsSession: shellOwnsSession(),
    readiness: async () => {
      const status = host.sync.api().state.status;
      return {
        connected: status === "syncing" || status === "synced",
        pending: runtime.sync.pending,
        unsent: await host.documents.unsentCount(),
        uploads: await waitingUploads(),
      };
    },
    announce: (target) => {
      host.notices.notify({
        id: "kernel:rename-hop-move",
        level: "warning",
        message: `ddd has moved to ${target}. This device is finishing its sync here first.`,
        detail: `Keep this page open and online. Once everything here has reached the server, ddd opens ${target}, where you sign in again.`,
      });
    },
    cleanup: () => clearOrigin(runtime),
    move: async (origin) => {
      const shell = (window as { shell?: { server?: { move?: (params: { url: string }) => Promise<unknown> } } }).shell;
      const server = shell?.server;
      if (typeof server?.move === "function") {
        try {
          await server.move({ url: origin });
          return;
        } catch (cause) {
          console.warn("[rename-hop] the desktop shell could not move; navigating instead", cause);
        }
      }
      location.replace(origin + location.pathname + location.search + location.hash);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }).catch((cause: unknown) => console.warn("[rename-hop] the move to the canonical domain failed", cause));
}

/** Files in the attachments upload queue; a missing database or store counts as none. */
async function waitingUploads(): Promise<number> {
  const listed = await indexedDB.databases?.();
  if (listed && !listed.some((db) => db.name === ATTACHMENT_QUEUE_DB)) return 0;
  const db = await new Promise<IDBDatabase | undefined>((resolve, reject) => {
    const request = indexedDB.open(ATTACHMENT_QUEUE_DB);
    let created = false;
    // Never create it here: the plugin creates it at version 1 with its store.
    request.onupgradeneeded = () => {
      created = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => {
      if (!created) return reject(request.error ?? new Error("the upload queue could not be opened"));
      event.preventDefault();
      resolve(undefined);
    };
  });
  if (!db) return 0;
  try {
    if (!db.objectStoreNames.contains(ATTACHMENT_QUEUE_STORE)) return 0;
    const count = db.transaction(ATTACHMENT_QUEUE_STORE, "readonly").objectStore(ATTACHMENT_QUEUE_STORE).count();
    return await new Promise<number>((resolve, reject) => {
      count.onsuccess = () => resolve(count.result);
      count.onerror = () => reject(count.error ?? new Error("the upload queue could not be counted"));
    });
  } finally {
    db.close();
  }
}

/** Sign-out's clearing (`main.tsx`), minus the server logout, plus everything else here. */
async function clearOrigin(runtime: KernelRuntime): Promise<void> {
  const step = async (what: string, work: () => unknown): Promise<void> => {
    try {
      await work();
    } catch (cause) {
      console.warn(`[rename-hop] clearing: ${what} failed`, cause);
    }
  };
  await step("settings", () => runtime.host.settings.stop());
  await step("sync", () => runtime.sync.stop());
  await step("engine", () => runtime.engine.close());
  await step("replica", () => runtime.store.clear());
  await step("databases", async () => {
    const databases = (await indexedDB.databases?.()) ?? [];
    for (const { name } of databases) {
      if (name?.startsWith("ddd:") || name === SEARCH_DB) indexedDB.deleteDatabase(name);
    }
  });
  // Every service worker and cache; the reload it would do is the move instead.
  await step("caches and workers", () => hardRefresh({ serviceWorker: navigator.serviceWorker, caches: globalThis.caches, reload: () => undefined }));
  await step("localStorage", () => localStorage.clear());
}

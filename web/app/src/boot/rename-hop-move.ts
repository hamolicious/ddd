/**
 * RENAME-HOP: move this device from the old domain to the canonical one.
 *
 * Browser storage belongs to an origin, so nothing can be carried across. During the
 * hop the server answers on both domains and says which one is canonical and which ones
 * are the old names (`GET /api/auth/bootstrap` → `public_url`, `rename_hop_from`). Only a
 * page on one of those old origins moves: a LAN address, `localhost` or a dev proxy never
 * does, whatever `public_url` says.
 *
 * Such a page tells the person, then waits until everything this device holds has
 * provably reached the server, and only then clears this origin and goes:
 *
 * 1. **readiness**, two polls in a row: sync status exactly `synced` (not `syncing`),
 *    nothing pending or unsent, no file waiting to upload (a paused one must be resumed),
 *    nothing left in the socket's send buffer, and no database from before the rename
 *    still on the device (it may hold the only copy of an edit; see `rename-hop.ts`);
 * 2. **receipt**: a fresh server round trip per document (`DocHydrator.confirmReceived`):
 *    "pending is zero" only means frames were handed to the socket, never that the server
 *    has them;
 * 3. readiness **once more**, then, synchronously with stopping sync, nothing typed since
 *    the receipt check began.
 *
 * Then the old session is signed out (best-effort), this origin's databases, caches,
 * workers and localStorage are cleared, and the page moves. On the new domain the person
 * signs in again and the replica downloads afresh. Until it is safe it keeps syncing and
 * keeps waiting, saying what for; nothing is cleared on a failure.
 *
 * Not in the Flutter shell (its page origin is a loopback server; the owner accepts it
 * breaking). Deleted, with `rename-hop.ts`, by the cleanup release.
 */

import { authBootstrap, logoutRequest, type AuthBootstrap } from "./api.js";
import { hardRefresh } from "./hard-refresh.js";
import type { KernelRuntime } from "./kernel-init.js";
import { databaseNames, legacyDatabasesLeft, type MigrationOutcome } from "./rename-hop.js";
import { shellOwnsSession } from "./shell.js";

/** How often readiness is checked. */
export const POLL_MS = 2_000;
/** How long to wait before asking the server again when it could not be reached. */
const RETRY_MS = 30_000;
/** After a receipt check that did not pass: time for the re-send it triggered to land. */
export const CONFIRM_RETRY_MS = 10_000;
/** Readiness must hold this many polls in a row. */
const SETTLED_POLLS = 2;

const ATTACHMENT_QUEUE_DB = "ddd:attachments";
const ATTACHMENT_QUEUE_STORE = "waiting";
const SEARCH_DB = "ddd-search";

const MOVE_NOTICE = "kernel:rename-hop-move";
const STRANDED_NOTICE = "kernel:rename-hop-stranded";

export interface Readiness {
  /** The sync status; only exactly `synced` will do. */
  readonly status: string;
  /** Edits and queued changes the socket has not carried. */
  readonly pending: number;
  /** Notes with changes the server may not have, plus queued trash and restore. */
  readonly unsent: number;
  /** Files waiting to upload. */
  readonly uploads: number;
  /** Of those, the ones the person paused: they wait until resumed. */
  readonly pausedUploads: number;
  /** Bytes still in the socket's send buffer. */
  readonly buffered: number;
  /** Databases from before the rename still on this device. */
  readonly legacyDatabases: readonly string[];
}

export type ServerInfo = Pick<AuthBootstrap, "public_url" | "rename_hop_from">;

export interface MoveDeps {
  /** What the server says about addresses; rejects when it cannot be reached. */
  bootstrap(): Promise<ServerInfo>;
  readonly origin: string;
  /** The Flutter shell, which is left alone. */
  readonly shellOwnsSession: boolean;
  readiness(): Promise<Readiness>;
  /** A fresh round trip proving the server holds everything this device holds. */
  confirm(): Promise<boolean>;
  /** Show (or update) the persistent notice; `waitingFor` says what it waits on. */
  announce(host: string, waitingFor: string | undefined): void;
  /** Old databases still here (empty: none, so the notice about them goes). */
  stranded(names: readonly string[]): void;
  /**
   * Clear everything this origin holds, best-effort per step. Resolves `false`, having
   * touched nothing, when its last check finds something new to send.
   */
  cleanup(): Promise<boolean>;
  /** Go to the canonical origin. */
  move(origin: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  warn?(message: string, cause?: unknown): void;
}

const originOf = (raw: unknown): string | undefined => {
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
};

/** The canonical origin, when it is a valid http(s) one other than this. */
export function canonicalOrigin(publicUrl: string | null | undefined, origin: string): string | undefined {
  const target = originOf(publicUrl);
  return target === undefined || target === origin ? undefined : target;
}

/**
 * Where to move, or `undefined` to stay: only from an origin the server names as an old
 * one (`rename_hop_from`; missing on an older server, which means none).
 */
export function moveTarget(info: ServerInfo, origin: string): string | undefined {
  const target = canonicalOrigin(info.public_url, origin);
  if (target === undefined) return undefined;
  const from = Array.isArray(info.rename_hop_from) ? info.rename_hop_from : [];
  return from.some((old) => originOf(old) === origin) ? target : undefined;
}

/** Everything this device holds has been handed over, and nothing old is left behind. */
export const settled = (r: Readiness): boolean =>
  r.status === "synced" &&
  r.pending === 0 &&
  r.unsent === 0 &&
  r.uploads === 0 &&
  r.pausedUploads === 0 &&
  r.buffered === 0 &&
  r.legacyDatabases.length === 0;

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const list = (parts: readonly string[]): string =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/** What the move is waiting for, in words; `undefined` when nothing (it is confirming). */
export function waitingFor(r: Readiness): string | undefined {
  if (r.legacyDatabases.length > 0) return "data from before the rename that could not be moved yet";
  const parts: string[] = [];
  const changes = Math.max(r.pending, r.unsent);
  const uploads = r.uploads - r.pausedUploads;
  if (changes > 0) parts.push(count(changes, "change"));
  if (uploads > 0) parts.push(count(uploads, "upload"));
  const sending = parts.length > 0 ? `${list(parts)} still to send` : undefined;
  const paused = r.pausedUploads > 0 ? `${count(r.pausedUploads, "paused upload")} to resume` : undefined;
  const offline =
    r.status === "auth-required"
      ? "you to sign in again"
      : r.status === "synced" || r.status === "syncing"
        ? undefined
        : "a connection to the server";
  const said = [sending, paused, offline].filter((part): part is string => part !== undefined);
  if (said.length > 0) return list(said);
  if (r.status !== "synced" || r.buffered > 0) return "the sync to finish";
  return undefined;
}

/** Wait for a provably safe moment, then clear this origin and move. `"stay"` when there is nowhere to go. */
export async function runDomainMove(deps: MoveDeps): Promise<"stay" | "moved"> {
  const warn = deps.warn ?? ((message: string, cause?: unknown) => console.warn(`[rename-hop] ${message}`, cause ?? ""));
  if (deps.shellOwnsSession) return "stay";

  let target: string | undefined;
  for (;;) {
    try {
      target = moveTarget(await deps.bootstrap(), deps.origin);
      break;
    } catch (cause) {
      warn("the server could not be asked for its canonical address; trying again", cause);
      await deps.sleep(RETRY_MS);
    }
  }
  if (target === undefined) return "stay";
  const host = new URL(target).host;
  deps.announce(host, undefined);

  const check = async (): Promise<Readiness | undefined> => {
    try {
      const readiness = await deps.readiness();
      deps.stranded(readiness.legacyDatabases);
      return readiness;
    } catch (cause) {
      warn("readiness could not be checked", cause);
      return undefined;
    }
  };

  let streak = 0;
  for (;;) {
    const readiness = await check();
    if (readiness) deps.announce(host, waitingFor(readiness));
    streak = readiness && settled(readiness) ? streak + 1 : 0;
    if (streak < SETTLED_POLLS) {
      await deps.sleep(POLL_MS);
      continue;
    }
    streak = 0;

    let confirmed = false;
    try {
      confirmed = await deps.confirm();
    } catch (cause) {
      warn("the server could not confirm what it has", cause);
    }
    if (!confirmed) {
      deps.announce(host, "the server to confirm it has every change");
      await deps.sleep(CONFIRM_RETRY_MS);
      continue;
    }

    // Once more, right before anything is cleared: the receipt check takes a while.
    const again = await check();
    if (!again || !settled(again)) continue;
    let cleared = false;
    try {
      cleared = await deps.cleanup();
    } catch (cause) {
      warn("clearing this address failed", cause);
    }
    if (!cleared) {
      await deps.sleep(POLL_MS);
      continue;
    }
    await deps.move(target);
    return "moved";
  }
}

/** The person's wording for old databases still on the device. */
function strandedDetail(outcome: MigrationOutcome, names: readonly string[]): string {
  if (names.some((name) => outcome.stranded.get(name) === "both-exist")) {
    return "A newer copy was started on this device before the old one could be moved, so both are kept and nothing moves until that is sorted out. Nothing has been deleted.";
  }
  return "Close other ddd tabs and make sure there is free disk space, then reload. Nothing has been deleted.";
}

/** RENAME-HOP: the wiring for a running app. Fire and forget; it never throws. */
export function moveToCanonicalDomain(runtime: KernelRuntime, outcome: MigrationOutcome): void {
  const { host, sync } = runtime;
  let shownStranded = "";
  const stranded = (names: readonly string[]): void => {
    const key = names.join("\n");
    if (key === shownStranded) return;
    shownStranded = key;
    if (names.length === 0) {
      host.notices.dismiss(STRANDED_NOTICE);
      return;
    }
    host.notices.notify({
      id: STRANDED_NOTICE,
      level: "error",
      message: "This device still has data from before the rename that could not be moved yet.",
      detail: strandedDetail(outcome, names),
    });
  };
  // On any origin, moving or not: the person should know.
  stranded([...outcome.stranded.keys()].sort());

  let shownMove = "";
  /** `localEdits` when the last receipt check began: the cleanup's last word. */
  let confirmedMark: number | undefined;

  runDomainMove({
    bootstrap: () => authBootstrap(),
    origin: location.origin,
    shellOwnsSession: shellOwnsSession(),
    readiness: async () => {
      const uploads = await waitingUploads();
      return {
        status: sync.status,
        pending: sync.pending,
        unsent: await host.documents.unsentCount(),
        uploads: uploads.total,
        pausedUploads: uploads.paused,
        buffered: sync.transport.bufferedAmount,
        legacyDatabases: await legacyDatabasesLeft(),
      };
    },
    confirm: async () => {
      const mark = sync.docs.localEdits;
      const report = await sync.docs.confirmReceived({ repair: true });
      if (!report.confirmed) {
        console.info("[rename-hop] not confirmed yet", report);
        confirmedMark = undefined;
        return false;
      }
      confirmedMark = mark;
      return true;
    },
    announce: (target, waiting) => {
      const detail =
        `Keep this page open and online. Once the server has confirmed it has everything from this device, ddd opens ${target}, where you sign in again.` +
        (waiting ? ` Waiting for: ${waiting}.` : "");
      if (detail === shownMove) return;
      shownMove = detail;
      host.notices.notify({
        id: MOVE_NOTICE,
        level: "warning",
        message: `ddd has moved to ${target}. This device is finishing its sync here first.`,
        detail,
      });
    },
    stranded,
    cleanup: async () => {
      // The last check and stopping sync happen in one synchronous step, so nothing can be
      // typed between them: after `stop()` an edit could only queue, and would be cleared.
      if (
        !stillQuiet({
          confirmedMark,
          localEdits: sync.docs.localEdits,
          status: sync.status,
          pending: sync.pending,
          buffered: sync.transport.bufferedAmount,
        })
      ) {
        return false;
      }
      sync.stop();
      await clearOrigin({
        stopSettings: () => host.settings.stop(),
        logout: () => logoutRequest(),
        closeEngine: () => runtime.engine.close(),
        clearReplica: () => runtime.store.clear(),
        indexedDB: globalThis.indexedDB,
        dropCaches: () => hardRefresh({ serviceWorker: navigator.serviceWorker, caches: globalThis.caches, reload: () => undefined }),
        localStorage: globalThis.localStorage,
      });
      return true;
    },
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

/** Files in the attachments upload queue, and how many of them are paused. */
async function waitingUploads(): Promise<{ total: number; paused: number }> {
  const listed = await indexedDB.databases?.();
  if (listed && !listed.some((db) => db.name === ATTACHMENT_QUEUE_DB)) return { total: 0, paused: 0 };
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
  if (!db) return { total: 0, paused: 0 };
  try {
    if (!db.objectStoreNames.contains(ATTACHMENT_QUEUE_STORE)) return { total: 0, paused: 0 };
    const cursor = db.transaction(ATTACHMENT_QUEUE_STORE, "readonly").objectStore(ATTACHMENT_QUEUE_STORE).openCursor();
    return await new Promise((resolve, reject) => {
      let total = 0;
      let paused = 0;
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return resolve({ total, paused });
        total += 1;
        if ((at.value as { paused?: boolean } | undefined)?.paused === true) paused += 1;
        at.continue();
      };
      cursor.onerror = () => reject(cursor.error ?? new Error("the upload queue could not be read"));
    });
  } finally {
    db.close();
  }
}

export interface ClearDeps {
  stopSettings(): unknown;
  /** `POST /api/auth/logout`. */
  logout(): Promise<unknown>;
  closeEngine(): unknown;
  clearReplica(): unknown;
  readonly indexedDB: IDBFactory;
  /** Every service worker and cache, old names included. */
  dropCaches(): Promise<unknown>;
  readonly localStorage: Pick<Storage, "clear"> | undefined;
  warn?(message: string, cause?: unknown): void;
}

/** This origin's databases that go: plugin ones, the search index, and every pre-rename one. */
export const clearedDatabase = (name: string): boolean =>
  name.startsWith("ddd:") || name === SEARCH_DB || name.startsWith("life-manager");

/**
 * Sign-out's clearing (`main.tsx`), plus everything else here. Runs only once the move is
 * proven safe, and after sync has stopped. Each step is attempted whatever the one before did.
 */
export async function clearOrigin(deps: ClearDeps): Promise<void> {
  const warn = deps.warn ?? ((message: string, cause?: unknown) => console.warn(`[rename-hop] ${message}`, cause ?? ""));
  const step = async (what: string, work: () => unknown): Promise<void> => {
    try {
      await work();
    } catch (cause) {
      warn(`clearing: ${what} failed`, cause);
    }
  };
  await step("settings", () => deps.stopSettings());
  // The old session goes with the old address: the server revokes it and expires both
  // cookies (the current and the pre-rename one). Offline, it expires on its own.
  await step("sign-out", () => deps.logout());
  await step("engine", () => deps.closeEngine());
  await step("replica", () => deps.clearReplica());
  await step("databases", async () => {
    // Every old database too: readiness proved none is left holding anything (and the
    // search index never does). Listed, or probed where the browser cannot list.
    for (const name of await databaseNames(deps.indexedDB)) {
      if (clearedDatabase(name)) deps.indexedDB.deleteDatabase(name);
    }
  });
  await step("caches and workers", () => deps.dropCaches());
  await step("localStorage", () => deps.localStorage?.clear());
}

/** The cleanup's last word, checked in the same synchronous step that stops sync. */
export function stillQuiet(now: {
  readonly confirmedMark: number | undefined;
  readonly localEdits: number;
  readonly status: string;
  readonly pending: number;
  readonly buffered: number;
}): boolean {
  return (
    now.confirmedMark !== undefined &&
    now.localEdits === now.confirmedMark &&
    now.status === "synced" &&
    now.pending === 0 &&
    now.buffered === 0
  );
}

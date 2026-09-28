/**
 * The M2 demo page: login, a live document list served by the **local** query
 * engine, full-text search, and a textarea bound to one hydrated `Y.Text`.
 *
 * It is deliberately plain TypeScript with no framework — its job is to prove the
 * kernel works end to end (and to be the thing the Playwright smoke drives:
 * register → create → edit → reload → offline edit → reconnect → converge, SPEC
 * §8). The real UI is a plugin distribution, in M3.
 *
 * Two properties this page is built to demonstrate, because they are the point of
 * SPEC §4:
 *
 * 1. **Nothing renders from the network.** The list and the search box read the
 *    IndexedDB projection through `QueryEngine`; the socket's only job is to keep
 *    that store fresh. Load once, then pull the plug: the workspace is still
 *    browsable and searchable, and documents you had open stay editable.
 * 2. **Edits are splices.** The textarea sends the minimal insert/delete pair, not
 *    a whole-text replacement, so two clients editing one document merge instead
 *    of clobbering (SPEC §3.2, §3.3).
 *
 * This file is *wiring only*: every behaviour it needs is a kernel call. While a
 * kernel stub is unimplemented the page still renders and reports the error it
 * got, which is exactly the signal a builder wants.
 */

import * as Y from "yjs";

import { IdbProjectionStore } from "@kernel/store/index.js";
import { QueryEngine, createSearchIndex, parseSortKey } from "@kernel/query/index.js";
import { SyncClient } from "@kernel/sync/index.js";
import { loadCore, type CoreBindings } from "@kernel/wasm/index.js";
import type { FeedState, ProjectionRow, Query, Subscription } from "@kernel/index.js";

import { authBootstrap, createDocument, login, logout, register, storedToken } from "./api.js";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const ui = {
  login: el<HTMLFormElement>("login"),
  email: el<HTMLInputElement>("email"),
  password: el<HTMLInputElement>("password"),
  signIn: el<HTMLButtonElement>("sign-in"),
  register: el<HTMLButtonElement>("register"),
  logout: el<HTMLButtonElement>("logout"),
  search: el<HTMLInputElement>("search"),
  create: el<HTMLButtonElement>("new"),
  status: el<HTMLSpanElement>("status"),
  seq: el<HTMLSpanElement>("seq"),
  count: el<HTMLSpanElement>("count"),
  notice: el<HTMLDivElement>("notice"),
  docs: el<HTMLUListElement>("docs"),
  openTitle: el<HTMLSpanElement>("open-title"),
  text: el<HTMLTextAreaElement>("text"),
  log: el<HTMLPreElement>("log"),
};

function log(message: string, error?: unknown): void {
  const line = error ? `${message}: ${error instanceof Error ? error.message : String(error)}` : message;
  ui.log.textContent = `${new Date().toISOString()}  ${line}\n${ui.log.textContent ?? ""}`.slice(0, 8_000);
}

function notice(message: string | undefined): void {
  ui.notice.textContent = message ?? "";
  ui.notice.hidden = !message;
}

// ---------------------------------------------------------------------------
// Kernel wiring
// ---------------------------------------------------------------------------

const store = new IdbProjectionStore();
let engine: QueryEngine | undefined;
let client: SyncClient | undefined;
let live: Subscription | undefined;
let openDoc: { id: string; text: Y.Text; release: () => void } | undefined;
let coreSemantics: number | undefined;

/**
 * Stand-in for a core that failed to load (`mise run wasm` never run). Everything
 * that does not need Rust semantics — the list, sorting, search — keeps working;
 * anything that would silently diverge from the server refuses loudly instead.
 */
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
    resolveWiring: fail,
    planWiring: fail,
    wiringCandidates: fail,
    shapeFits: fail,
  };
}

async function boot(): Promise<void> {
  registerServiceWorker();

  let core: CoreBindings;
  try {
    core = await loadCore();
    coreSemantics = core.semanticsVersion();
    log(`shared core loaded (semantics v${coreSemantics})`);
  } catch (error) {
    core = unavailableCore(error instanceof Error ? error.message : String(error));
    notice("The shared Wasm core is not built — filters are disabled. Run `mise run wasm`.");
    log("wasm core unavailable", error);
  }

  try {
    await store.open();
  } catch (error) {
    log("projection store unavailable (kernel store not implemented yet)", error);
  }

  engine = new QueryEngine(store, core, createSearchIndex());
  engine.onError((error) => log("query engine", error));
  // A debugging handle, not an API: poke at the kernel from the devtools console
  // (`lm.engine.run({})`, `lm.store.count()`). The demo is the only place this
  // exists — M3's kernel exposes `@kernel` to plugins instead.
  Object.assign(globalThis, { lm: { store, engine, get client() { return client; } } });
  // Start indexing before anyone types; a warm index means search is instant and
  // a cold one is built in the worker, not on this thread (SPEC §4.2).
  engine.warmUp().catch((error: unknown) => log("search index", error));

  await refresh();
  await connect();
}

/** Open (or reopen) the live query behind the list. */
async function refresh(): Promise<void> {
  if (!engine) return;
  const text = ui.search.value.trim();
  const query: Query = text
    ? { search: text, includeDeleted: true, limit: 200 }
    : { sort: [parseSortKey("-updated_at")], includeDeleted: true, limit: 200 };

  live?.close();
  live = undefined;
  try {
    const subscription = await engine.subscribe(query);
    live = subscription;
    subscription.onChange((result) => renderDocs(result.rows, result.total));
    renderDocs(subscription.result.rows, subscription.result.total);
  } catch (error) {
    ui.docs.replaceChildren();
    log("document list unavailable", error);
  }
}

async function connect(): Promise<void> {
  const token = storedToken();
  client?.stop();
  client = new SyncClient(store, {
    transport: { bearerToken: token },
    bootstrap: { bearerToken: token },
    hydrator: {
      onError: (id, error) => log(`document ${id}: ${error.code}`, new Error(error.message)),
    },
    onState: renderState,
  });
  try {
    await client.start();
  } catch (error) {
    renderState({ status: navigator.onLine ? "error" : "offline", safeSeq: 0, headSeq: 0 });
    log("sync", error);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * What the *browser* thinks of the network, which is not the same thing as what
 * the socket has noticed yet.
 *
 * A socket carrying no traffic does not fail the instant the network drops: the
 * client finds out through its own heartbeat, up to `heartbeat_secs` plus the pong
 * timeout later (PROTOCOL.md §5) — tens of seconds of the page claiming `synced`
 * with no network. `navigator.onLine` knows immediately, so it wins.
 */
let browserOffline = typeof navigator !== "undefined" && navigator.onLine === false;

function renderState(state: FeedState): void {
  // `auth-required` and `error` are more specific than "the network is down" and
  // are not fixed by it coming back, so they still show through.
  const status =
    browserOffline && state.status !== "auth-required" && state.status !== "error"
      ? "offline"
      : state.status;
  ui.status.textContent = state.bootstrap
    ? `${status} ${state.bootstrap.rows}/${state.bootstrap.total}`
    : status;
  ui.status.dataset["status"] = status;
  ui.seq.textContent = `seq ${state.safeSeq}`;
  if (state.status === "auth-required") {
    // SPEC §5.3: a 401 never clears local data — it asks for a password.
    notice("Your session expired. Sign in again; nothing local was discarded.");
  }
  const welcome = client?.welcome;
  if (welcome && coreSemantics !== undefined && welcome.core_semantics_version !== coreSemantics) {
    // PROTOCOL.md §1.4: keep syncing, stop trusting the local parse.
    notice(
      `This client parses documents differently from the server (core v${coreSemantics} vs v${welcome.core_semantics_version}). Reload to update.`,
    );
  }
}

/** Titles by id, so the delegated click handler can name the document it opens. */
const rowTitles = new Map<string, string>();

/**
 * Render the list by **reconciling against the existing rows**, keyed by id.
 *
 * `replaceChildren` with a fresh `<li>` per row was simpler and wrong: the list is
 * live (it re-runs on every feed batch and sorts by `-updated_at`), so a rebuild
 * can land between a click's hit-test and its mouse event, and the click opens
 * whichever document now occupies that pixel. Reusing the node for an id means the
 * row under the pointer is the same node before and after an update.
 */
function renderDocs(rows: readonly ProjectionRow[], total: number): void {
  ui.count.textContent = `${total} docs`;

  const existing = new Map<string, HTMLLIElement>();
  for (const node of ui.docs.children) {
    const id = node.getAttribute("data-id");
    if (id) existing.set(id, node as HTMLLIElement);
  }

  rowTitles.clear();
  let cursor: Element | null = ui.docs.firstElementChild;
  for (const row of rows) {
    const title = row.title || "Untitled";
    rowTitles.set(row.id, title);

    let item = existing.get(row.id);
    if (item) {
      existing.delete(row.id);
    } else {
      item = document.createElement("li");
      item.setAttribute("role", "option");
      item.setAttribute("data-id", row.id);
      item.append(document.createTextNode(""), document.createElement("small"));
    }

    // Only touch what actually changed, so unrelated rows do not flicker.
    const label = item.firstChild as Text;
    if (label.data !== title) label.data = title;
    const meta = item.lastElementChild as HTMLElement;
    const metaText = `${row.id} · ${row.updated_at}`;
    if (meta.textContent !== metaText) meta.textContent = metaText;
    const className = row.deleted ? "deleted" : "";
    if (item.className !== className) item.className = className;
    const selected = String(openDoc?.id === row.id);
    if (item.getAttribute("aria-selected") !== selected) {
      item.setAttribute("aria-selected", selected);
    }

    // Move into place only when it is not already there.
    if (cursor === item) {
      cursor = item.nextElementSibling;
    } else {
      ui.docs.insertBefore(item, cursor);
    }
  }

  for (const stale of existing.values()) stale.remove();
}

// One delegated listener rather than one per row: a per-row closure would capture
// a stale title, and rebinding it on every render is exactly what reconciliation
// is avoiding.
ui.docs.addEventListener("click", (event) => {
  const item = (event.target as Element | null)?.closest("li[data-id]");
  const id = item?.getAttribute("data-id");
  if (id) void openDocument(id, rowTitles.get(id) ?? id);
});

// ---------------------------------------------------------------------------
// One open document
// ---------------------------------------------------------------------------

async function openDocument(id: string, title: string): Promise<void> {
  openDoc?.release();
  openDoc = undefined;
  ui.text.value = "";
  ui.text.readOnly = true;
  ui.openTitle.textContent = `${title} (${id})`;
  // The id of the open document, as an attribute rather than only inside display
  // text: it is what the smoke keys off, and parsing it back out of a
  // human-readable label is how a test ends up asserting against the wrong
  // document.
  ui.openTitle.dataset["docId"] = id;
  try {
    const hydrated = await client!.open(id);
    openDoc = { id, text: hydrated.text, release: () => hydrated.release() };
    bindTextarea(hydrated.text);
    ui.text.readOnly = false;
    log(`opened ${id}`);
  } catch (error) {
    // SPEC §4.1: a document you have never opened is read-only offline. Show the
    // projection text so the page is still useful, and say why it is not editable.
    const row = await engine?.get(id);
    ui.text.value = row?.content ?? "";
    ui.openTitle.textContent = `${title} (${id}) — read-only`;
    log(`open ${id} failed`, error);
  }
  // Repaint the selection without disturbing the live subscription.
  if (live) renderDocs(live.result.rows, live.result.total);
}

/**
 * The crudest possible two-way binding: whole-value on the way in, a single
 * minimal splice on the way out. CodeMirror + `y-codemirror.next` replaces this
 * in M3; the point here is that edits travel as **splices**, not as
 * replace-the-world writes, so concurrent edits merge (SPEC §3.2, §3.3).
 */
function bindTextarea(text: Y.Text): void {
  ui.text.value = text.toString();
  text.observe(() => {
    if (ui.text.value === text.toString()) return;
    const caret = ui.text.selectionStart;
    ui.text.value = text.toString();
    ui.text.setSelectionRange(caret, caret);
  });
  ui.text.oninput = () => {
    const next = ui.text.value;
    const current = text.toString();
    if (next === current) return;
    let prefix = 0;
    while (prefix < next.length && prefix < current.length && next[prefix] === current[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < next.length - prefix &&
      suffix < current.length - prefix &&
      next[next.length - 1 - suffix] === current[current.length - 1 - suffix]
    ) {
      suffix++;
    }
    const removed = current.length - prefix - suffix;
    const inserted = next.slice(prefix, next.length - suffix);
    text.doc?.transact(() => {
      if (removed > 0) text.delete(prefix, removed);
      if (inserted) text.insert(prefix, inserted);
    });
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

ui.login.addEventListener("submit", (event) => {
  event.preventDefault();
  void signIn(false);
});

ui.register.addEventListener("click", () => void signIn(true));

async function signIn(asNewAccount: boolean): Promise<void> {
  notice(undefined);
  try {
    const user = asNewAccount
      ? await register(ui.email.value, ui.password.value)
      : await login(ui.email.value, ui.password.value);
    log(`signed in as ${user.email}`);
    ui.password.value = "";
    await store.open().catch((error: unknown) => log("store", error));
    await connect();
    await refresh();
  } catch (error) {
    notice(`Sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    log(asNewAccount ? "register" : "sign-in", error);
  }
}

ui.logout.addEventListener("click", () => {
  void (async () => {
    // SPEC §5.3: "logout with unsynced changes warns and blocks until synced or
    // explicitly discarded". Logout is the one action that clears local data, so
    // the pending count has to be consulted *before* anything is released — the
    // edits live in the `docs` store this handler is about to wipe, and once it is
    // gone there is nothing to sync and nothing to export.
    const pending = client?.pending ?? 0;
    if (pending > 0) {
      const discard = globalThis.confirm(
        `${pending} local edit${pending === 1 ? "" : "s"} ${
          pending === 1 ? "has" : "have"
        } not reached the server yet. Signing out deletes the local copy.\n\n` +
          "OK to discard them, or Cancel to stay signed in until they sync.",
      );
      if (!discard) {
        notice(
          `Still ${pending} unsynced edit${pending === 1 ? "" : "s"} — staying signed in. ` +
            "Reconnect and wait for the pending count to reach 0.",
        );
        log(`sign-out cancelled with ${pending} unsynced edit(s)`);
        return;
      }
      log(`signing out and discarding ${pending} unsynced edit(s) on the user's say-so`);
    }

    openDoc?.release();
    openDoc = undefined;
    // Back to "nothing open": the pane must not look editable once the replica it
    // was bound to is gone.
    ui.text.readOnly = true;
    ui.text.value = "";
    ui.text.oninput = null;
    ui.openTitle.textContent = "no document open";
    delete ui.openTitle.dataset["docId"];
    client?.stop();
    live?.close();
    live = undefined;
    try {
      await logout();
    } catch (error) {
      log("logout", error);
    }
    // SPEC §5.3: logout — and only logout — clears local data. That includes the
    // derived search index: it holds document text too (shared-device safety).
    await engine?.close();
    await store.clear().catch((error: unknown) => log("clear", error));
    await clearSearchIndex();
    log("signed out, local data cleared");
    await refresh();
  })();
});

async function clearSearchIndex(): Promise<void> {
  const index = engine?.searchIndex;
  if (!index) return;
  try {
    await index.rebuild(
      (async function* () {
        // Nothing: a rebuild from no rows is an empty index.
      })(),
    );
    await index.persist(0);
  } catch (error) {
    log("search index clear", error);
  }
}

ui.create.addEventListener("click", () => {
  // Synchronously, before the first await: otherwise the currently-open document
  // stays editable across the create, and an edit made in that window is applied
  // to the *old* document and then wiped when the new one binds.
  ui.text.readOnly = true;
  void (async () => {
    const stamp = new Date().toISOString();
    try {
      const created = await createDocument(`---\ntitle: Note ${stamp}\n---\n\n`);
      log(`created ${created.id}`);
      await openDocument(created.id, `Note ${stamp}`);
    } catch (error) {
      notice(`Could not create a document: ${error instanceof Error ? error.message : String(error)}`);
      log("create", error);
    }
  })();
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;
ui.search.addEventListener("input", () => {
  if (searchTimer !== undefined) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void refresh(), 150);
});

// Reconnect on regaining connectivity (PROTOCOL.md §8).
addEventListener("online", () => {
  browserOffline = false;
  log("back online");
  void connect();
});
addEventListener("offline", () => {
  // Only the flag: repainting from a synthesised `FeedState` here used to report
  // `seq 0` (losing the real watermark from the pill) and was overwritten by the
  // kernel's next publish anyway, which still said `synced`.
  browserOffline = true;
  log("offline");
  renderState(client?.state ?? { status: "offline", safeSeq: 0, headSeq: 0 });
});

addEventListener("beforeunload", () => {
  openDoc?.release();
  client?.stop();
});

// ---------------------------------------------------------------------------
// Offline app shell (SPEC §8) — hand-written because M2 adds no dependencies.
// ---------------------------------------------------------------------------

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").then(
    () => log("offline shell registered"),
    (error: unknown) => log("offline shell", error),
  );
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

void (async () => {
  await boot();
  try {
    const state = await authBootstrap();
    if (state.needs_first_user) {
      notice("No account exists yet — fill in an email and password and press Create account.");
    }
  } catch {
    // Offline, or the server is down: the page runs on local data either way.
  }
})();

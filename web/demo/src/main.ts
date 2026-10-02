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

const store = new IdbProjectionStore();
let engine: QueryEngine | undefined;
let client: SyncClient | undefined;
let live: Subscription | undefined;
let openDoc: { id: string; text: Y.Text; release: () => void } | undefined;
let coreSemantics: number | undefined;

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
  Object.assign(globalThis, { ddd: { store, engine, get client() { return client; } } });
  engine.warmUp().catch((error: unknown) => log("search index", error));

  await refresh();
  await connect();
}

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

let browserOffline = typeof navigator !== "undefined" && navigator.onLine === false;

function renderState(state: FeedState): void {
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
    notice("Your session expired. Sign in again; nothing local was discarded.");
  }
  const welcome = client?.welcome;
  if (welcome && coreSemantics !== undefined && welcome.core_semantics_version !== coreSemantics) {
    notice(
      `This client parses documents differently from the server (core v${coreSemantics} vs v${welcome.core_semantics_version}). Reload to update.`,
    );
  }
}

const rowTitles = new Map<string, string>();

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

    if (cursor === item) {
      cursor = item.nextElementSibling;
    } else {
      ui.docs.insertBefore(item, cursor);
    }
  }

  for (const stale of existing.values()) stale.remove();
}

ui.docs.addEventListener("click", (event) => {
  const item = (event.target as Element | null)?.closest("li[data-id]");
  const id = item?.getAttribute("data-id");
  if (id) void openDocument(id, rowTitles.get(id) ?? id);
});

async function openDocument(id: string, title: string): Promise<void> {
  openDoc?.release();
  openDoc = undefined;
  ui.text.value = "";
  ui.text.readOnly = true;
  ui.openTitle.textContent = `${title} (${id})`;
  ui.openTitle.dataset["docId"] = id;
  try {
    const hydrated = await client!.open(id);
    openDoc = { id, text: hydrated.text, release: () => hydrated.release() };
    bindTextarea(hydrated.text);
    ui.text.readOnly = false;
    log(`opened ${id}`);
  } catch (error) {
    const row = await engine?.get(id);
    ui.text.value = row?.content ?? "";
    ui.openTitle.textContent = `${title} (${id}) — read-only`;
    log(`open ${id} failed`, error);
  }
  if (live) renderDocs(live.result.rows, live.result.total);
}

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
      })(),
    );
    await index.persist(0);
  } catch (error) {
    log("search index clear", error);
  }
}

ui.create.addEventListener("click", () => {
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

addEventListener("online", () => {
  browserOffline = false;
  log("back online");
  void connect();
});
addEventListener("offline", () => {
  browserOffline = true;
  log("offline");
  renderState(client?.state ?? { status: "offline", safeSeq: 0, headSeq: 0 });
});

addEventListener("beforeunload", () => {
  openDoc?.release();
  client?.stop();
});

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").then(
    () => log("offline shell registered"),
    (error: unknown) => log("offline shell", error),
  );
}

void (async () => {
  await boot();
  try {
    const state = await authBootstrap();
    if (state.needs_first_user) {
      notice("No account exists yet — fill in an email and password and press Create account.");
    }
  } catch {
  }
})();

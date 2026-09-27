/**
 * `kernel.session`: identity, the authenticated `fetch`, and sign-out.
 *
 * The carrier is resolved here once and never again: a browser session rides the
 * cookie (`credentials: "same-origin"`), a shell session carries a bearer token
 * (SPEC §5.2). Plugins never see which.
 *
 * Sign-out is the one destructive path in the client (SPEC §5.3) — it clears the
 * projection, the replicas and the search index — so it is *not* implemented here:
 * the app owns the store handles and the "you have unsynced edits" dialog, and
 * passes the finished procedure in.
 */

import type { AuthVia, LogoutOptions, SessionApi, SessionUser, Unsubscribe } from "@kernel";

export interface SessionHostOptions {
  readonly user: SessionUser;
  readonly via: AuthVia;
  /** Bearer token, when `via === "bearer"`. */
  readonly token?: string;
  /** Base for API calls; default `/api` on the page origin. */
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
  /** Implemented by the app: warn on unsynced edits, clear local data, reload. */
  readonly logout: (options: LogoutOptions) => Promise<void>;
}

/**
 * Server-only screens offline (`docs/SYNC-DECISIONS.md` §9). A GET sent with
 * {@link OFFLINE_COPY_HEADER} keeps its last good response in this cache; when the
 * server cannot be reached, that response is returned instead of the offline error,
 * with {@link CACHED_AT_HEADER} saying when it was loaded, so the screen can say it may be
 * out of date. **Opt-in only**, per request: documents never come through here (they
 * live in IndexedDB under the sync protocol), and a screen that does not mark a stale
 * answer must not be handed one. Deleted on sign-out.
 */
export const API_CACHE = "life-manager:api";
export const OFFLINE_COPY_HEADER = "x-life-manager-offline-copy";
export const CACHED_AT_HEADER = "x-life-manager-cached-at";

async function readOfflineCopy(url: string): Promise<Response | undefined> {
  try {
    const hit = await (await caches.open(API_CACHE)).match(url);
    if (!hit) return undefined;
    const headers = new Headers(hit.headers);
    headers.set(CACHED_AT_HEADER, hit.headers.get("x-life-manager-stored-at") ?? "");
    return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
  } catch {
    return undefined;
  }
}

async function writeOfflineCopy(url: string, response: Response): Promise<void> {
  try {
    const headers = new Headers(response.headers);
    headers.set("x-life-manager-stored-at", new Date().toISOString());
    const copy = new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers });
    await (await caches.open(API_CACHE)).put(url, copy);
  } catch {
    // No Cache Storage (an insecure origin, a full disk): the screen just has no copy.
  }
}

export class SessionHost {
  readonly #authListeners = new Set<() => void>();

  constructor(private readonly options: SessionHostOptions) {}

  get user(): SessionUser {
    return this.options.user;
  }

  /** Called by the app when the socket closes 4401 (SPEC §5.3: data stays put). */
  authRequired(): void {
    for (const listener of [...this.#authListeners]) listener();
  }

  /** The kernel's own API `fetch`; `DocumentsHost` and plugins share it. */
  fetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const base = this.options.apiBase ?? "/api";
    const headers = new Headers(init.headers);
    if (this.options.via === "bearer" && this.options.token) {
      headers.set("authorization", `Bearer ${this.options.token}`);
    }
    const impl = this.options.fetchImpl ?? fetch;
    const url = `${base}${path}`;
    const keepCopy =
      headers.has(OFFLINE_COPY_HEADER) &&
      (init.method ?? "GET").toUpperCase() === "GET" &&
      typeof caches !== "undefined";
    headers.delete(OFFLINE_COPY_HEADER);
    let response: Response;
    try {
      response = await impl(url, {
        credentials: "same-origin",
        ...init,
        headers,
      });
    } catch (cause) {
      // The request never reached the server: offline, or the server is down. The
      // browser's own words ("Failed to fetch") were reaching the screen as-is.
      if (init.signal?.aborted) throw cause;
      const copy = keepCopy ? await readOfflineCopy(url) : undefined;
      if (copy) return copy;
      throw Object.assign(new Error("You are offline, or the server cannot be reached. Try again when you are back online."), {
        status: 0,
        code: "offline",
        cause,
      });
    }
    if (!response.ok) throw await errorFromEnvelope(response);
    if (keepCopy) await writeOfflineCopy(url, response.clone());
    return response;
  };

  api(pluginId: string): SessionApi {
    return {
      user: this.options.user,
      via: this.options.via,
      isAdmin: () => this.options.user.isAdmin,
      fetch: (path, init) => this.fetch(path, init),
      // Namespaced by the kernel, not by the caller: a plugin cannot spell its way
      // into another plugin's routes (SPEC §5.1).
      fetchPlugin: (path, init) =>
        this.fetch(`/plugins/${encodeURIComponent(pluginId)}${path.startsWith("/") ? path : `/${path}`}`, init),
      onAuthRequired: (listener): Unsubscribe => {
        this.#authListeners.add(listener);
        return () => this.#authListeners.delete(listener);
      },
      logout: (options = {}) => this.options.logout(options),
    };
  }
}

/**
 * The server's error envelope as an `Error`: the message is the server's own sentence,
 * ready to show a person; `status` and `code` are there for callers that branch on them
 * (a 409 on a create that is allowed to lose the race, say).
 */
async function errorFromEnvelope(response: Response): Promise<Error & { status: number; code?: string }> {
  let message = `${response.status} ${response.statusText}`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) message = body.error.message;
    code = body.error?.code;
  } catch {
    // Not an envelope (a proxy, an empty body): the status line will do.
  }
  const error = Object.assign(new Error(message), { status: response.status, ...(code ? { code } : {}) });
  error.name = response.status === 401 ? "Unauthorized" : "ApiError";
  return error;
}

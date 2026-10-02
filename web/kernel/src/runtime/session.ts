import type { AuthVia, LogoutOptions, SessionApi, SessionUser, Unsubscribe } from "@kernel";

export interface SessionHostOptions {
  readonly user: SessionUser;
  readonly via: AuthVia;
  readonly token?: string;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
  readonly logout: (options: LogoutOptions) => Promise<void>;
}

export const API_CACHE = "ddd:api";
export const OFFLINE_COPY_HEADER = "x-ddd-offline-copy";
export const CACHED_AT_HEADER = "x-ddd-cached-at";

async function readOfflineCopy(url: string): Promise<Response | undefined> {
  try {
    const hit = await (await caches.open(API_CACHE)).match(url);
    if (!hit) return undefined;
    const headers = new Headers(hit.headers);
    headers.set(CACHED_AT_HEADER, hit.headers.get("x-ddd-stored-at") ?? "");
    return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
  } catch {
    return undefined;
  }
}

async function writeOfflineCopy(url: string, response: Response): Promise<void> {
  try {
    const headers = new Headers(response.headers);
    headers.set("x-ddd-stored-at", new Date().toISOString());
    const copy = new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers });
    await (await caches.open(API_CACHE)).put(url, copy);
  } catch {
  }
}

export class SessionHost {
  readonly #authListeners = new Set<() => void>();

  constructor(private readonly options: SessionHostOptions) {}

  get user(): SessionUser {
    return this.options.user;
  }

  authRequired(): void {
    for (const listener of [...this.#authListeners]) listener();
  }

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

async function errorFromEnvelope(response: Response): Promise<Error & { status: number; code?: string }> {
  let message = `${response.status} ${response.statusText}`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) message = body.error.message;
    code = body.error?.code;
  } catch {
  }
  const error = Object.assign(new Error(message), { status: response.status, ...(code ? { code } : {}) });
  error.name = response.status === 401 ? "Unauthorized" : "ApiError";
  return error;
}

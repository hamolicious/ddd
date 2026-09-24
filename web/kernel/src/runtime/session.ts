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
    const response = await impl(`${base}${path}`, {
      credentials: "same-origin",
      ...init,
      headers,
    });
    if (!response.ok) throw await errorFromEnvelope(response);
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

/** The server's `{error:{code,message}}` envelope, unwrapped (backend/README.md). */
async function errorFromEnvelope(response: Response): Promise<Error> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) message = `${body.error.code ?? response.status}: ${body.error.message}`;
  } catch {
    // Not an envelope (a proxy, an empty body): the status line will do.
  }
  const error = new Error(message);
  error.name = response.status === 401 ? "Unauthorized" : "ApiError";
  return error;
}

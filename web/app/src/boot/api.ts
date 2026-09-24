/**
 * The handful of REST calls the app makes **before** the kernel exists: the auth
 * gate and the plugin list.
 *
 * Everything after boot goes through `kernel.session.fetch`. This file is the one
 * place that talks to the server without a kernel, and it is deliberately tiny.
 *
 * **Cookies, not bearer tokens** (SPEC §5.2): in a browser the session is an
 * HTTP-only cookie the page cannot read, which is the point. The Flutter shell (M5)
 * logs in with `bearer: true` and stores the token in native secure storage; that is
 * why `login()` takes the flag rather than hard-coding either.
 */

import type { InstalledPlugin, SessionUser } from "@kernel";

export interface AuthBootstrap {
  readonly needs_first_user: boolean;
  readonly invite_required: boolean;
}

interface UserView {
  readonly id: string;
  readonly email: string;
  readonly name?: string | null;
  readonly is_admin?: boolean;
}

interface SessionResponse {
  readonly user: UserView;
  readonly token?: string;
  readonly expires_at: string;
}

export interface Signed {
  readonly user: SessionUser;
  /** Present only for bearer clients (the shell). */
  readonly token?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The request never reached the server — no network, DNS, TLS, or the service worker's
 * `NetworkOnly` route rejecting because there is nothing to go to.
 *
 * It exists as its own type because the boot sequence has to tell it apart from a
 * server that answered: "the server says you are not signed in" is a login screen,
 * "there is no server right now" is the offline workspace (SPEC §4.1, §8). A bare
 * `TypeError: Failed to fetch` conflated the two, and the app showed "Life Manager
 * could not start" to a user who was simply on a train.
 */
export class OfflineError extends Error {
  constructor(cause: unknown) {
    super("the server could not be reached", { cause });
    this.name = "OfflineError";
  }
}

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...init,
      headers,
    });
  } catch (cause) {
    // `fetch` rejects only for transport failures; every HTTP status resolves.
    throw new OfflineError(cause);
  }
  if (!response.ok) throw await errorFrom(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text.length > 0 ? (JSON.parse(text) as T) : (undefined as T));
}

async function errorFrom(response: Response): Promise<ApiError> {
  let code = String(response.status);
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) {
      code = body.error.code ?? code;
      message = body.error.message;
    }
  } catch {
    // Not an envelope; the status line is the best we have.
  }
  return new ApiError(response.status, code, message);
}

const toUser = (view: UserView): SessionUser => ({
  id: view.id,
  email: view.email,
  name: view.name ?? null,
  isAdmin: view.is_admin ?? false,
});

/** Is this a fresh install (first user becomes admin) or invite-only? (SPEC §5.1) */
export const authBootstrap = (): Promise<AuthBootstrap> => call<AuthBootstrap>("/auth/bootstrap");

export async function login(email: string, password: string, bearer = false): Promise<Signed> {
  const session = await call<SessionResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, bearer }),
  });
  return { user: toUser(session.user), ...(session.token ? { token: session.token } : {}) };
}

export async function register(
  email: string,
  password: string,
  invite?: string,
  bearer = false,
): Promise<Signed> {
  const session = await call<SessionResponse>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, bearer, invite: invite || undefined }),
  });
  return { user: toUser(session.user), ...(session.token ? { token: session.token } : {}) };
}

/** The signed-in user, or `undefined` on 401. Never throws for "not signed in". */
export async function me(token?: string): Promise<SessionUser | undefined> {
  try {
    return toUser(await call<UserView>("/auth/me", {}, token));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return undefined;
    throw error;
  }
}

export const logoutRequest = (token?: string): Promise<void> =>
  call<void>("/auth/logout", { method: "POST" }, token);

/**
 * The installed frontend plugins, in no particular order — the loader sorts them
 * (`GET /api/plugins`, authenticated; see `backend/CONTRACTS.md` area server-static).
 */
export const installedPlugins = (token?: string): Promise<{ plugins: readonly InstalledPlugin[] }> =>
  call<{ plugins: readonly InstalledPlugin[] }>("/plugins", {}, token);

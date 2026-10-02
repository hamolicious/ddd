import type { InstalledPlugin, PluginLoad, SessionUser } from "@kernel";

import { apiBase } from "./shell.js";

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

export class OfflineError extends Error {
  constructor(cause: unknown) {
    super("the server could not be reached", { cause });
    this.name = "OfflineError";
  }
}

const BOOT_REQUEST_TIMEOUT_MS = 10_000;

const deadline = (): AbortSignal | undefined =>
  typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(BOOT_REQUEST_TIMEOUT_MS)
    : undefined;

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const signal = init.signal ?? deadline();
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, {
      credentials: "same-origin",
      ...init,
      ...(signal ? { signal } : {}),
      headers,
    });
  } catch (cause) {
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
  }
  return new ApiError(response.status, code, message);
}

const toUser = (view: UserView): SessionUser => ({
  id: view.id,
  email: view.email,
  name: view.name ?? null,
  isAdmin: view.is_admin ?? false,
});

export const authBootstrap = (): Promise<AuthBootstrap> => call<AuthBootstrap>("/auth/bootstrap");

export async function redeemReset(token: string, newPassword: string): Promise<void> {
  await call<void>("/auth/password/reset", {
    method: "POST",
    body: JSON.stringify({ token, new_password: newPassword }),
  });
}

export function resetTokenFromHash(hash: string = location.hash): string | undefined {
  return /^#\/reset\/([A-Za-z0-9_-]+)$/.exec(hash)?.[1];
}

export function inviteTokenFromHash(hash: string = location.hash): string | undefined {
  return /^#\/invite\/([A-Za-z0-9_-]+)$/.exec(hash)?.[1];
}

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

export interface PluginDirectoryProblem {
  readonly [key: string]: unknown;
}

export interface PluginList {
  readonly plugins: readonly InstalledPlugin[];
  readonly problems?: readonly PluginDirectoryProblem[];
  readonly disabled?: boolean;
  readonly load?: PluginLoad;
  readonly version?: number | string;
}

export const installedPlugins = (token?: string): Promise<PluginList> => call<PluginList>("/plugins", {}, token);

export const enablePlugin = (id: string, token?: string): Promise<void> =>
  call<void>(`/admin/plugins/${encodeURIComponent(id)}/enable`, { method: "POST" }, token);

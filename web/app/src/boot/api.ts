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
 *
 * **The base is resolved, not hard-coded** (M5, `app/BRIDGE.md` §6). `"/api"` is right in
 * a browser and wrong in the shell, where the page origin is the loopback server holding
 * the downloaded bundle and the API lives on `window.shell.serverBaseUrl`. Every call
 * here went to a 404 in the shell until this was a function.
 */

import type {
  InstalledPlugin,
  LiveWiring,
  ProtocolPackage,
  ResolvedPluginSet,
  SessionUser,
  WiringOverrides,
} from "@kernel";

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

/**
 * How long one pre-kernel call gets before it counts as "there is no server".
 *
 * **Shorter than the shell's 25 s boot watchdog on purpose** (`app/lib/config.dart`).
 * These two calls are the only network in the boot sequence, and without a deadline they
 * inherit the platform default — minutes, on a captive portal, a half-open TCP connection,
 * a VPN handshake, or a server that accepts and then stalls. The shell's watchdog would
 * fire first and declare a bundle broken that was merely waiting, which is the one
 * distinction the whole auto-revert guarantee rests on; two such launches revert and
 * quarantine a working bundle.
 *
 * A timeout is an [OfflineError] like any other transport failure, and that is the right
 * answer rather than a lenient one: it boots the local workspace from the cached session
 * and lets the socket re-auth when there is a network again (SPEC §4.1, §5.3).
 */
const BOOT_REQUEST_TIMEOUT_MS = 10_000;

/** `AbortSignal.timeout` where it exists; `undefined` in an older runtime (rule: degrade). */
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
    // `same-origin` is deliberate on both paths: a browser sends its cookie, and the
    // shell's cross-origin calls send none — the bearer header above is the whole
    // credential there, and asking for cookies would need the server to allow
    // credentialed CORS for nothing (SPEC §5.2).
    response = await fetch(`${apiBase()}${path}`, {
      credentials: "same-origin",
      ...init,
      ...(signal ? { signal } : {}),
      headers,
    });
  } catch (cause) {
    // `fetch` rejects only for transport failures; every HTTP status resolves. An abort
    // from the deadline above lands here too, which is what makes a stalled server an
    // offline boot instead of a failed one.
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

/** Spend a one-time reset token (from an admin's reset link) on a new password. */
export async function redeemReset(token: string, newPassword: string): Promise<void> {
  await call<void>("/auth/password/reset", {
    method: "POST",
    body: JSON.stringify({ token, new_password: newPassword }),
  });
}

/**
 * The token in a reset link, `#/reset/<token>`, when that is the address the app was
 * opened at. Read before any session exists: the link is for someone who cannot sign in.
 */
export function resetTokenFromHash(hash: string = location.hash): string | undefined {
  return /^#\/reset\/([A-Za-z0-9_-]+)$/.exec(hash)?.[1];
}

/**
 * The token in an invite link, `#/invite/<token>`: opens registration with it filled in.
 * Only read when nobody is signed in on this device.
 */
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

/** What `GET /api/plugins` answers. `wiring` is absent on servers from before wiring. */
export interface PluginList {
  readonly plugins: readonly InstalledPlugin[];
  readonly wiring?: LiveWiring;
  /** Every registered protocol, owners gone included (PLUGIN-PROTOCOLS §3). */
  readonly protocols?: readonly ProtocolPackage[];
  /** The live wiring resolved against this list by the server, per boot mode (§6). */
  readonly resolved?: ResolvedPluginSet;
}

/**
 * The installed frontend plugins, in no particular order — the loader sorts them — and
 * the live wiring (`GET /api/plugins`, authenticated; see `backend/CONTRACTS.md` area
 * server-static).
 */
export const installedPlugins = (token?: string): Promise<PluginList> => call<PluginList>("/plugins", {}, token);

// ---------------------------------------------------------------------------
// The bare manager's write path (PLUGIN-PROTOCOLS §7): admin-only, no kernel needed
// ---------------------------------------------------------------------------

/** One entry of the wiring history (`GET /api/wiring`). `at` is RFC 3339. */
export interface WiringVersionInfo {
  readonly version: number;
  readonly action: string;
  readonly actor?: string;
  readonly subject?: string;
  readonly at: string;
}

export interface WiringHistory {
  readonly live: LiveWiring;
  /** Newest first. */
  readonly history: readonly WiringVersionInfo[];
}

export interface WiringVersionRecord extends WiringVersionInfo {
  readonly wiring: WiringOverrides;
}

export interface WiringApplyBody {
  /** The live version the caller saw; the server answers 409 when it has moved on. */
  readonly base: number;
  readonly wiring: WiringOverrides;
  readonly action: "apply" | "rollback";
}

/** The live wiring and every kept version, admin only. */
export const wiringHistory = (token?: string): Promise<WiringHistory> => call<WiringHistory>("/wiring", {}, token);

/** One kept version with its overrides: what a rollback applies again. */
export const wiringVersion = (version: number, token?: string): Promise<WiringVersionRecord> =>
  call<WiringVersionRecord>(`/wiring/versions/${encodeURIComponent(String(version))}`, {}, token);

/** Commit overrides as the next version. Rejects with an `ApiError` of status 409 on a stale base. */
export const applyWiring = (body: WiringApplyBody, token?: string): Promise<{ readonly live: LiveWiring }> =>
  call<{ readonly live: LiveWiring }>("/wiring/apply", { method: "POST", body: JSON.stringify(body) }, token);

/** Plug a plugin back in: `POST /api/admin/plugins/{id}/enable`, which also updates the wiring. */
export const enablePlugin = (id: string, token?: string): Promise<void> =>
  call<void>(`/admin/plugins/${encodeURIComponent(id)}/enable`, { method: "POST" }, token);

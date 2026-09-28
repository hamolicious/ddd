/**
 * The two answers the boot sequence needs before it can open the workspace, kept
 * where a reload with no network can still find them: **who is signed in** and **which
 * plugins are installed**.
 *
 * ## Why this file exists
 *
 * SPEC §4.1 and §8 promise an app that boots offline: the projection is in IndexedDB,
 * the search index is persisted, recently-opened documents have local replicas. None of
 * that is reachable if `boot()` cannot get past its first two REST calls — `/auth/me`
 * and `/plugins` — and both are on the service worker's `NetworkOnly` route, because a
 * cached *API response* would be a second, silently-wrong copy of the workspace
 * (`sw.ts`). So the fix is not to cache the responses in HTTP terms; it is to remember
 * these two specific facts, which are not workspace data:
 *
 * - the **session user** — id, email, admin flag. Not a credential: the credential is
 *   the HTTP-only cookie (or the shell's bearer token), and this cache cannot
 *   authenticate anything. If the session has in fact expired, the first socket
 *   connection comes back `4401` and the app asks for re-authentication over the top of
 *   the workspace, which is the documented path (SPEC §5.3) and is exactly what happens
 *   to a long-lived tab anyway.
 * - the **installed plugin list**, so the loader has something to activate. Plugin
 *   *modules* are already cached by the service worker at their version-scoped URLs
 *   (SPEC §8), so a remembered list points at bytes that are genuinely there.
 *
 * ## Why `localStorage`
 *
 * It is synchronous, it survives a reload, and it is available before IndexedDB is
 * opened — the boot sequence needs an answer before the kernel exists. Neither value is
 * secret (the workspace is shared, SPEC §2) and both are re-fetched and rewritten on
 * every successful online boot. A browser that refuses storage simply boots online-only,
 * which is the behaviour this file replaced.
 *
 * Sign-out clears it along with the local replicas (SPEC §5.3), and so does a genuine
 * 401 — the one case where the server has actually said the session is gone.
 */

import type { InstalledPlugin, LiveWiring, ResolvedPluginSet, SessionUser } from "@kernel";

const SESSION_KEY = "life-manager.boot.session";
const PLUGINS_KEY = "life-manager.boot.plugins";

/** Bumped when either shape changes, so a stale entry is ignored rather than trusted. */
const CACHE_VERSION = 1;

interface SessionEntry {
  readonly v: number;
  readonly user: SessionUser;
}

interface PluginsEntry {
  readonly v: number;
  readonly plugins: readonly InstalledPlugin[];
  /** Optional in version 1: entries written before wiring existed have none. */
  readonly wiring?: LiveWiring;
  /** The server's resolution of that wiring, so an offline boot activates the same way. */
  readonly resolved?: ResolvedPluginSet;
}

function read<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    // Private mode, disabled storage, or a half-written entry: no cache is a valid
    // answer everywhere this is called.
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or private mode. The online path is unaffected; only the offline boot is.
  }
}

function drop(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to do and nothing to report */
  }
}

/** Remember the signed-in user after the server confirmed them. */
export function rememberSession(user: SessionUser): void {
  write(SESSION_KEY, { v: CACHE_VERSION, user } satisfies SessionEntry);
}

/** The last user the server confirmed on this device, if any. */
export function cachedSession(): SessionUser | undefined {
  const entry = read<SessionEntry>(SESSION_KEY);
  if (!entry || entry.v !== CACHE_VERSION) return undefined;
  const user = entry.user;
  return typeof user?.id === "string" && typeof user.email === "string" ? user : undefined;
}

/** Remember the installed set, and the wiring it runs under, after `GET /api/plugins`. */
export function rememberPlugins(
  plugins: readonly InstalledPlugin[],
  wiring?: LiveWiring,
  resolved?: ResolvedPluginSet,
): void {
  write(PLUGINS_KEY, {
    v: CACHE_VERSION,
    plugins,
    ...(wiring ? { wiring } : {}),
    ...(resolved ? { resolved } : {}),
  } satisfies PluginsEntry);
}

/**
 * The last installed set this device saw. The loader re-validates every manifest in it
 * (SPEC §6.4), so a stale entry degrades to "some plugins were skipped" rather than to
 * an unexplained failure.
 */
export function cachedPlugins(): readonly InstalledPlugin[] | undefined {
  const entry = read<PluginsEntry>(PLUGINS_KEY);
  if (!entry || entry.v !== CACHE_VERSION) return undefined;
  return Array.isArray(entry.plugins) ? entry.plugins : undefined;
}

/** The server's resolution the remembered plugin set was served with, when there is one. */
export function cachedResolution(): ResolvedPluginSet | undefined {
  const entry = read<PluginsEntry>(PLUGINS_KEY);
  if (!entry || entry.v !== CACHE_VERSION) return undefined;
  return Array.isArray(entry.resolved?.normal?.order) ? entry.resolved : undefined;
}

/** The wiring the remembered plugin set was served with, when there is one. */
export function cachedWiring(): LiveWiring | undefined {
  const entry = read<PluginsEntry>(PLUGINS_KEY);
  if (!entry || entry.v !== CACHE_VERSION) return undefined;
  return typeof entry.wiring?.version === "number" ? entry.wiring : undefined;
}

/** Sign-out, or a 401: the session is genuinely over. */
export function forgetSession(): void {
  drop(SESSION_KEY);
}

/** Sign-out: leave nothing about this workspace behind (SPEC §5.3). */
export function forgetBootCache(): void {
  drop(SESSION_KEY);
  drop(PLUGINS_KEY);
}

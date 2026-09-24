/**
 * `kernel.session` — who is signed in, and the authenticated `fetch` plugins use.
 *
 * The carrier is deliberately invisible: a browser session is a cookie, a Flutter
 * shell session is a bearer token in native secure storage (SPEC §5.2), and a
 * plugin that built its own `fetch` would work in one and silently fail in the
 * other. Use {@link SessionApi.fetch}.
 *
 * **FROZEN.**
 */

import type { Unsubscribe } from "./types.js";

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly isAdmin: boolean;
}

export type AuthVia = "cookie" | "bearer";

export interface LogoutOptions {
  /**
   * Logout clears local replicas (shared-device safety, SPEC §5.3) and therefore
   * **blocks while unsynced edits exist**. Pass `true` only after the user has
   * explicitly chosen to discard them.
   */
  readonly discardUnsynced?: boolean;
}

export interface SessionApi {
  readonly user: SessionUser;
  readonly via: AuthVia;
  isAdmin(): boolean;
  /**
   * `fetch` against the server API with this session's credentials. `path` is
   * relative to `/api` (`"/documents/01J…"`). Rejects with the unwrapped error
   * envelope (`{error:{code,message}}`) on a non-2xx response.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * `fetch` against this plugin's own server routes — `/api/plugins/<this
   * plugin>/…` (SPEC §5.1). The plugin id is supplied by the kernel, so a plugin
   * cannot call another plugin's routes by spelling a different path.
   */
  fetchPlugin(path: string, init?: RequestInit): Promise<Response>;
  /**
   * The session needs re-authentication (close code 4401). **Local data is never
   * cleared on this path** (SPEC §5.3) — the shell shows re-login and resyncs.
   */
  onAuthRequired(listener: () => void): Unsubscribe;
  /** Sign out. Warns and blocks on unsynced edits unless told to discard them. */
  logout(options?: LogoutOptions): Promise<void>;
}

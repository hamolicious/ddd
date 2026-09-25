/**
 * The Flutter shell, from the page's side (SPEC §7; `app/BRIDGE.md` is authoritative).
 *
 * Everything the boot sequence needs to know about running inside the shell is here, and
 * nothing else in `app/` reads `window.shell` directly. Before this file the knowledge was
 * three private helpers at the bottom of `main.tsx`, which is how the app came to resolve
 * `/api` against the page origin — correct in a browser, and in the shell the *bundle
 * server on loopback*, which has no `/api` at all.
 *
 * Four rules, each one a failure that had to be designed out rather than tested out:
 *
 * 1. **A browser must be unaffected by every line of this.** `inShell()` is `false`, the
 *    API base stays `/api`, no token is read or written, and the session remains the
 *    HTTP-only cookie the page cannot see (SPEC §5.2). That is the security property, not
 *    an implementation detail.
 * 2. **API and socket URLs resolve against `shell.serverBaseUrl`** (`app/BRIDGE.md` §6).
 *    The bundle's *own* assets — plugin modules, the import map, the kernel chunks — stay
 *    page-relative, because those come from the loopback bundle and must work offline.
 * 3. **`bootOk()` is sent once, after the kernel is interactive** (`app/BRIDGE.md` §7),
 *    never on `DOMContentLoaded`: the shell's failed-boot counter is already incremented
 *    on disk, and the only thing that clears it is this call. Sending it early would make
 *    the auto-revert guarantee vacuous — a bundle that paints a shell and then throws
 *    would look like a successful boot forever.
 * 4. **Nothing here throws.** The shell is an enhancement; a bridge that is missing,
 *    frozen, half-injected or a plugin's idea of a joke must degrade to the browser path.
 */

import {
  bridgeVersionOf,
  readShellBridge,
  shellServerBaseUrl,
  type ShellBridgeV1,
} from "@kernel/runtime/index.js";

/** Where a shell's bearer token lives when the bridge has no keystore yet (SPEC §5.2). */
const SHELL_TOKEN_KEY = "life-manager.bearer";

/**
 * The event the shell fires when it has **verified and staged** a new bundle
 * (`app/BRIDGE.md` §5, §7). Not a bridge method: the page does not ask, it is told, and
 * a `CustomEvent` needs no handler registration on the Dart side — just
 * `evaluateJavascript`.
 *
 * The shell does this after `UpdateOutcome.staged` — `shellUpdateReadyScript` in
 * `app/lib/shell/webview_host.dart` evaluates
 * `window.dispatchEvent(new CustomEvent("lm-shell-update-ready", { detail: { bundleVersion } }))`
 * in the webview. `window.lmShellUpdateReady({ bundleVersion })` is an accepted alternative
 * for a shell that would rather call a function; both land on the same notice.
 *
 * The event name, the function spelling and the `detail` key live in
 * `app/bridge_fixtures/window_shell.json`, and both halves are tested against it. That is
 * not ceremony: these listeners shipped in M5 and nothing in the Dart shell dispatched
 * anything, so the contract was dead on a device for a release while both sides' own unit
 * tests passed.
 *
 * Neither spelling is required for the update to install: promotion happens at the next
 * launch either way, and this only tells the user why relaunching is worth doing.
 */
export const SHELL_UPDATE_EVENT = "lm-shell-update-ready";

export interface ShellUpdateReady {
  /** The staged `bundle_version`, when the shell cares to say. */
  readonly bundleVersion?: string;
}

/** What the shell says about itself. Diagnostics only — never a gate (`BRIDGE.md` §3). */
export interface ShellInfo {
  readonly bridgeVersion: number | undefined;
  readonly platform: string | undefined;
  readonly serverBaseUrl: string | undefined;
  readonly capabilities: readonly string[];
  readonly methods: readonly string[];
  /**
   * The bundle this device is *running*, if the shell injected it.
   *
   * `ShellBridgeV1.bundleVersion` is a declared optional member now, so reading it is
   * no longer a cast past the bridge type — but the Dart `bootstrapScript` still does
   * not set it, so this is `undefined` in practice and the settings section says "not
   * reported by the shell". It is the only way the page can name the bundle it is
   * *actually* running: the server's manifest names the newest one, which is a
   * different question and the reason "up to date?" cannot be answered from the server
   * alone.
   *
   * INTEGRATION (shell-bridge): adding it to `bootstrapScript` is an optional member
   * and needs no bridge version bump (`app/BRIDGE.md` §8). Nothing here or in
   * `app/bridge_fixtures/` requires it first.
   */
  readonly bundleVersion: string | undefined;
}

/**
 * `window.shell`, or `undefined` in a browser.
 *
 * **Rule 2 of `app/BRIDGE.md` §3 applies here; rule 3 deliberately does not**, and the
 * split is the whole reason this is not just `readShellBridge()`:
 *
 * - *Rule 2 — it must claim an integer version.* Full-trust plugins can put anything on
 *   `window` (SPEC §6.1), and an object that does not say what it is must not switch the
 *   boot sequence from the cookie session to bearer auth against a foreign origin.
 * - *Rule 3 — a newer major is still a shell, for these four members.* `capabilities.ts`
 *   refuses to **call** an ABI it does not know, which is right: guessing at a handler's
 *   shape is worse than degrading. But `serverBaseUrl`, `bearerToken`, `bootOk` and
 *   `setBearerToken` are plain JSON values and one-argument calls that no major has
 *   changed, and "degrading" them means falling back to a cookie on a loopback origin —
 *   which cannot work at all (`BRIDGE.md` §6). §8 says an old bundle on a new shell
 *   "still works; it just does not get native behaviour", and this is what makes that
 *   sentence true rather than aspirational.
 */
export const shellBridge = (): ShellBridgeV1 | undefined => {
  const bridge = readShellBridge();
  return bridge !== undefined && bridgeVersionOf(bridge) !== undefined ? bridge : undefined;
};

/** `true` only inside the Flutter shell webview — never in a browser tab. */
export const inShell = (): boolean => shellBridge() !== undefined;

/**
 * The origin every `/api` call and the sync socket must be resolved against:
 * the shell's server, or the page itself in a browser.
 */
export const serverBaseUrl = (): string | undefined => {
  const bridge = shellBridge();
  // Not `shellServerBaseUrl(shellBridge())`: that helper defaults its parameter to
  // `readShellBridge()`, so handing it the `undefined` this module just decided on
  // would re-read `window.shell` and undo the version check above.
  return bridge === undefined ? undefined : shellServerBaseUrl(bridge);
};

/** What `boot/api.ts` and `SessionHost.apiBase` prefix their paths with. */
export const apiBase = (): string => `${serverBaseUrl() ?? ""}/api`;

/**
 * The bearer token for this session, **in a shell only**.
 *
 * A browser never takes this path: its session is an HTTP-only cookie, and reading a
 * long-lived token out of web storage on an origin that runs full-trust plugin code
 * (SPEC §6.1) is exactly what the cookie design makes impossible. Inside the shell there
 * is no cookie to fall back on (the page's origin is a local loopback server), so the
 * token is injected as a *value* before the bundle runs — boot reads it synchronously,
 * before any promise can be awaited (`app/BRIDGE.md` §4.1).
 *
 * `localStorage` is the fallback for a shell build whose keystore handlers are not wired
 * yet; in the webview that store is a native data directory rather than evictable web
 * storage (SPEC §7).
 */
export function shellToken(): string | undefined {
  const bridge = shellBridge();
  if (!bridge) return undefined;
  if (typeof bridge.bearerToken === "string" && bridge.bearerToken.length > 0) {
    return bridge.bearerToken;
  }
  try {
    return localStorage.getItem(SHELL_TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Hand a newly issued token to the keystore, or `undefined` to forget one. */
export function rememberShellToken(token: string | undefined): void {
  const store = shellBridge()?.setBearerToken;
  if (store) {
    try {
      store(token ?? null);
    } catch {
      // The keystore is the only store worth trying in a shell that has one.
    }
    return;
  }
  try {
    // Removed unconditionally: a browser carrying this key from an older build should
    // lose it at the first sign-out rather than keep a credential indefinitely.
    if (token !== undefined && inShell()) localStorage.setItem(SHELL_TOKEN_KEY, token);
    else localStorage.removeItem(SHELL_TOKEN_KEY);
  } catch {
    // Private mode: the session lasts as long as the page does.
  }
}

let bootReported = false;

/**
 * "This bundle booted" — the call that clears the shell's failed-boot counter and stops
 * the next launch from reverting a working bundle (`app/BRIDGE.md` §7).
 *
 * Sent **once**, after the kernel is up and the plugin set has activated. Idempotent
 * because the interactive milestone is reachable by two paths (`?safe=bare` mounts the
 * built-in manager instead of activating plugins) and a second `boot.ok` would be a
 * confusing log line on the Dart side, not an error.
 */
export function reportBootOk(): void {
  if (bootReported) return;
  const bridge = shellBridge();
  if (!bridge?.bootOk) return;
  bootReported = true;
  try {
    void Promise.resolve(bridge.bootOk()).catch(() => undefined);
  } catch {
    // A shell that cannot hear "I booted" falls back to its watchdog; the page's job
    // is done either way and must not fail because of it.
  }
}

/**
 * "This bundle did not boot." Politeness, not a mechanism — the shell's 25 s watchdog
 * covers silence — but it turns a blank-screen investigation into a log line with a
 * reason, and lets the second attempt happen now rather than after the timeout.
 */
export function reportBootFailed(reason: string): void {
  if (bootReported) return;
  const bridge = shellBridge();
  if (!bridge?.bootFailed) return;
  bootReported = true;
  try {
    void Promise.resolve(bridge.bootFailed(reason)).catch(() => undefined);
  } catch {
    // Same reasoning as `reportBootOk`.
  }
}

/** Test seam: the "already reported" latch is module state by design. */
export function resetBootReportForTests(): void {
  bootReported = false;
}

/**
 * Listen for the shell's "a new bundle is staged" signal, in both spellings.
 *
 * The listener may fire before the kernel exists (the shell polls the manifest on every
 * foreground), so callers buffer rather than assume a notice centre.
 */
export function onShellUpdateReady(listener: (info: ShellUpdateReady) => void): () => void {
  if (!inShell()) return () => undefined;

  // The event spelling needs a global `addEventListener`, which a DOM has and a bare
  // JavaScript runtime does not. Rule 4: the function spelling still works there, and
  // nothing throws — this is the path the unit tests and any future SSR-ish context take.
  const events = typeof globalThis.addEventListener === "function" ? globalThis : undefined;
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    listener(updateInfo(detail));
  };
  events?.addEventListener(SHELL_UPDATE_EVENT, handler);

  const target = globalThis as { lmShellUpdateReady?: (info?: unknown) => void };
  const previous = target.lmShellUpdateReady;
  target.lmShellUpdateReady = (info?: unknown): void => {
    previous?.(info);
    listener(updateInfo(info));
  };
  return () => {
    events?.removeEventListener(SHELL_UPDATE_EVENT, handler);
    delete target.lmShellUpdateReady;
    if (previous) target.lmShellUpdateReady = previous;
  };
}

function updateInfo(detail: unknown): ShellUpdateReady {
  const version = (detail as { bundleVersion?: unknown } | null | undefined)?.bundleVersion;
  return typeof version === "string" && version.length > 0 ? { bundleVersion: version } : {};
}

/** Everything the shell reports about itself, read defensively. */
export function shellInfo(): ShellInfo | undefined {
  const bridge = shellBridge();
  if (!bridge) return undefined;
  return {
    // Not `detectBridge()`: this panel must be able to say "this shell speaks bridge 2
    // and this bundle speaks 1", which is exactly the case detection refuses.
    bridgeVersion: bridgeVersionOf(bridge),
    platform: typeof bridge.platform === "string" ? bridge.platform : undefined,
    serverBaseUrl: serverBaseUrl(),
    capabilities: strings(bridge.capabilities),
    methods: strings(bridge.methods),
    // Declared but optional, and `window.shell` is reachable by full-trust plugin code
    // (SPEC §6.1) — so it is narrowed like every other member rather than trusted.
    bundleVersion:
      typeof bridge.bundleVersion === "string" && bridge.bundleVersion.length > 0
        ? bridge.bundleVersion
        : undefined,
  };
}

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/**
 * What the page reads out of `GET /api/shell/manifest` (`app/BRIDGE.md` §5).
 *
 * The web side reads **two** of the manifest's four fields and must never depend on more
 * than that. Verifying the file list, the hashes and `index_csp` is the Dart updater's
 * job — it is the only party that downloads bytes — and duplicating that here would put
 * a second, weaker validator in front of the same JSON. So this narrows rather than
 * validates: anything missing or of the wrong type reads as "unknown", which is a
 * sentence the settings panel can print.
 */
export interface ShellManifestInfo {
  readonly bundleVersion: string | undefined;
  readonly minBridgeVersion: number | undefined;
}

export function readShellManifest(value: unknown): ShellManifestInfo {
  const manifest = (typeof value === "object" && value !== null ? value : {}) as {
    bundle_version?: unknown;
    min_bridge_version?: unknown;
  };
  const version = manifest.bundle_version;
  const min = manifest.min_bridge_version;
  return {
    bundleVersion: typeof version === "string" && version.length > 0 ? version : undefined,
    minBridgeVersion: typeof min === "number" && Number.isInteger(min) ? min : undefined,
  };
}

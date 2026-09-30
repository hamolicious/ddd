/**
 * `window.shell`, v1 — the **whole** typed surface the Flutter shell injects (SPEC §7).
 *
 * `app/BRIDGE.md` is authoritative; this file is its TypeScript mirror, and the only place
 * in the web tree that describes the bridge as one object. Before it existed the shape was
 * spread across three partial declarations — the capability wrappers in `capabilities.ts`
 * and the token pair in `app/src/main.tsx` — and nothing said they were the same object.
 *
 * Three rules govern everything here, and they are the reason the signatures look the way
 * they do:
 *
 * 1. **Only JSON crosses the boundary.** Bytes are base64 strings, instants are numbers or
 *    ISO-8601 strings; `Uint8Array`, `Date`, `Map` and functions-as-arguments cannot appear.
 * 2. **Everything may be a promise**, because every handler is asynchronous on the Dart
 *    side. The two exceptions are *values*, not calls: `bridgeVersion` and `bearerToken` are
 *    baked into the page before the bundle runs, because boot reads them synchronously.
 * 3. **A method the shell cannot perform is absent, not failing.** The kernel degrades to
 *    its browser implementation on *absence* only (`capabilities.ts`) — never on a thrown
 *    error, because retrying in the browser after a native attempt risks doing the thing
 *    twice. That is why every member below is optional and why `capabilities` exists.
 *
 * **Nothing here is a security boundary.** Frontend plugins run in full trust (SPEC §6.1)
 * and can reach `window.shell` — and the `flutter_inappwebview` handler underneath it —
 * directly. The kernel wraps it for *ergonomics and degradation*, not containment.
 */

/** The bridge major this bundle is written against. Mirrors `kBridgeVersion` in Dart. */
export const BRIDGE_VERSION = 1;

/** `{ name, mime }` plus exactly one of `text` / `data` (base64). */
export interface ShellExportFile {
  readonly name: string;
  readonly mime: string;
  readonly text?: string;
  readonly data?: string;
}

export interface ShellPickOptions {
  readonly accept?: readonly string[];
  readonly multiple?: boolean;
}

/** A picked file arrives whole: a native picker has no `File` in this realm to re-read. */
export interface ShellPickedFile {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  /** Base64. Absent when the shell sent `text` instead. */
  readonly data?: string;
  readonly text?: string;
}

export interface ShellNotification {
  readonly title: string;
  readonly body?: string;
  /** Stable id, so a re-issued reminder replaces rather than stacks. */
  readonly tag?: string;
  /** An in-app route, never a URL. */
  readonly route?: string;
}

export type ShellPermission = "granted" | "denied" | "default";

/**
 * The bearer token, namespaced. The flat `bearerToken` / `setBearerToken` pair on
 * {@link ShellBridgeV1} is the same storage under the spelling the boot sequence already
 * uses; both exist, and a shell implements one set of Dart handlers behind them.
 */
export interface ShellAuth {
  getToken?: () => Promise<string | null>;
  setToken?: (token: string) => Promise<void>;
  clearToken?: () => Promise<void>;
}

export interface ShellFilesystem {
  export?: (file: ShellExportFile) => Promise<void>;
  pick?: (options: ShellPickOptions) => Promise<readonly ShellPickedFile[]>;
  /** The admin export zip (SPEC §5.1), streamed and shared natively — admin-only server-side. */
  exportWorkspace?: () => Promise<void>;
  /** `pick`, single file. */
  importFile?: (options?: ShellPickOptions) => Promise<ShellPickedFile | null>;
}

export interface ShellNotifications {
  /** **Synchronous**: the shell bakes the current state in and refreshes it after `request`. */
  permission?: () => ShellPermission;
  request?: () => Promise<ShellPermission>;
  notify?: (notification: ShellNotification) => Promise<void>;
  /** `at` is epoch ms; the shell converts it to the bridge's `atIso`. Resolves to the id. */
  schedule?: (notification: ShellNotification, at: number) => Promise<string>;
  cancel?: (id: string) => Promise<void>;
  scheduled?: () => Promise<readonly { readonly id: string; readonly at: number }[]>;
  /** Alias of `scheduled`, the name `BRIDGE.md` gives the handler. */
  list?: () => Promise<readonly { readonly id: string; readonly at: number }[]>;
}

/** One entry of `folder.list()`. */
export interface ShellFolderEntry {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * A directory the user chose on this device (`app/BRIDGE.md` §4.5). Paths are relative to
 * it and `/`-separated; the shell refuses anything absolute or climbing out with `..`.
 * Changes made outside the page arrive as the `lm-folder-changed` window event.
 */
export interface ShellFolder {
  current?: () => Promise<{ readonly label: string } | null>;
  choose?: () => Promise<{ readonly label: string }>;
  forget?: () => Promise<void>;
  list?: () => Promise<readonly ShellFolderEntry[]>;
  /** `data` is base64. */
  read?: (params: { path: string }) => Promise<{ readonly data: string; readonly mtimeMs: number }>;
  write?: (params: { path: string; data: string }) => Promise<{ readonly mtimeMs: number }>;
  move?: (params: { from: string; to: string }) => Promise<void>;
  remove?: (params: { path: string }) => Promise<void>;
}

/** The window event a shell dispatches when files in the chosen folder change. */
export const FOLDER_CHANGED_EVENT = "lm-folder-changed";

/** Everything the shell may put on `window.shell`. Every member is optional by rule 3. */
export interface ShellBridgeV1 {
  /** The canonical version field, and the one {@link detectBridge} requires. */
  readonly version?: number;
  /** The same number under the name `BRIDGE.md` uses. Either is accepted. */
  readonly bridgeVersion?: number;
  /** Capability names with at least one method — informational; detection is per method. */
  readonly capabilities?: readonly string[];
  /** `capability.method` keys, for diagnostics. */
  readonly methods?: readonly string[];
  readonly platform?: string;
  /**
   * Who holds the session. Absent means the shell does (a bearer token in its keystore,
   * the Flutter shell); `"cookie"` means the page was loaded **from the server's own
   * origin** and authenticates like a browser tab (the Linux desktop shell). A cookie
   * shell keeps the service worker, the cookie login and the workspace-export link, and
   * only adds native capabilities on top (`app/BRIDGE.md` §3).
   */
  readonly session?: "cookie";
  /**
   * The `bundle_version` the shell is **currently serving** to this webview — the
   * 64-character digest from the bundle manifest (`app/BRIDGE.md` §5).
   *
   * Optional, and absent today: `bootstrapScript` on the Dart side does not inject it
   * yet, so `shellInfo()` reports `undefined` and the settings panel says "not reported
   * by the shell". It is declared here rather than read through a cast because the
   * *page* cannot answer "am I up to date?" without it: `GET /api/shell/manifest` names
   * the newest bundle the server has, which is a different question from which one this
   * device booted. Adding it on the Dart side is an optional member and needs no bridge
   * version bump (`app/BRIDGE.md` §8) — and `app/bridge_fixtures/window_shell.json`
   * deliberately does not list it, so neither half's tests assume it is there.
   */
  readonly bundleVersion?: string;
  /**
   * Where the server is. **The page's own origin is the shell's loopback bundle server**, so
   * API and socket URLs must be resolved against this and not against `location.origin`
   * (`app/BRIDGE.md` §6).
   */
  readonly serverBaseUrl?: string;
  /** Injected from the native keystore before the page loads (SPEC §5.2). */
  readonly bearerToken?: string | null;
  /** Hand back a token the server just issued, or `null` to forget it. */
  readonly setBearerToken?: (token: string | null) => unknown;
  /** The bundle booted. Clears the shell's failed-boot counter (`app/BRIDGE.md` §7). */
  readonly bootOk?: () => unknown;
  /** The bundle knows it failed. Optional — the shell's watchdog covers silence. */
  readonly bootFailed?: (reason: string) => unknown;
  readonly auth?: ShellAuth;
  readonly filesystem?: ShellFilesystem;
  readonly notifications?: ShellNotifications;
  readonly folder?: ShellFolder;
}

/**
 * `window.shell`, read defensively and **not validated further**.
 *
 * Anything on `window` in a full-trust plugin environment may be a plugin's idea of a joke,
 * so this only answers "is there an object claiming a bridge version" — every *method* is
 * checked at the call site, which is what makes per-method degradation possible.
 *
 * Returns `undefined` outside a shell, which is the browser's answer and not an error.
 */
export function readShellBridge(): ShellBridgeV1 | undefined {
  const candidate = (globalThis as { shell?: unknown }).shell;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  return candidate as ShellBridgeV1;
}

/**
 * The version a bridge claims, from either spelling. `undefined` when it claims none.
 *
 * Typed on the two version fields alone rather than on {@link ShellBridgeV1}, so the
 * narrower local declaration in `capabilities.ts` can pass its own object through.
 */
export function bridgeVersionOf(
  bridge: { readonly version?: number; readonly bridgeVersion?: number } | undefined,
): number | undefined {
  const raw = typeof bridge?.version === "number" ? bridge.version : bridge?.bridgeVersion;
  return typeof raw === "number" ? Math.trunc(raw) : undefined;
}

/**
 * `true` when a bridge claims a version **and** holds the session itself — the Flutter
 * shell. `false` in a browser and in a cookie shell (`session: "cookie"`), whose page is
 * served by the server and authenticates with the ordinary cookie.
 */
export function bridgeOwnsSession(bridge = readShellBridge()): boolean {
  return bridgeVersionOf(bridge) !== undefined && bridge?.session !== "cookie";
}

/**
 * Where the server is, from the shell's point of view — `undefined` in a browser.
 *
 * **This is the one M5 change without which the shell signs in and then never syncs**
 * (`app/BRIDGE.md` §6). The page's own origin inside the shell is
 * `http://127.0.0.1:41847`, a loopback server that holds the *bundle* and nothing else:
 * every `/api` call and the sync socket have to be resolved against this value instead.
 *
 * Validated rather than trusted: `window.shell` is reachable by full-trust plugin code
 * (SPEC §6.1), so a value that is not an absolute `http(s)` URL is treated as no value at
 * all — the page origin is a working answer in a browser and a *safe* one everywhere.
 * The trailing slash is stripped so callers can concatenate a rooted path.
 */
export function shellServerBaseUrl(bridge = readShellBridge()): string | undefined {
  const raw = bridge?.serverBaseUrl;
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  return url.toString().replace(/\/+$/, "");
}

/**
 * Resolve a rooted server path (`/api/sync`, `/api/admin/export`) to something
 * `fetch` can be handed: absolute against the shell's server, unchanged in a browser.
 *
 * Deliberately *not* used for the bundle's own assets. Plugin modules, the import map
 * and the kernel's chunks are served **by the loopback origin** from the downloaded
 * bundle (`app/BRIDGE.md` §5: "plugin files are part of the bundle"), so those stay
 * page-relative and keep working with no network at all.
 */
export function shellUrl(path: string, bridge = readShellBridge()): string {
  const base = shellServerBaseUrl(bridge);
  return base === undefined ? path : `${base}${path}`;
}

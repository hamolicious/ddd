/**
 * `kernel.capabilities` — feature detection plus the native bridge (SPEC §6.4, §7).
 *
 * Every capability has a **browser fallback and is mandatory to degrade** (SPEC
 * §7): a plugin written against this surface works in a plain browser tab and
 * gains fidelity inside the Flutter shell, and never has to ask which one it is
 * in. `has()` is there for the one legitimate case — not offering a UI affordance
 * that cannot work at all (scheduled reminders in a browser tab).
 *
 * Scope, stated exactly as SPEC §7 does: v1 reminders are **foreground (browser)**
 * and **scheduled local (shell)**. Server push, device registration and Web Push
 * are v2 — a plugin author should not plan around them.
 *
 * On the web the bridge is absent and `bridgeVersion` is `undefined`. In the shell
 * it is `window.shell`'s version; a **major** mismatch against
 * {@link SUPPORTED_BRIDGE_VERSION} means the shell is too old — capabilities fall
 * back rather than calling an ABI they do not understand.
 *
 * **FROZEN.**
 */

/** The bridge major version this kernel speaks (SPEC §7: versioned `window.shell`). */
export const SUPPORTED_BRIDGE_VERSION = 1;

export type CapabilityName = "filesystem" | "notifications" | "folder";

/** How a capability is being served right now — the honest answer for a UI. */
export type CapabilitySupport = "native" | "fallback" | "unavailable";

export interface FileExport {
  readonly name: string;
  readonly mime: string;
  /** Exactly one of the two. */
  readonly text?: string;
  readonly bytes?: Uint8Array;
}

export interface PickedFile {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
}

export interface PickOptions {
  /** MIME types or extensions, e.g. `["text/markdown", ".md"]`. */
  readonly accept?: readonly string[];
  readonly multiple?: boolean;
}

export interface FilesystemCapability {
  readonly support: CapabilitySupport;
  /**
   * Hand a file to the user. Native: the platform save dialog. Fallback: a
   * `blob:` download. Rejects with `CapabilityUnavailableError` only when
   * both are impossible.
   */
  export(file: FileExport): Promise<void>;
  /** Ask the user for files. Fallback: a hidden `<input type="file">`. */
  pick(options?: PickOptions): Promise<readonly PickedFile[]>;
  /**
   * The whole workspace as a zip — `GET /api/admin/export`, the no-Mongo recovery
   * path of SPEC §5.1. **Admin-only server-side**, so gate the affordance on
   * `session.isAdmin()` however the UI is drawn: a non-admin gets a 403.
   *
   * **Optional on purpose, and the reason is the M5 rule "an absent capability is
   * reported absent"** (`app/BRIDGE.md` §3): it exists only where it can actually
   * work — the shell's native streamed download, or a cookie session that can
   * authenticate a plain download link. A bearer session with no native handler
   * leaves it `undefined` rather than offering a button that 401s, because the
   * token lives in the shell's keystore and no navigation can carry it.
   *
   * It is not `export(bytes)`: the archive is the whole workspace and must never
   * be held in the webview's heap (`app/BRIDGE.md` §4.2).
   *
   * Added in M5 as an **optional** member of this otherwise frozen interface
   * (`app/CONTRACTS.md`, area web-shim).
   */
  exportWorkspace?(): Promise<void>;
}

export type NotificationPermissionState = "granted" | "denied" | "default";

export interface NotificationRequest {
  readonly title: string;
  readonly body?: string;
  /** Stable id, so a re-issued reminder replaces rather than stacks. */
  readonly tag?: string;
  /** Opened when the notification is tapped — an in-app route, not a URL. */
  readonly route?: string;
}

export interface NotificationsCapability {
  readonly support: CapabilitySupport;
  permission(): NotificationPermissionState;
  request(): Promise<NotificationPermissionState>;
  /** Fire now. Browser: only while a tab is open (SPEC §7). */
  notify(notification: NotificationRequest): Promise<void>;
  /**
   * `true` only in a shell that can schedule local notifications — i.e. ones that
   * fire with the app closed. Check it before offering reminders.
   */
  readonly supportsScheduled: boolean;
  /** Schedule for `at` (epoch ms). Returns a cancellation id. Shell only. */
  schedule(notification: NotificationRequest, at: number): Promise<string>;
  cancel(id: string): Promise<void>;
  /** Everything this client has scheduled and not yet fired. */
  scheduled(): Promise<readonly { readonly id: string; readonly at: number }[]>;
}

/** One entry of {@link FolderCapability.list}. Paths are relative, `/`-separated. */
export interface FolderEntry {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly size: number;
  /** Last modification, epoch ms. Compared for equality only, never ordered. */
  readonly mtimeMs: number;
}

/**
 * Where the chosen folder stands on this device.
 *
 * - `none`: nothing chosen.
 * - `ready`: chosen and readable/writable.
 * - `needs-permission`: chosen, but the browser forgot the grant across a reload;
 *   {@link FolderCapability.reconnect} from a click brings it back.
 */
export type FolderState = "none" | "ready" | "needs-permission";

export interface FolderStatus {
  readonly state: FolderState;
  /** Something to show the user — a path in a shell, a directory name in a browser. */
  readonly label?: string;
}

/**
 * One directory on this device that the user chose, and nothing outside it (2.2.0).
 *
 * Every path is **relative to that directory**, `/`-separated, and refused when it is
 * absolute or climbs out with `..`. The choice is per device and lives in the shell (or
 * the browser's IndexedDB), never in a synced document: a folder on one machine means
 * nothing on another.
 *
 * Native in both shells (a real path, watched for changes); a fallback through the File
 * System Access API in Chromium browsers, where nothing tells the page about changes and
 * a caller has to rescan. `unavailable` everywhere else.
 */
export interface FolderCapability {
  readonly support: CapabilitySupport;
  /** `true` when {@link onChange} fires for edits made outside the page. */
  readonly watches: boolean;
  status(): Promise<FolderStatus>;
  /** Ask the user for a directory. Rejects with a `cancelled` error when they back out. */
  choose(): Promise<FolderStatus>;
  /** Browser only: re-grant a remembered directory. Must run inside a click. */
  reconnect(): Promise<FolderStatus>;
  /** Forget the directory. Its files are left alone. */
  forget(): Promise<void>;
  /** Every file and directory below the root, recursively. */
  list(): Promise<readonly FolderEntry[]>;
  read(path: string): Promise<{ readonly bytes: Uint8Array; readonly mtimeMs: number }>;
  /** Replace or create, atomically where the platform allows; parents are created. */
  write(path: string, bytes: Uint8Array): Promise<{ readonly mtimeMs: number }>;
  move(from: string, to: string): Promise<void>;
  /** A file, or an empty directory. A missing path is not an error. */
  remove(path: string): Promise<void>;
  /** Something changed on disk. `paths` is a hint and may be empty: rescan either way. */
  onChange(listener: (paths: readonly string[]) => void): () => void;
}

export interface CapabilitiesApi {
  /** `true` when the capability can do something real — native *or* fallback. */
  has(name: CapabilityName): boolean;
  support(name: CapabilityName): CapabilitySupport;
  /** The shell bridge version, or `undefined` in a browser. */
  readonly bridgeVersion: number | undefined;
  readonly filesystem: FilesystemCapability;
  readonly notifications: NotificationsCapability;
  /**
   * A user-chosen directory on this device (2.2.0). Always present; check `support`
   * before offering it — it is `unavailable` in most browsers.
   */
  readonly folder: FolderCapability;
  /**
   * Persistent storage (SPEC §6.4): the kernel requests it at first login and
   * warns when it is denied or quota nears. Exposed read-only so a plugin about to
   * write a lot can check first.
   */
  storage(): Promise<StorageReport>;
}

export interface StorageReport {
  readonly persisted: boolean;
  readonly usageBytes?: number;
  readonly quotaBytes?: number;
}

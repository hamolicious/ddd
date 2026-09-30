/**
 * `kernel.capabilities` — feature detection with **working browser fallbacks**
 * (SPEC §7: "Browser fallback/degradation mandatory for every capability").
 *
 * The fallbacks are implemented here rather than deferred, because they are what
 * makes the capability surface honest on day one: a plugin written against
 * `capabilities.filesystem.export()` works in a browser tab now and gains the
 * platform save dialog when the shell exists in M5.
 *
 * Both halves are here: the browser implementations, and the `window.shell` bridge
 * wrappers with the browser ones underneath them **per method**. The bridge ABI the
 * shell has to implement is spelled out below; nothing in M5 has to change here.
 *
 * `window.shell` is the versioned bridge of SPEC §7. It is read defensively —
 * anything on `window` in a full-trust plugin environment may be a plugin's idea of
 * a joke, and a shape mismatch must degrade rather than throw.
 */

import { bridgeOwnsSession, bridgeVersionOf, readShellBridge, shellUrl, type ShellFolder } from "./shell-bridge.js";
import { BrowserFolder, ShellFolderCapability, UnavailableFolder, fromBase64, toBase64 } from "./folder.js";
import {
  CapabilityUnavailableError,
  SUPPORTED_BRIDGE_VERSION,
  type CapabilitiesApi,
  type CapabilityName,
  type CapabilitySupport,
  type FileExport,
  type FilesystemCapability,
  type FolderCapability,
  type NotificationPermissionState,
  type NotificationRequest,
  type NotificationsCapability,
  type PickOptions,
  type PickedFile,
  type StorageReport,
} from "@kernel";

/**
 * The shape the kernel expects of `window.shell`. Everything is optional.
 *
 * The full v1 surface — `auth`, `serverBaseUrl`, `bootOk`, the method list — is declared in
 * `shell-bridge.ts`; this is the subset `CapabilitiesHost` itself touches.
 */
export interface ShellBridge {
  readonly version?: number;
  /** The spelling `app/BRIDGE.md` uses; [`detectBridge`] accepts either. */
  readonly bridgeVersion?: number;
  readonly filesystem?: unknown;
  readonly notifications?: unknown;
  readonly folder?: unknown;
  /**
   * The server origin (`app/BRIDGE.md` §6). Read here for one reason: the browser
   * fallback for {@link FilesystemCapability.exportWorkspace} is a link to
   * `/api/admin/export`, and inside the shell the page origin is the loopback bundle
   * server, where that path does not exist.
   */
  readonly serverBaseUrl?: string;
}

/** The admin export zip — SPEC §5.1's no-Mongo recovery path. */
const WORKSPACE_EXPORT_PATH = "/api/admin/export";

/**
 * ## The bridge ABI, v1 (SPEC §7)
 *
 * The shell injects `window.shell`; the kernel is the only thing that touches it.
 * Two constraints come from the boundary itself and shape every signature:
 *
 * 1. **Only JSON crosses it.** A `flutter_inappwebview` handler serializes its
 *    arguments and its result, so binary is **base64** (`data`) and never a
 *    `Uint8Array`, and `Date`/`Map`/functions cannot appear at all.
 * 2. **Everything may be a promise.** Handlers are asynchronous on the Dart side, so
 *    the kernel awaits every return value — a synchronous one is fine too.
 *
 * ```ts
 * window.shell = {
 *   version: 1,
 *   filesystem?: {
 *     export(file: { name, mime, text?, data? /* base64 *\/ }): Promise<void>;
 *     pick(options: { accept?: string[]; multiple?: boolean }):
 *       Promise<{ name, mime, size, text?, data? /* base64 *\/ }[]>;
 *   },
 *   notifications?: {
 *     permission(): "granted" | "denied" | "default";
 *     request(): Promise<"granted" | "denied" | "default">;
 *     notify(n: { title, body?, tag?, route? }): Promise<void>;
 *     schedule(n: { title, body?, tag?, route? }, at: number): Promise<string>;
 *     cancel(id: string): Promise<void>;
 *     scheduled(): Promise<{ id: string; at: number }[]>;
 *   },
 * };
 * ```
 *
 * **Degradation is per method, and only on absence.** A method the bridge does not
 * define falls back to the browser implementation; a method that is defined and
 * *throws* is a real failure and is reported as one. Falling back after a throw
 * would risk doing the thing twice — two save dialogs, two notifications.
 *
 * INTEGRATION (M5 shell): implement the handlers above in Dart and set
 * `window.shell.version = 1`. `detectBridge` already refuses a bridge whose major
 * exceeds {@link SUPPORTED_BRIDGE_VERSION}, so shipping v2 with a v1 bundle
 * degrades instead of calling an ABI neither side agrees on.
 */
interface ShellFilesystemBridge {
  export?: (file: { name: string; mime: string; text?: string; data?: string }) => unknown;
  pick?: (options: { accept?: readonly string[]; multiple: boolean }) => unknown;
  /** M5 (`app/BRIDGE.md` §4.2): fetched with the bearer token and shared natively. */
  exportWorkspace?: () => unknown;
}

interface ShellNotificationsBridge {
  permission?: () => unknown;
  request?: () => unknown;
  notify?: (notification: NotificationRequest) => unknown;
  schedule?: (notification: NotificationRequest, at: number) => unknown;
  cancel?: (id: string) => unknown;
  scheduled?: () => unknown;
  /**
   * The name `app/BRIDGE.md` §4.3 gives the same handler. The shell registers both
   * spellings; either alone is enough here, because detection is per method and the
   * two are documented as the same call.
   */
  list?: () => unknown;
}

export function detectBridge(): ShellBridge | undefined {
  const bridge = readShellBridge() as ShellBridge | undefined;
  if (bridge === undefined) return undefined;
  // Either spelling counts: `version` is this file's original field name, `bridgeVersion` is
  // what `app/BRIDGE.md` calls it, and the shell injects both (M5). A bridge claiming
  // neither is not a bridge.
  const version = bridgeVersionOf(bridge);
  if (version === undefined) return undefined;
  // A shell newer in major than this bundle speaks an ABI we do not know; fall
  // back rather than guess (SPEC §7: the bundle declares a minimum bridge version).
  if (version > SUPPORTED_BRIDGE_VERSION) return undefined;
  // Normalized so everything downstream can read `.version`, whichever spelling arrived.
  return typeof bridge.version === "number" ? bridge : { ...bridge, version };
}

class BrowserFilesystem implements FilesystemCapability {
  readonly support: CapabilitySupport = typeof document === "undefined" ? "unavailable" : "fallback";

  /**
   * A plain download link to `/api/admin/export` — **defined only when the link can
   * authenticate itself**, which means a cookie session in a real browser tab.
   *
   * Left `undefined` inside a shell (`window.shell` present at all, even a bridge this
   * bundle refuses to speak to): that session is a bearer token in the platform
   * keystore, a navigation cannot carry an `Authorization` header, and an affordance
   * that reliably 401s is worse than an absent one. The shell's own
   * `filesystem.exportWorkspace` handler is what serves it there.
   */
  readonly exportWorkspace?: () => Promise<void>;

  constructor() {
    // "Is there a shell" and not "is there an object on `window.shell`": rule 2 of
    // `app/BRIDGE.md` §3 — an object claiming no version is not a bridge, and a plugin
    // that parks one on `window` must not silently remove the export link from a browser
    // tab whose cookie can authenticate it perfectly well. A shell of *any* major does
    // suppress it, including one this bundle refuses to call: its session is a bearer
    // token in the keystore, and no navigation can carry an `Authorization` header.
    //
    // A cookie shell (`session: "cookie"`, the Linux desktop shell) is served by the
    // server itself and authenticates exactly like a tab, so it keeps the link.
    if (this.support !== "unavailable" && !bridgeOwnsSession(readShellBridge())) {
      this.exportWorkspace = (): Promise<void> => this.#downloadWorkspace();
    }
  }

  /**
   * Not `fetch` + `blob:`: the archive is every document in the workspace, and pulling
   * it through the page's heap to hand it straight back to the browser is exactly the
   * mistake `app/BRIDGE.md` §4.2 names. A link lets the browser stream it to disk, and
   * the server's `Content-Disposition: attachment` keeps the app on screen.
   */
  #downloadWorkspace(): Promise<void> {
    const anchor = document.createElement("a");
    anchor.href = shellUrl(WORKSPACE_EXPORT_PATH);
    // A 403 for a non-admin (SPEC §5.1) then lands in its own tab instead of
    // replacing a running workspace with an error envelope.
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.click();
    return Promise.resolve();
  }

  async export(file: FileExport): Promise<void> {
    if (this.support === "unavailable") {
      throw new CapabilityUnavailableError("filesystem", "no document to attach a download to");
    }
    const payload: BlobPart =
      file.bytes !== undefined ? (file.bytes.slice().buffer as ArrayBuffer) : (file.text ?? "");
    const url = URL.createObjectURL(new Blob([payload], { type: file.mime }));
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.rel = "noopener";
      anchor.click();
    } finally {
      // Revoked on the next tick: Safari needs the URL alive past `click()`.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }

  pick(options: PickOptions = {}): Promise<readonly PickedFile[]> {
    if (this.support === "unavailable") {
      return Promise.reject(new CapabilityUnavailableError("filesystem", "no document to host a file input"));
    }
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = options.multiple ?? false;
      if (options.accept && options.accept.length > 0) input.accept = options.accept.join(",");
      input.style.display = "none";
      // `cancel` is not universal; a picker the user dismisses resolves empty when
      // the page regains focus, so a caller is never left awaiting forever.
      const finish = (files: readonly PickedFile[]): void => {
        input.remove();
        resolve(files);
      };
      input.addEventListener("change", () => {
        finish([...(input.files ?? [])].map(wrapFile));
      });
      input.addEventListener("cancel", () => finish([]));
      document.body.append(input);
      input.click();
    });
  }
}

function wrapFile(file: File): PickedFile {
  return {
    name: file.name,
    mime: file.type,
    size: file.size,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
    text: () => file.text(),
  };
}

class BrowserNotifications implements NotificationsCapability {
  readonly support: CapabilitySupport =
    typeof Notification === "undefined" ? "unavailable" : "fallback";

  /** Browsers cannot fire a notification with the app closed (SPEC §7). */
  readonly supportsScheduled = false;

  permission(): NotificationPermissionState {
    if (this.support === "unavailable") return "denied";
    return Notification.permission as NotificationPermissionState;
  }

  async request(): Promise<NotificationPermissionState> {
    if (this.support === "unavailable") return "denied";
    return (await Notification.requestPermission()) as NotificationPermissionState;
  }

  async notify(notification: NotificationRequest): Promise<void> {
    if (this.support === "unavailable") {
      throw new CapabilityUnavailableError("notifications", "this browser has no Notification API");
    }
    if (this.permission() !== "granted") {
      throw new CapabilityUnavailableError("notifications", "permission has not been granted");
    }
    new Notification(notification.title, {
      ...(notification.body !== undefined ? { body: notification.body } : {}),
      ...(notification.tag !== undefined ? { tag: notification.tag } : {}),
    });
  }

  schedule(notification: NotificationRequest, at: number): Promise<string> {
    // Deliberately not a `setTimeout`: a timer dies with the tab, and a reminder
    // that silently does not fire is worse than one the UI never offered.
    return Promise.reject(
      new CapabilityUnavailableError(
        "notifications",
        "scheduled notifications need the shell (SPEC §7); check `supportsScheduled` first",
      ),
    );
  }

  cancel(id: string): Promise<void> {
    return Promise.reject(new CapabilityUnavailableError("notifications", "nothing is scheduled in a browser"));
  }

  scheduled(): Promise<readonly { readonly id: string; readonly at: number }[]> {
    return Promise.resolve([]);
  }
}

/**
 * The shell's filesystem, with the browser one underneath it per method.
 *
 * `bytes` are base64 on the wire (see the ABI note above) and a picked file's
 * contents come back with it, because a native picker's `File` object does not
 * exist in this realm — so `bytes()`/`text()` resolve from what the bridge already
 * handed over rather than re-reading anything.
 */
class ShellFilesystem implements FilesystemCapability {
  readonly support: CapabilitySupport;
  /**
   * Native when the shell registered the handler; otherwise whatever the browser
   * implementation could offer, which inside a shell is nothing (see
   * {@link BrowserFilesystem.exportWorkspace}). Absent means absent: a plugin that
   * feature-detects this member gets the truth for this device.
   */
  readonly exportWorkspace?: () => Promise<void>;

  constructor(
    private readonly bridge: ShellFilesystemBridge,
    private readonly fallback: FilesystemCapability,
  ) {
    this.support =
      typeof bridge.export === "function" || typeof bridge.pick === "function"
        ? "native"
        : fallback.support;
    const native = bridge.exportWorkspace;
    if (typeof native === "function") {
      this.exportWorkspace = async (): Promise<void> => {
        await native.call(bridge);
      };
    } else if (fallback.exportWorkspace) {
      this.exportWorkspace = () => fallback.exportWorkspace?.() ?? Promise.resolve();
    }
  }

  async export(file: FileExport): Promise<void> {
    const call = this.bridge.export;
    if (typeof call !== "function") return this.fallback.export(file);
    await call.call(this.bridge, {
      name: file.name,
      mime: file.mime,
      ...(file.text !== undefined ? { text: file.text } : {}),
      ...(file.bytes !== undefined ? { data: toBase64(file.bytes) } : {}),
    });
  }

  async pick(options: PickOptions = {}): Promise<readonly PickedFile[]> {
    const call = this.bridge.pick;
    if (typeof call !== "function") return this.fallback.pick(options);
    const picked = await call.call(this.bridge, {
      ...(options.accept !== undefined ? { accept: [...options.accept] } : {}),
      multiple: options.multiple ?? false,
    });
    if (!Array.isArray(picked)) return [];
    return picked.map((entry) => bridgeFile(entry as Record<string, unknown>));
  }
}

function bridgeFile(entry: Record<string, unknown>): PickedFile {
  const name = typeof entry["name"] === "string" ? entry["name"] : "file";
  const mime = typeof entry["mime"] === "string" ? entry["mime"] : "application/octet-stream";
  const data = typeof entry["data"] === "string" ? entry["data"] : undefined;
  const text = typeof entry["text"] === "string" ? entry["text"] : undefined;
  const bytes = (): Uint8Array =>
    data !== undefined ? fromBase64(data) : new TextEncoder().encode(text ?? "");
  return {
    name,
    mime,
    size: typeof entry["size"] === "number" ? entry["size"] : bytes().byteLength,
    bytes: () => Promise.resolve(bytes()),
    text: () => Promise.resolve(text ?? new TextDecoder().decode(bytes())),
  };
}

/**
 * The shell's notifications. The one capability with a genuine functional
 * difference: **scheduled** notifications fire with the app closed, which no
 * browser can do (SPEC §7), so `supportsScheduled` is `true` only when the bridge
 * actually provides `schedule` *and* `cancel` — a plugin that can schedule but not
 * cancel has no way to withdraw a reminder the user deleted.
 */
class ShellNotifications implements NotificationsCapability {
  readonly support: CapabilitySupport;
  readonly supportsScheduled: boolean;

  constructor(
    private readonly bridge: ShellNotificationsBridge,
    private readonly fallback: NotificationsCapability,
  ) {
    this.support = typeof bridge.notify === "function" ? "native" : fallback.support;
    this.supportsScheduled =
      typeof bridge.schedule === "function" && typeof bridge.cancel === "function";
  }

  permission(): NotificationPermissionState {
    const call = this.bridge.permission;
    if (typeof call !== "function") return this.fallback.permission();
    // Declared synchronous in the ABI; a bridge that answers with a promise cannot
    // be awaited here, so it counts as "ask and find out".
    const value = call.call(this.bridge);
    return isPermission(value) ? value : "default";
  }

  async request(): Promise<NotificationPermissionState> {
    const call = this.bridge.request;
    if (typeof call !== "function") return this.fallback.request();
    const value = await call.call(this.bridge);
    return isPermission(value) ? value : "denied";
  }

  async notify(notification: NotificationRequest): Promise<void> {
    const call = this.bridge.notify;
    if (typeof call !== "function") return this.fallback.notify(notification);
    await call.call(this.bridge, notification);
  }

  async schedule(notification: NotificationRequest, at: number): Promise<string> {
    const call = this.bridge.schedule;
    if (typeof call !== "function" || !this.supportsScheduled) {
      return this.fallback.schedule(notification, at);
    }
    const id = await call.call(this.bridge, notification, at);
    if (typeof id !== "string") {
      throw new CapabilityUnavailableError(
        "notifications",
        "the shell scheduled the notification but returned no cancellation id",
      );
    }
    return id;
  }

  async cancel(id: string): Promise<void> {
    const call = this.bridge.cancel;
    if (typeof call !== "function") return this.fallback.cancel(id);
    await call.call(this.bridge, id);
  }

  /**
   * What is pending, and when. Accepts either handler spelling (`scheduled`, `list`)
   * and either instant spelling: `app/BRIDGE.md` §4.3 has the shell send **both**
   * `atIso` (the canonical instant) and `at` (epoch ms, what this frozen API returns),
   * so a shell that sends only the ISO form is still understood rather than dropped as
   * malformed — which would read to a user as "my reminders vanished".
   */
  async scheduled(): Promise<readonly { readonly id: string; readonly at: number }[]> {
    const call = this.bridge.scheduled ?? this.bridge.list;
    if (typeof call !== "function") return this.fallback.scheduled();
    const list = await call.call(this.bridge);
    if (!Array.isArray(list)) return [];
    const entries: { readonly id: string; readonly at: number }[] = [];
    for (const raw of list as { id?: unknown; at?: unknown; atIso?: unknown }[]) {
      if (typeof raw?.id !== "string") continue;
      const at = instantOf(raw);
      if (at === undefined) continue;
      entries.push({ id: raw.id, at });
    }
    return entries;
  }
}

const isPermission = (value: unknown): value is NotificationPermissionState =>
  value === "granted" || value === "denied" || value === "default";

/** Epoch ms from `at`, or from `atIso` when that is all the shell sent. */
function instantOf(entry: { at?: unknown; atIso?: unknown }): number | undefined {
  if (typeof entry.at === "number" && Number.isFinite(entry.at)) return entry.at;
  if (typeof entry.atIso !== "string") return undefined;
  const parsed = Date.parse(entry.atIso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export class CapabilitiesHost implements CapabilitiesApi {
  readonly bridgeVersion: number | undefined;
  readonly filesystem: FilesystemCapability;
  readonly notifications: NotificationsCapability;
  readonly folder: FolderCapability;

  constructor(bridge: ShellBridge | undefined = detectBridge()) {
    this.bridgeVersion = bridge?.version;
    // The browser implementations are always constructed: they are the per-method
    // fallback for a bridge that does not implement everything (SPEC §7).
    const browserFiles = new BrowserFilesystem();
    const browserNotifications = new BrowserNotifications();
    this.filesystem = isObject(bridge?.filesystem)
      ? new ShellFilesystem(bridge.filesystem as ShellFilesystemBridge, browserFiles)
      : browserFiles;
    this.notifications = isObject(bridge?.notifications)
      ? new ShellNotifications(bridge.notifications as ShellNotificationsBridge, browserNotifications)
      : browserNotifications;
    // Not per method like the others: a folder that can list but not write is a trap for
    // a sync plugin, so the shell's folder is used whole or not at all.
    this.folder =
      ShellFolderCapability.from(isObject(bridge?.folder) ? (bridge.folder as ShellFolder) : undefined) ??
      BrowserFolder.create() ??
      new UnavailableFolder();
  }

  has(name: CapabilityName): boolean {
    return this.support(name) !== "unavailable";
  }

  support(name: CapabilityName): CapabilitySupport {
    switch (name) {
      case "filesystem":
        return this.filesystem.support;
      case "notifications":
        return this.notifications.support;
      case "folder":
        return this.folder.support;
    }
  }

  async storage(): Promise<StorageReport> {
    const storage = globalThis.navigator?.storage;
    if (!storage) return { persisted: false };
    const [persisted, estimate] = await Promise.all([
      storage.persisted?.() ?? Promise.resolve(false),
      storage.estimate?.() ?? Promise.resolve({}),
    ]);
    return {
      persisted,
      ...(estimate.usage !== undefined ? { usageBytes: estimate.usage } : {}),
      ...(estimate.quota !== undefined ? { quotaBytes: estimate.quota } : {}),
    };
  }

  /**
   * SPEC §6.4: the kernel asks for persistent storage at first login and warns
   * visibly if it is denied or quota nears. The app calls this once after boot.
   */
  async requestPersistence(): Promise<StorageReport> {
    const storage = globalThis.navigator?.storage;
    if (storage?.persist) {
      try {
        await storage.persist();
      } catch {
        // Denied or unsupported: the report below tells the truth either way.
      }
    }
    return this.storage();
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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

import {
  CapabilityUnavailableError,
  SUPPORTED_BRIDGE_VERSION,
  type CapabilitiesApi,
  type CapabilityName,
  type CapabilitySupport,
  type FileExport,
  type FilesystemCapability,
  type NotificationPermissionState,
  type NotificationRequest,
  type NotificationsCapability,
  type PickOptions,
  type PickedFile,
  type StorageReport,
} from "@kernel";

/** The shape the kernel expects of `window.shell`. Everything is optional. */
export interface ShellBridge {
  readonly version?: number;
  readonly filesystem?: unknown;
  readonly notifications?: unknown;
}

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
}

interface ShellNotificationsBridge {
  permission?: () => unknown;
  request?: () => unknown;
  notify?: (notification: NotificationRequest) => unknown;
  schedule?: (notification: NotificationRequest, at: number) => unknown;
  cancel?: (id: string) => unknown;
  scheduled?: () => unknown;
}

export function detectBridge(): ShellBridge | undefined {
  const candidate = (globalThis as { shell?: unknown }).shell;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const bridge = candidate as ShellBridge;
  if (typeof bridge.version !== "number") return undefined;
  // A shell newer in major than this bundle speaks an ABI we do not know; fall
  // back rather than guess (SPEC §7: the bundle declares a minimum bridge version).
  if (Math.trunc(bridge.version) > SUPPORTED_BRIDGE_VERSION) return undefined;
  return bridge;
}

class BrowserFilesystem implements FilesystemCapability {
  readonly support: CapabilitySupport = typeof document === "undefined" ? "unavailable" : "fallback";

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

  constructor(
    private readonly bridge: ShellFilesystemBridge,
    private readonly fallback: FilesystemCapability,
  ) {
    this.support =
      typeof bridge.export === "function" || typeof bridge.pick === "function"
        ? "native"
        : fallback.support;
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

  async scheduled(): Promise<readonly { readonly id: string; readonly at: number }[]> {
    const call = this.bridge.scheduled;
    if (typeof call !== "function") return this.fallback.scheduled();
    const list = await call.call(this.bridge);
    if (!Array.isArray(list)) return [];
    return list
      .map((entry) => entry as { id?: unknown; at?: unknown })
      .filter((entry) => typeof entry.id === "string" && typeof entry.at === "number")
      .map((entry) => ({ id: entry.id as string, at: entry.at as number }));
  }
}

const isPermission = (value: unknown): value is NotificationPermissionState =>
  value === "granted" || value === "denied" || value === "default";

/** Base64 without `Buffer`: the bridge is JSON-only, so bytes travel as text. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class CapabilitiesHost implements CapabilitiesApi {
  readonly bridgeVersion: number | undefined;
  readonly filesystem: FilesystemCapability;
  readonly notifications: NotificationsCapability;

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
  }

  has(name: CapabilityName): boolean {
    return this.support(name) !== "unavailable";
  }

  support(name: CapabilityName): CapabilitySupport {
    return name === "filesystem" ? this.filesystem.support : this.notifications.support;
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

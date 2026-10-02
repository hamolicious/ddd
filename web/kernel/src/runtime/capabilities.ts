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

export interface ShellBridge {
  readonly version?: number;
  readonly bridgeVersion?: number;
  readonly filesystem?: unknown;
  readonly notifications?: unknown;
  readonly folder?: unknown;
  readonly serverBaseUrl?: string;
}

const WORKSPACE_EXPORT_PATH = "/api/admin/export";

interface ShellFilesystemBridge {
  export?: (file: { name: string; mime: string; text?: string; data?: string }) => unknown;
  pick?: (options: { accept?: readonly string[]; multiple: boolean }) => unknown;
  exportWorkspace?: () => unknown;
}

interface ShellNotificationsBridge {
  permission?: () => unknown;
  request?: () => unknown;
  notify?: (notification: NotificationRequest) => unknown;
  schedule?: (notification: NotificationRequest, at: number) => unknown;
  cancel?: (id: string) => unknown;
  scheduled?: () => unknown;
  list?: () => unknown;
}

export function detectBridge(): ShellBridge | undefined {
  const bridge = readShellBridge() as ShellBridge | undefined;
  if (bridge === undefined) return undefined;
  const version = bridgeVersionOf(bridge);
  if (version === undefined) return undefined;
  if (version > SUPPORTED_BRIDGE_VERSION) return undefined;
  return typeof bridge.version === "number" ? bridge : { ...bridge, version };
}

class BrowserFilesystem implements FilesystemCapability {
  readonly support: CapabilitySupport = typeof document === "undefined" ? "unavailable" : "fallback";

  readonly exportWorkspace?: () => Promise<void>;

  constructor() {
    if (this.support !== "unavailable" && !bridgeOwnsSession(readShellBridge())) {
      this.exportWorkspace = (): Promise<void> => this.#downloadWorkspace();
    }
  }

  #downloadWorkspace(): Promise<void> {
    const anchor = document.createElement("a");
    anchor.href = shellUrl(WORKSPACE_EXPORT_PATH);
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

class ShellFilesystem implements FilesystemCapability {
  readonly support: CapabilitySupport;
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
    const browserFiles = new BrowserFilesystem();
    const browserNotifications = new BrowserNotifications();
    this.filesystem = isObject(bridge?.filesystem)
      ? new ShellFilesystem(bridge.filesystem as ShellFilesystemBridge, browserFiles)
      : browserFiles;
    this.notifications = isObject(bridge?.notifications)
      ? new ShellNotifications(bridge.notifications as ShellNotificationsBridge, browserNotifications)
      : browserNotifications;
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

  async requestPersistence(): Promise<StorageReport> {
    const storage = globalThis.navigator?.storage;
    if (storage?.persist) {
      try {
        await storage.persist();
      } catch {
      }
    }
    return this.storage();
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

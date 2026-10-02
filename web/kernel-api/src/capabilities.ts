export const SUPPORTED_BRIDGE_VERSION = 1;

export type CapabilityName = "filesystem" | "notifications" | "folder";

export type CapabilitySupport = "native" | "fallback" | "unavailable";

export interface FileExport {
  readonly name: string;
  readonly mime: string;
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
  readonly accept?: readonly string[];
  readonly multiple?: boolean;
}

export interface FilesystemCapability {
  readonly support: CapabilitySupport;
  export(file: FileExport): Promise<void>;
  pick(options?: PickOptions): Promise<readonly PickedFile[]>;
  exportWorkspace?(): Promise<void>;
}

export type NotificationPermissionState = "granted" | "denied" | "default";

export interface NotificationRequest {
  readonly title: string;
  readonly body?: string;
  readonly tag?: string;
  readonly route?: string;
}

export interface NotificationsCapability {
  readonly support: CapabilitySupport;
  permission(): NotificationPermissionState;
  request(): Promise<NotificationPermissionState>;
  notify(notification: NotificationRequest): Promise<void>;
  readonly supportsScheduled: boolean;
  schedule(notification: NotificationRequest, at: number): Promise<string>;
  cancel(id: string): Promise<void>;
  scheduled(): Promise<readonly { readonly id: string; readonly at: number }[]>;
}

export interface FolderEntry {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly size: number;
  readonly mtimeMs: number;
}

export type FolderState = "none" | "ready" | "needs-permission";

export interface FolderStatus {
  readonly state: FolderState;
  readonly label?: string;
}

export interface FolderCapability {
  readonly support: CapabilitySupport;
  readonly watches: boolean;
  status(): Promise<FolderStatus>;
  choose(): Promise<FolderStatus>;
  reconnect(): Promise<FolderStatus>;
  forget(): Promise<void>;
  list(): Promise<readonly FolderEntry[]>;
  read(path: string): Promise<{ readonly bytes: Uint8Array; readonly mtimeMs: number }>;
  write(path: string, bytes: Uint8Array): Promise<{ readonly mtimeMs: number }>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  onChange(listener: (paths: readonly string[]) => void): () => void;
}

export interface CapabilitiesApi {
  has(name: CapabilityName): boolean;
  support(name: CapabilityName): CapabilitySupport;
  readonly bridgeVersion: number | undefined;
  readonly filesystem: FilesystemCapability;
  readonly notifications: NotificationsCapability;
  readonly folder: FolderCapability;
  storage(): Promise<StorageReport>;
}

export interface StorageReport {
  readonly persisted: boolean;
  readonly usageBytes?: number;
  readonly quotaBytes?: number;
}

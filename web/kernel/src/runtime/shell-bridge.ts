export const BRIDGE_VERSION = 1;

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

export interface ShellPickedFile {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly data?: string;
  readonly text?: string;
}

export interface ShellNotification {
  readonly title: string;
  readonly body?: string;
  readonly tag?: string;
  readonly route?: string;
}

export type ShellPermission = "granted" | "denied" | "default";

export interface ShellAuth {
  getToken?: () => Promise<string | null>;
  setToken?: (token: string) => Promise<void>;
  clearToken?: () => Promise<void>;
}

export interface ShellFilesystem {
  export?: (file: ShellExportFile) => Promise<void>;
  pick?: (options: ShellPickOptions) => Promise<readonly ShellPickedFile[]>;
  exportWorkspace?: () => Promise<void>;
  importFile?: (options?: ShellPickOptions) => Promise<ShellPickedFile | null>;
}

export interface ShellNotifications {
  permission?: () => ShellPermission;
  request?: () => Promise<ShellPermission>;
  notify?: (notification: ShellNotification) => Promise<void>;
  schedule?: (notification: ShellNotification, at: number) => Promise<string>;
  cancel?: (id: string) => Promise<void>;
  scheduled?: () => Promise<readonly { readonly id: string; readonly at: number }[]>;
  list?: () => Promise<readonly { readonly id: string; readonly at: number }[]>;
}

export interface ShellFolderEntry {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ShellFolder {
  current?: () => Promise<{ readonly label: string } | null>;
  choose?: () => Promise<{ readonly label: string }>;
  forget?: () => Promise<void>;
  list?: () => Promise<readonly ShellFolderEntry[]>;
  read?: (params: { path: string }) => Promise<{ readonly data: string; readonly mtimeMs: number }>;
  write?: (params: { path: string; data: string }) => Promise<{ readonly mtimeMs: number }>;
  move?: (params: { from: string; to: string }) => Promise<void>;
  remove?: (params: { path: string }) => Promise<void>;
}

export const FOLDER_CHANGED_EVENT = "ddd-folder-changed";

export interface ShellBridgeV1 {
  readonly version?: number;
  readonly bridgeVersion?: number;
  readonly capabilities?: readonly string[];
  readonly methods?: readonly string[];
  readonly platform?: string;
  readonly session?: "cookie";
  readonly bundleVersion?: string;
  readonly serverBaseUrl?: string;
  readonly bearerToken?: string | null;
  readonly setBearerToken?: (token: string | null) => unknown;
  readonly bootOk?: () => unknown;
  readonly bootFailed?: (reason: string) => unknown;
  readonly auth?: ShellAuth;
  readonly filesystem?: ShellFilesystem;
  readonly notifications?: ShellNotifications;
  readonly folder?: ShellFolder;
}

export function readShellBridge(): ShellBridgeV1 | undefined {
  const candidate = (globalThis as { shell?: unknown }).shell;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  return candidate as ShellBridgeV1;
}

export function bridgeVersionOf(
  bridge: { readonly version?: number; readonly bridgeVersion?: number } | undefined,
): number | undefined {
  const raw = typeof bridge?.version === "number" ? bridge.version : bridge?.bridgeVersion;
  return typeof raw === "number" ? Math.trunc(raw) : undefined;
}

export function bridgeOwnsSession(bridge = readShellBridge()): boolean {
  return bridgeVersionOf(bridge) !== undefined && bridge?.session !== "cookie";
}

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

export function shellUrl(path: string, bridge = readShellBridge()): string {
  const base = shellServerBaseUrl(bridge);
  return base === undefined ? path : `${base}${path}`;
}

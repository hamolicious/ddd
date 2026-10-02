import {
  bridgeVersionOf,
  readShellBridge,
  shellServerBaseUrl,
  type ShellBridgeV1,
} from "@kernel/runtime/index.js";

const SHELL_TOKEN_KEY = "ddd.bearer";

export const SHELL_UPDATE_EVENT = "ddd-shell-update-ready";

export interface ShellUpdateReady {
  readonly bundleVersion?: string;
}

export interface ShellInfo {
  readonly bridgeVersion: number | undefined;
  readonly platform: string | undefined;
  readonly serverBaseUrl: string | undefined;
  readonly capabilities: readonly string[];
  readonly methods: readonly string[];
  readonly bundleVersion: string | undefined;
}

export const shellBridge = (): ShellBridgeV1 | undefined => {
  const bridge = readShellBridge();
  return bridge !== undefined && bridgeVersionOf(bridge) !== undefined ? bridge : undefined;
};

export const inShell = (): boolean => shellBridge() !== undefined;

export const shellOwnsSession = (): boolean => {
  const bridge = shellBridge();
  return bridge !== undefined && bridge.session !== "cookie";
};

export const serverBaseUrl = (): string | undefined => {
  const bridge = shellBridge();
  return bridge === undefined ? undefined : shellServerBaseUrl(bridge);
};

export const apiBase = (): string => `${serverBaseUrl() ?? ""}/api`;

export function shellToken(): string | undefined {
  const bridge = shellBridge();
  if (!bridge || !shellOwnsSession()) return undefined;
  if (typeof bridge.bearerToken === "string" && bridge.bearerToken.length > 0) {
    return bridge.bearerToken;
  }
  try {
    return localStorage.getItem(SHELL_TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberShellToken(token: string | undefined): void {
  const store = shellOwnsSession() ? shellBridge()?.setBearerToken : undefined;
  if (store) {
    try {
      store(token ?? null);
    } catch {
    }
    return;
  }
  try {
    if (token !== undefined && shellOwnsSession()) localStorage.setItem(SHELL_TOKEN_KEY, token);
    else localStorage.removeItem(SHELL_TOKEN_KEY);
  } catch {
  }
}

let bootReported = false;

export function reportBootOk(): void {
  if (bootReported) return;
  const bridge = shellBridge();
  if (!bridge?.bootOk) return;
  bootReported = true;
  try {
    void Promise.resolve(bridge.bootOk()).catch(() => undefined);
  } catch {
  }
}

export function reportBootFailed(reason: string): void {
  if (bootReported) return;
  const bridge = shellBridge();
  if (!bridge?.bootFailed) return;
  bootReported = true;
  try {
    void Promise.resolve(bridge.bootFailed(reason)).catch(() => undefined);
  } catch {
  }
}

export function resetBootReportForTests(): void {
  bootReported = false;
}

export function onShellUpdateReady(listener: (info: ShellUpdateReady) => void): () => void {
  if (!inShell()) return () => undefined;

  const events = typeof globalThis.addEventListener === "function" ? globalThis : undefined;
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail;
    listener(updateInfo(detail));
  };
  events?.addEventListener(SHELL_UPDATE_EVENT, handler);

  const target = globalThis as { dddShellUpdateReady?: (info?: unknown) => void };
  const previous = target.dddShellUpdateReady;
  target.dddShellUpdateReady = (info?: unknown): void => {
    previous?.(info);
    listener(updateInfo(info));
  };
  return () => {
    events?.removeEventListener(SHELL_UPDATE_EVENT, handler);
    delete target.dddShellUpdateReady;
    if (previous) target.dddShellUpdateReady = previous;
  };
}

function updateInfo(detail: unknown): ShellUpdateReady {
  const version = (detail as { bundleVersion?: unknown } | null | undefined)?.bundleVersion;
  return typeof version === "string" && version.length > 0 ? { bundleVersion: version } : {};
}

export function shellInfo(): ShellInfo | undefined {
  const bridge = shellBridge();
  if (!bridge) return undefined;
  return {
    bridgeVersion: bridgeVersionOf(bridge),
    platform: typeof bridge.platform === "string" ? bridge.platform : undefined,
    serverBaseUrl: serverBaseUrl(),
    capabilities: strings(bridge.capabilities),
    methods: strings(bridge.methods),
    bundleVersion:
      typeof bridge.bundleVersion === "string" && bridge.bundleVersion.length > 0
        ? bridge.bundleVersion
        : undefined,
  };
}

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

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

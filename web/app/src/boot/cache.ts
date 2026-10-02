import type { InstalledPlugin, PluginLoad, SessionUser } from "@kernel";

const SESSION_KEY = "ddd.boot.session";
const PLUGINS_KEY = "ddd.boot.plugins";

const CACHE_VERSION = 2;

interface SessionEntry {
  readonly v: number;
  readonly user: SessionUser;
}

interface PluginsEntry {
  readonly v: number;
  readonly plugins: readonly InstalledPlugin[];
  readonly load?: PluginLoad;
}

function read<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
  }
}

function drop(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
  }
}

export function rememberSession(user: SessionUser): void {
  write(SESSION_KEY, { v: CACHE_VERSION, user } satisfies SessionEntry);
}

export function cachedSession(): SessionUser | undefined {
  const entry = read<SessionEntry>(SESSION_KEY);
  if (!entry || entry.v !== CACHE_VERSION) return undefined;
  const user = entry.user;
  return typeof user?.id === "string" && typeof user.email === "string" ? user : undefined;
}

export function rememberPlugins(plugins: readonly InstalledPlugin[], load?: PluginLoad): void {
  write(PLUGINS_KEY, { v: CACHE_VERSION, plugins, ...(load ? { load } : {}) } satisfies PluginsEntry);
}

export function cachedPlugins(): readonly InstalledPlugin[] | undefined {
  const entry = read<PluginsEntry>(PLUGINS_KEY);
  if (!entry || entry.v !== CACHE_VERSION) return undefined;
  return Array.isArray(entry.plugins) ? entry.plugins : undefined;
}

export function cachedLoad(): PluginLoad | undefined {
  const entry = read<PluginsEntry>(PLUGINS_KEY);
  if (!entry || entry.v !== CACHE_VERSION) return undefined;
  return Array.isArray(entry.load?.normal) && Array.isArray(entry.load?.safe) ? entry.load : undefined;
}

export function forgetSession(): void {
  drop(SESSION_KEY);
}

export function forgetBootCache(): void {
  drop(SESSION_KEY);
  drop(PLUGINS_KEY);
}

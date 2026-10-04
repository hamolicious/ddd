import type {
  AvailablePackage,
  InstalledPackage,
  LinkedSource,
  PluginUpdate,
  SavedSource,
  SourceSettings,
} from "plugin:admin";

import { compareVersions } from "../../_shared/versions.js";

export type TokenKind = "none" | "access" | "deploy" | "job";

export const TOKEN_HEADERS: Readonly<Record<Exclude<TokenKind, "none">, string>> = {
  access: "PRIVATE-TOKEN",
  deploy: "Deploy-Token",
  job: "JOB-TOKEN",
};

export const DEFAULT_INSTANCE = "https://gitlab.com";

export interface GitLabSettings {
  readonly instance: string;
  readonly project: string;
  readonly tokenKind: TokenKind;
  readonly token: string;
}

export function readSettings(settings: SourceSettings): GitLabSettings {
  const text = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);
  const kind = text(settings.config["tokenKind"], "access");
  return {
    instance: text(settings.config["instance"], DEFAULT_INSTANCE),
    project: text(settings.config["project"], ""),
    tokenKind: kind === "none" || kind === "deploy" || kind === "job" ? kind : "access",
    token: settings.secrets["token"] ?? "",
  };
}

export function writeSettings(settings: GitLabSettings): SourceSettings {
  return {
    config: { instance: settings.instance, project: settings.project, tokenKind: settings.tokenKind },
    secrets: settings.tokenKind === "none" || !settings.token ? {} : { token: settings.token },
  };
}

export function normalizeInstance(raw: string): string {
  const trimmed = raw.trim() || DEFAULT_INSTANCE;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${raw}" is not a GitLab address`);
  }
  if (url.protocol !== "https:") {
    throw new Error("the GitLab address must use https://");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function normalizeProject(raw: string, instance: string): string {
  let project = raw.trim();
  if (project.startsWith(instance)) project = project.slice(instance.length);
  project = project.replace(/^\/+|\/+$/g, "").replace(/\/-\/.*$/, "").replace(/\.git$/, "");
  if (!project) throw new Error("name the project by its ID or its path, like group/project");
  return project;
}

export function validate(settings: SourceSettings): string | undefined {
  const read = readSettings(settings);
  try {
    normalizeProject(read.project, normalizeInstance(read.instance));
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (read.tokenKind !== "none" && !read.token.trim()) {
    return "enter the token, or choose “No token” for a public project";
  }
  return undefined;
}

export interface Endpoint {
  readonly instance: string;
  readonly project: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function endpointOf(source: SourceSettings): Endpoint {
  const read = readSettings(source);
  const instance = normalizeInstance(read.instance);
  return {
    instance,
    project: normalizeProject(read.project, instance),
    headers: read.tokenKind === "none" || !read.token ? {} : { [TOKEN_HEADERS[read.tokenKind]]: read.token.trim() },
  };
}

function projectApi(endpoint: Endpoint): string {
  return `${endpoint.instance}/api/v4/projects/${encodeURIComponent(endpoint.project)}`;
}

export function packageListUrl(endpoint: Endpoint, name?: string): string {
  const filter = name ? `&package_name=${encodeURIComponent(name)}` : "";
  return `${projectApi(endpoint)}/packages?package_type=generic&per_page=100${filter}`;
}

export function packageFilesUrl(endpoint: Endpoint, packageId: number): string {
  return `${projectApi(endpoint)}/packages/${packageId}/package_files?per_page=100`;
}

export function packageUrl(endpoint: Endpoint, name: string, version: string, file: string): string {
  return `${projectApi(endpoint)}/packages/generic/${encodeURIComponent(name)}/${encodeURIComponent(version)}/${encodeURIComponent(file)}`;
}

export interface PackageLocation {
  readonly name: string;
  readonly version: string;
  readonly file: string;
}

const GENERIC_PATH = /\/packages\/generic\/([^/]+)\/([^/]+)\/([^/?#]+)$/;

export function parsePackageUrl(url: string): PackageLocation | undefined {
  const match = GENERIC_PATH.exec(url.replace(/[?#].*$/, ""));
  if (!match) return undefined;
  try {
    return {
      name: decodeURIComponent(match[1]!),
      version: decodeURIComponent(match[2]!),
      file: decodeURIComponent(match[3]!),
    };
  } catch {
    return undefined;
  }
}

export interface ListedPackage {
  readonly id: number;
  readonly name: string;
  readonly version: string;
  readonly status?: string;
}

export function newestPerName(listed: unknown, only?: string): readonly ListedPackage[] {
  if (!Array.isArray(listed)) return [];
  const newest = new Map<string, ListedPackage>();
  for (const entry of listed as readonly Partial<ListedPackage>[]) {
    if (typeof entry?.id !== "number" || typeof entry.name !== "string" || typeof entry.version !== "string") continue;
    if (only !== undefined && entry.name !== only) continue;
    if (entry.status !== undefined && entry.status !== "default") continue;
    const candidate = entry as ListedPackage;
    const known = newest.get(candidate.name);
    if (!known || compareVersions(candidate.version, known.version) > 0) newest.set(candidate.name, candidate);
  }
  return [...newest.values()];
}

export function chooseFile(files: unknown, name: string, version: string, previous?: PackageLocation): string | undefined {
  if (!Array.isArray(files)) return undefined;
  const names = (files as readonly { readonly file_name?: unknown }[])
    .map((file) => file?.file_name)
    .filter((candidate): candidate is string => typeof candidate === "string");
  const preferred = [
    previous ? previous.file.split(previous.version).join(version) : undefined,
    `${name}-${version}.zip`,
    previous?.file,
  ];
  return (
    preferred.find((candidate) => candidate !== undefined && names.includes(candidate)) ??
    names.find((candidate) => candidate.endsWith(".zip"))
  );
}

export type FetchJson = (url: string, headers: Readonly<Record<string, string>>) => Promise<unknown>;

export async function reach(url: string, init: RequestInit, fetcher: typeof fetch = fetch): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch {
    throw new Error(`could not reach ${new URL(url).origin}: offline, blocked, or it refuses cross-origin requests`);
  }
  if (!response.ok) throw new Error(refusal(response.status));
  return response;
}

export const fetchJson: FetchJson = async (url, headers) =>
  (await reach(url, { headers: { accept: "application/json", ...headers } })).json();

export function refusal(status: number): string {
  if (status === 401 || status === 403) return `GitLab answered ${status}: the token is missing, wrong, or cannot read packages`;
  if (status === 404) return "GitLab answered 404: check the project, and that the token can see it";
  return `GitLab answered ${status}`;
}

async function resolve(
  endpoint: Endpoint,
  release: ListedPackage,
  load: FetchJson,
  previous?: PackageLocation,
): Promise<AvailablePackage | undefined> {
  const files = await load(packageFilesUrl(endpoint, release.id), endpoint.headers);
  const file = chooseFile(files, release.name, release.version, previous);
  if (!file) return undefined;
  return {
    name: release.name,
    version: release.version,
    plugin: release.name,
    url: packageUrl(endpoint, release.name, release.version, file),
  };
}

export async function browse(source: SavedSource, load: FetchJson = fetchJson): Promise<readonly AvailablePackage[]> {
  const endpoint = endpointOf(source);
  const releases = newestPerName(await load(packageListUrl(endpoint), endpoint.headers));
  const resolved = await Promise.all(releases.map((release) => resolve(endpoint, release, load)));
  return resolved.filter((found): found is AvailablePackage => found !== undefined);
}

export async function download(source: SavedSource, url: string, fetcher: typeof fetch = fetch): Promise<Blob> {
  const endpoint = endpointOf(source);
  if (!url.startsWith(`${endpoint.instance}/`)) throw new Error(`${url} is not on ${endpoint.instance}`);
  return (await reach(url, { headers: endpoint.headers }, fetcher)).blob();
}

export async function checkUpdates(
  source: SavedSource,
  plugins: readonly InstalledPackage[],
  report: (update: PluginUpdate) => void,
  load: FetchJson = fetchJson,
): Promise<void> {
  const endpoint = endpointOf(source);
  const problems: string[] = [];
  await Promise.all(
    plugins.map(async (plugin) => {
      const location = parsePackageUrl(plugin.url);
      if (!location) return;
      try {
        const [newest] = newestPerName(await load(packageListUrl(endpoint, location.name), endpoint.headers), location.name);
        if (!newest || compareVersions(newest.version, location.version) <= 0) return;
        const found = await resolve(endpoint, newest, load, location);
        if (!found) {
          problems.push(`${plugin.id}: ${newest.version} has no .zip file`);
          return;
        }
        report({ plugin: plugin.id, source: source.id, current: plugin.version, latest: found.version, url: found.url });
      } catch (error) {
        problems.push(`${plugin.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );
  if (problems.length > 0) throw new Error(problems.join("; "));
}

function linkedFrom(instance: string, project: string): LinkedSource {
  const host = new URL(instance).host;
  const short = project.split("/").pop() ?? project;
  return {
    name: `${short} on ${host}`.slice(0, 80),
    settings: writeSettings({ instance, project, tokenKind: "none", token: "" }),
  };
}

export function fromLink(link: string): LinkedSource | undefined {
  const raw = link.trim();
  const ssh = /^(?:ssh:\/\/)?git@([^:/\s]+)[:/](.+?)(?:\.git)?\/?$/.exec(raw);
  if (ssh) return linkedFrom(`https://${ssh[1]}`, ssh[2]!);
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const instance = `https://${url.host}`;
  const api = /^(.*?)\/api\/v4\/projects\/([^/]+)/.exec(url.pathname);
  if (api) {
    try {
      return linkedFrom(`${instance}${api[1]}`, decodeURIComponent(api[2]!));
    } catch {
      return undefined;
    }
  }
  const project = url.pathname
    .split("/-/")[0]!
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  if (project.split("/").filter(Boolean).length < 2) return undefined;
  return linkedFrom(instance, decodeURIComponent(project));
}

export async function test(settings: SourceSettings, load: FetchJson = fetchJson): Promise<string> {
  const endpoint = endpointOf(settings);
  const project = (await load(projectApi(endpoint), endpoint.headers)) as { path_with_namespace?: unknown } | undefined;
  const label = typeof project?.path_with_namespace === "string" ? project.path_with_namespace : endpoint.project;
  const packages = newestPerName(await load(packageListUrl(endpoint), endpoint.headers));
  const listed = packages.map((found) => found.name).join(", ");
  return packages.length === 0
    ? `Reached ${label}, but it has no generic packages yet.`
    : `Reached ${label}: ${packages.length} package${packages.length === 1 ? "" : "s"} (${listed}).`;
}

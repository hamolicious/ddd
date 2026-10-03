import type {
  AvailablePackage,
  InstalledPackage,
  LinkedSource,
  PluginUpdate,
  SavedSource,
  SourceSettings,
} from "plugin:admin";

import { compareVersions } from "../../_shared/versions.js";

export interface Hosts {
  readonly site: string;
  readonly api: string;
}

export const GITHUB: Hosts = { site: "https://github.com", api: "https://api.github.com" };

export interface GitHubSettings {
  readonly repo: string;
  readonly token: string;
}

export function readSettings(settings: SourceSettings): GitHubSettings {
  const repo = settings.config["repo"];
  return { repo: typeof repo === "string" ? repo : "", token: settings.secrets["token"] ?? "" };
}

export function writeSettings(settings: GitHubSettings): SourceSettings {
  const token = settings.token.trim();
  return { config: { repo: settings.repo }, secrets: token ? { token } : {} };
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

function isName(part: string | undefined): part is string {
  return part !== undefined && NAME.test(part) && part !== "." && part !== "..";
}

export function repoPath(parts: readonly string[]): string {
  const [owner, name] = parts.filter(Boolean);
  const repo = name?.replace(/\.git$/, "");
  if (!isName(owner) || !isName(repo)) throw new Error("name the repository as owner/name, like octo-org/ddd-plugins");
  return `${owner}/${repo}`;
}

export interface ReleaseAsset {
  readonly id: number;
  readonly name: string;
  readonly tag: string;
  readonly version: string;
  readonly file: string;
}

export interface PackageLocation {
  readonly repo: string;
  readonly tag: string;
  readonly file: string;
  readonly name: string;
  readonly version: string;
}

const VERSIONED_ZIP = /^(.+?)-v?(\d+(?:\.\d+)+(?:-[0-9A-Za-z.-]+)?)\.zip$/i;

export function identify(file: string, tag: string): { readonly name: string; readonly version: string } | undefined {
  if (!/\.zip$/i.test(file)) return undefined;
  const versioned = VERSIONED_ZIP.exec(file);
  if (versioned) return { name: versioned[1]!, version: versioned[2]! };
  return { name: file.replace(/\.zip$/i, ""), version: tag.replace(/^v/i, "") };
}

interface ListedRelease {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly assets?: unknown;
}

interface ListedAsset {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly state?: unknown;
}

function assetsOf(release: ListedRelease | undefined): readonly ReleaseAsset[] {
  if (typeof release?.tag_name !== "string" || !Array.isArray(release.assets)) return [];
  const tag = release.tag_name;
  return (release.assets as readonly ListedAsset[]).flatMap((asset) => {
    if (typeof asset?.id !== "number" || typeof asset.name !== "string") return [];
    if (asset.state !== undefined && asset.state !== "uploaded") return [];
    const identity = identify(asset.name, tag);
    return identity ? [{ id: asset.id, tag, file: asset.name, ...identity }] : [];
  });
}

export function newestPerName(releases: unknown): readonly ReleaseAsset[] {
  if (!Array.isArray(releases)) return [];
  const newest = new Map<string, ReleaseAsset>();
  for (const release of releases as readonly ListedRelease[]) {
    if (release?.draft === true || release?.prerelease === true) continue;
    for (const asset of assetsOf(release)) {
      const known = newest.get(asset.name);
      if (!known || compareVersions(asset.version, known.version) > 0) newest.set(asset.name, asset);
    }
  }
  return [...newest.values()];
}

export type FetchJson = (url: string, headers: Readonly<Record<string, string>>) => Promise<unknown>;

export type FetchAsset = (request: { readonly repo: string; readonly asset: number; readonly token?: string }) => Promise<Blob>;

export function refusal(status: number): string {
  if (status === 401) return "GitHub answered 401: the token is wrong or has expired";
  if (status === 403 || status === 429) {
    return `GitHub answered ${status}: the token cannot read the repository, or the hourly limit for requests without a token is used up`;
  }
  if (status === 404) return "GitHub answered 404: check the repository, and that the token can see it";
  return `GitHub answered ${status}`;
}

export const fetchJson: FetchJson = async (url, headers) => {
  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch {
    throw new Error(`could not reach ${new URL(url).origin}: offline, or blocked`);
  }
  if (!response.ok) throw new Error(refusal(response.status));
  return response.json();
};

export interface GitHubSource {
  readonly normalizeRepo: (raw: string) => string;
  readonly validate: (settings: SourceSettings) => string | undefined;
  readonly downloadUrl: (repo: string, tag: string, file: string) => string;
  readonly parseDownloadUrl: (url: string) => PackageLocation | undefined;
  readonly fromLink: (link: string) => LinkedSource | undefined;
  readonly test: (settings: SourceSettings) => Promise<string>;
  readonly browse: (source: SavedSource) => Promise<readonly AvailablePackage[]>;
  readonly download: (source: SavedSource, url: string) => Promise<Blob>;
  readonly checkUpdates: (
    source: SavedSource,
    plugins: readonly InstalledPackage[],
    report: (update: PluginUpdate) => void,
  ) => Promise<void>;
}

export function gitHubSource(hosts: Hosts, load: FetchJson, fetchAsset: FetchAsset): GitHubSource {
  const site = new URL(hosts.site);
  const siteHosts = new Set([site.host, `www.${site.host}`]);
  const apiHost = new URL(hosts.api).host;

  const normalizeRepo = (raw: string): string => {
    let path = raw.trim().replace(/[?#].*$/, "");
    for (const prefix of [hosts.site, site.host, `www.${site.host}`]) {
      if (path.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) path = path.slice(prefix.length);
    }
    return repoPath(path.split("/"));
  };

  const endpointOf = (settings: SourceSettings) => {
    const read = readSettings(settings);
    const token = read.token.trim();
    const repo = normalizeRepo(read.repo);
    return {
      repo,
      token,
      base: `${hosts.api}/repos/${repo}`,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    };
  };

  const releasesUrl = (base: string): string => `${base}/releases?per_page=100`;

  const downloadUrl = (repo: string, tag: string, file: string): string =>
    `${hosts.site}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(file)}`;

  const parseDownloadUrl = (url: string): PackageLocation | undefined => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (parsed.origin !== site.origin) return undefined;
    const match = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(parsed.pathname);
    if (!match) return undefined;
    try {
      const tag = decodeURIComponent(match[3]!);
      const file = decodeURIComponent(match[4]!);
      const identity = identify(file, tag);
      return identity && { repo: `${match[1]}/${match[2]}`, tag, file, ...identity };
    } catch {
      return undefined;
    }
  };

  const available = (repo: string, asset: ReleaseAsset): AvailablePackage => ({
    name: asset.name,
    version: asset.version,
    plugin: asset.name,
    url: downloadUrl(repo, asset.tag, asset.file),
  });

  const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  const linked = (path: string): LinkedSource | undefined => {
    try {
      const repo = repoPath(decodeURIComponent(path).split("/"));
      return { name: `${repo} on GitHub`.slice(0, 80), settings: writeSettings({ repo, token: "" }) };
    } catch {
      return undefined;
    }
  };

  const fromLink = (link: string): LinkedSource | undefined => {
    const raw = link.trim();
    const ssh = /^(?:ssh:\/\/)?git@([^:/\s]+)[:/](.+)$/.exec(raw);
    if (ssh) return siteHosts.has(ssh[1]!.toLowerCase()) ? linked(ssh[2]!) : undefined;
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      return undefined;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.host === apiHost) {
      const api = /^\/repos\/([^/]+\/[^/]+)/.exec(url.pathname);
      return api ? linked(api[1]!) : undefined;
    }
    return siteHosts.has(url.host) ? linked(url.pathname) : undefined;
  };

  const validate = (settings: SourceSettings): string | undefined => {
    try {
      normalizeRepo(readSettings(settings).repo);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return undefined;
  };

  return {
    normalizeRepo,
    validate,
    downloadUrl,
    parseDownloadUrl,
    fromLink,

    async test(settings) {
      const endpoint = endpointOf(settings);
      const repo = (await load(endpoint.base, endpoint.headers)) as { full_name?: unknown } | undefined;
      const label = typeof repo?.full_name === "string" ? repo.full_name : endpoint.repo;
      const packages = newestPerName(await load(releasesUrl(endpoint.base), endpoint.headers));
      const listed = packages.map((found) => `${found.name} ${found.version}`).join(", ");
      return packages.length === 0
        ? `Reached ${label}, but none of its published releases has a .zip asset yet.`
        : `Reached ${label}: ${packages.length} package${packages.length === 1 ? "" : "s"} (${listed}).`;
    },

    async browse(source) {
      const endpoint = endpointOf(source);
      return newestPerName(await load(releasesUrl(endpoint.base), endpoint.headers)).map((asset) =>
        available(endpoint.repo, asset),
      );
    },

    async download(source, url) {
      const endpoint = endpointOf(source);
      const location = parseDownloadUrl(url);
      if (!location || !sameRepo(location.repo, endpoint.repo)) {
        throw new Error(`${url} is not a release download of ${endpoint.repo}`);
      }
      const release = await load(`${endpoint.base}/releases/tags/${encodeURIComponent(location.tag)}`, endpoint.headers);
      const asset = assetsOf(release as ListedRelease).find((found) => found.file === location.file);
      if (!asset) throw new Error(`release ${location.tag} of ${endpoint.repo} has no ${location.file}`);
      return fetchAsset({ repo: endpoint.repo, asset: asset.id, ...(endpoint.token ? { token: endpoint.token } : {}) });
    },

    async checkUpdates(source, plugins, report) {
      const endpoint = endpointOf(source);
      const installed = plugins.flatMap((plugin) => {
        const location = parseDownloadUrl(plugin.url);
        return location && sameRepo(location.repo, endpoint.repo) ? [{ plugin, location }] : [];
      });
      if (installed.length === 0) return;
      const releases = await load(releasesUrl(endpoint.base), endpoint.headers);
      const newest = new Map(newestPerName(releases).map((asset) => [asset.name, asset]));
      for (const { plugin, location } of installed) {
        const found = newest.get(location.name);
        if (!found || compareVersions(found.version, location.version) <= 0) continue;
        report({
          plugin: plugin.id,
          source: source.id,
          current: plugin.version,
          latest: found.version,
          url: downloadUrl(endpoint.repo, found.tag, found.file),
        });
      }
    },
  };
}

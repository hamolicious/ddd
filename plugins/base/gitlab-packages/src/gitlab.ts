import type { RemotePackageRequest } from "plugin:admin";

export type TokenKind = "none" | "access" | "deploy" | "job";

export const TOKEN_HEADERS: Readonly<Record<Exclude<TokenKind, "none">, string>> = {
  access: "PRIVATE-TOKEN",
  deploy: "Deploy-Token",
  job: "JOB-TOKEN",
};

export interface GenericPackage {
  readonly instance: string;
  readonly project: string;
  readonly name: string;
  readonly version: string;
  readonly file: string;
  readonly tokenKind: TokenKind;
  readonly token: string;
}

export const DEFAULT_INSTANCE = "https://gitlab.com";

export function defaultFileName(name: string, version: string): string {
  const trimmedName = name.trim();
  const trimmedVersion = version.trim();
  return trimmedName && trimmedVersion ? `${trimmedName}-${trimmedVersion}.zip` : "";
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
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("the GitLab address must start with https:// or http://");
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

function segment(label: string, raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error(`the package ${label} is missing`);
  if (value.includes("/")) throw new Error(`the package ${label} cannot contain "/"`);
  return value;
}

export function packageRequest(input: GenericPackage): RemotePackageRequest {
  const instance = normalizeInstance(input.instance);
  const project = normalizeProject(input.project, instance);
  const file = input.file.trim() || defaultFileName(input.name, input.version);
  const url = packageUrl({
    instance,
    project,
    name: segment("name", input.name),
    version: segment("version", input.version),
    file: segment("file name", file),
  });

  const token = input.token.trim();
  const headers: Record<string, string> = {};
  if (input.tokenKind !== "none") {
    if (!token) throw new Error("enter the token, or choose “No token” for a public project");
    headers[TOKEN_HEADERS[input.tokenKind]] = token;
  }

  return {
    url,
    headers,
    label: `${input.name.trim()} ${input.version.trim()} from ${project}`,
  };
}

export interface PackageLocation {
  readonly instance: string;
  readonly project: string;
  readonly name: string;
  readonly version: string;
  readonly file: string;
}

const GENERIC_PATH = /^(.*)\/api\/v4\/projects\/([^/]+)\/packages\/generic\/([^/]+)\/([^/]+)\/([^/?#]+)$/;

export function parsePackageUrl(url: string): PackageLocation | undefined {
  const match = GENERIC_PATH.exec(url.replace(/[?#].*$/, ""));
  if (!match) return undefined;
  const [, instance, project, name, version, file] = match;
  try {
    return {
      instance: instance!,
      project: decodeURIComponent(project!),
      name: decodeURIComponent(name!),
      version: decodeURIComponent(version!),
      file: decodeURIComponent(file!),
    };
  } catch {
    return undefined;
  }
}

export function packageUrl(location: PackageLocation): string {
  return (
    `${location.instance}/api/v4/projects/${encodeURIComponent(location.project)}/packages/generic/` +
    `${encodeURIComponent(location.name)}/${encodeURIComponent(location.version)}/${encodeURIComponent(location.file)}`
  );
}

export function packageListUrl(location: PackageLocation): string {
  return (
    `${location.instance}/api/v4/projects/${encodeURIComponent(location.project)}/packages` +
    `?package_type=generic&package_name=${encodeURIComponent(location.name)}&per_page=100`
  );
}

export function packageFilesUrl(location: PackageLocation, packageId: number): string {
  return `${location.instance}/api/v4/projects/${encodeURIComponent(location.project)}/packages/${packageId}/package_files?per_page=100`;
}

function versionParts(version: string): { readonly core: readonly number[]; readonly pre: string } {
  const [main = "", pre = ""] = version.trim().replace(/^v/i, "").split("+")[0]!.split(/-(.*)/s);
  return { core: main.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
}

export function compareVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.core.length, right.core.length); index++) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

export interface ListedPackage {
  readonly id: number;
  readonly name: string;
  readonly version: string;
  readonly status?: string;
}

export function newestRelease(listed: unknown, location: PackageLocation): ListedPackage | undefined {
  if (!Array.isArray(listed)) return undefined;
  let newest: ListedPackage | undefined;
  for (const entry of listed as readonly Partial<ListedPackage>[]) {
    if (typeof entry?.id !== "number" || entry.name !== location.name || typeof entry.version !== "string") continue;
    if (entry.status !== undefined && entry.status !== "default") continue;
    const candidate = entry as ListedPackage;
    if (!newest || compareVersions(candidate.version, newest.version) > 0) newest = candidate;
  }
  return newest && compareVersions(newest.version, location.version) > 0 ? newest : undefined;
}

export function chooseFile(files: unknown, location: PackageLocation, version: string): string | undefined {
  if (!Array.isArray(files)) return undefined;
  const names = (files as readonly { readonly file_name?: unknown }[])
    .map((file) => file?.file_name)
    .filter((name): name is string => typeof name === "string");
  const renamed = location.file.split(location.version).join(version);
  return [renamed, location.file].find((name) => names.includes(name)) ?? names.find((name) => name.endsWith(".zip"));
}

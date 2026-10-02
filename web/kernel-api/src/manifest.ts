import {
  MANIFEST_SCHEMA,
  type ManifestSchemaNode,
  type PluginManifest,
} from "./manifest.generated.js";

export type {
  BackendExport,
  HttpCapability,
  PluginBackend,
  PluginCapabilities,
  PluginConfigField,
  PluginFrontend,
  PluginManifest,
} from "./manifest.generated.js";

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

export type PluginState = "enabled" | "disabled" | "pending" | "failed";

export interface InstalledPlugin {
  readonly manifest: PluginManifest;
  readonly baseUrl: string;
  readonly state: PluginState;
  readonly base: boolean;
  readonly assetsVersion?: string;
}

export interface PluginLoad {
  readonly normal: readonly string[];
  readonly safe: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

export interface ManifestProblem {
  readonly field: string;
  readonly message: string;
}

export function validateManifest(value: unknown): readonly ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  check(MANIFEST_SCHEMA, value, "", problems);
  return problems;
}

export function isManifest(value: unknown): value is PluginManifest {
  return validateManifest(value).length === 0;
}

const join = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function resolveNode(node: ManifestSchemaNode): ManifestSchemaNode {
  if (!node.$ref) return node;
  return MANIFEST_SCHEMA.$defs?.[node.$ref.replace("#/$defs/", "")] ?? {};
}

function check(raw: ManifestSchemaNode, value: unknown, path: string, problems: ManifestProblem[]): void {
  const node = resolveNode(raw);
  const push = (field: string, message: string): void => void problems.push({ field, message });
  switch (node.type) {
    case "object": {
      if (!isRecord(value)) return push(path, "must be an object");
      for (const key of node.required ?? []) {
        if (value[key] === undefined) push(join(path, key), "is required");
      }
      for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) continue;
        const at = join(path, key);
        const removed = node["x-removed"]?.[key];
        if (removed !== undefined) {
          push(at, removed);
          continue;
        }
        const property = node.properties?.[key];
        if (property) {
          check(property, entry, at, problems);
          continue;
        }
        const nameFormat = node.propertyNames?.format;
        const nameProblem = nameFormat ? formatProblem(nameFormat, key) : undefined;
        if (nameProblem) {
          push(at, nameProblem);
          continue;
        }
        if (node.additionalProperties === false) push(at, "is not a known field");
        else if (typeof node.additionalProperties === "object") check(node.additionalProperties, entry, at, problems);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) return push(path, "must be an array");
      if (node.items) value.forEach((entry, index) => check(node.items!, entry, `${path}[${index}]`, problems));
      return;
    }
    case "string": {
      if (typeof value !== "string") return push(path, "must be a string");
      if (node.enum && !node.enum.includes(value)) {
        return push(path, `must be one of ${node.enum.map((v) => JSON.stringify(v)).join(", ")}`);
      }
      const problem = node.format ? formatProblem(node.format, value) : undefined;
      if (problem) push(path, problem);
      return;
    }
    case "boolean":
      if (typeof value !== "boolean") push(path, "must be a boolean");
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) push(path, "must be a number");
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return push(path, "must be an integer");
      if (node.minimum !== undefined && value < node.minimum) push(path, `must be at least ${node.minimum}`);
      return;
    default:
      return;
  }
}

export function formatProblem(format: string, text: string): string | undefined {
  switch (format) {
    case "plugin-id":
      return PLUGIN_ID_PATTERN.test(text) ? undefined : `must match ${String(PLUGIN_ID_PATTERN).slice(1, -1)}`;
    case "semver":
      return isValidVersion(text) ? undefined : "must be a semver version";
    case "semver-range":
      return isSemverRange(text) ? undefined : "must be a semver range, e.g. ^1.0";
    case "relative-path":
      return isSafeRelativePath(text) ? undefined : "must be a relative path inside the package, without `..`";
    case "plugin-ref":
      return parsePluginRef(text) ? undefined : "must be <plugin-id>@<version>, e.g. editor@2.0.0";
    default:
      return undefined;
  }
}

export function isValidVersion(version: string): boolean {
  if (version.length === 0 || version.length > 128) return false;
  const plus = version.indexOf("+");
  const withoutBuild = plus === -1 ? version : version.slice(0, plus);
  const build = plus === -1 ? undefined : version.slice(plus + 1);
  const dash = withoutBuild.indexOf("-");
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? undefined : withoutBuild.slice(dash + 1);
  const parts = core.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^\d+$/.test(part))) return false;
  const identifiers = (tail: string | undefined): boolean =>
    tail === undefined || (tail.length > 0 && tail.split(".").every((id) => /^[0-9A-Za-z-]+$/.test(id)));
  return identifiers(pre) && identifiers(build);
}

export function isSemverRange(range: string): boolean {
  return range === "*" || /^(?:\^|~|>=|<=|=|>|<)?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.+-]+)?$/.test(range);
}

export function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !path.split("/").some((segment) => segment === ".." || segment === ".")
  );
}

export function parsePluginRef(text: string): { readonly id: string; readonly version: string } | undefined {
  const at = text.indexOf("@");
  if (at === -1) return undefined;
  const id = text.slice(0, at);
  const version = text.slice(at + 1);
  return PLUGIN_ID_PATTERN.test(id) && isValidVersion(version) ? { id, version } : undefined;
}

export function satisfies(version: string, range: string): boolean {
  const spec = range.trim();
  if (spec === "" || spec === "*") return true;
  const parse = (input: string): readonly number[] | undefined => {
    const core = input.split(/[-+]/, 1)[0] ?? "";
    const parts = core.split(".");
    if (parts.length === 0 || parts.length > 3) return undefined;
    const numbers = parts.map((part) => Number.parseInt(part, 10));
    return numbers.some((n) => Number.isNaN(n)) ? undefined : numbers;
  };
  const actual = parse(version);
  if (!actual) return false;
  const [major = 0, minor = 0, patch = 0] = actual;

  const operator = /^(\^|~|>=|<=|>|<|=)?\s*(.*)$/.exec(spec);
  const wanted = parse(operator?.[2] ?? spec);
  if (!wanted) return false;
  const [wMajor = 0, wMinor = 0, wPatch = 0] = wanted;
  const cmp =
    major !== wMajor ? major - wMajor : minor !== wMinor ? minor - wMinor : patch - wPatch;

  switch (operator?.[1]) {
    case "^":
      return wMajor === 0
        ? major === 0 && minor === wMinor && cmp >= 0
        : major === wMajor && cmp >= 0;
    case "~":
      return major === wMajor && minor === wMinor && cmp >= 0;
    case ">=":
      return cmp >= 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case "<":
      return cmp < 0;
    default:
      return wanted.length === 3 ? cmp === 0 : major === wMajor && minor === wMinor;
  }
}

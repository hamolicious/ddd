/**
 * The plugin manifest (SPEC §6.2) and the loader's view of an installed plugin.
 *
 * The **server** is the authority: it validates manifests at install, resolves the
 * dependency graph and the `peerLibraries` ranges, and serves the result. The
 * loader re-validates independently anyway, for one reason given in SPEC §6.4: a
 * stale offline client must hard-skip a plugin built for a kernel it does not
 * implement, rather than activate it and fail in pieces.
 *
 * M3 uses the frontend half only. `backend`, `config` and most `capabilities`
 * entries are declared here because the shape is frozen now and enforced in M4.
 *
 * **FROZEN.**
 */

import {
  MANIFEST_SCHEMA,
  type ManifestSchemaNode,
  type PluginManifest,
} from "./manifest.generated.js";

/**
 * The manifest's types are generated from `schema/manifest.schema.json`, the one source the
 * server's types come from too (`web/scripts/gen-manifest.mjs`, PLUGIN-PROTOCOLS §9 step 1).
 */
export type {
  ConsumedPort,
  HttpCapability,
  PluginBackend,
  PluginCapabilities,
  PluginConfigField,
  PluginFrontend,
  PluginManifest,
  ProvidedPort,
} from "./manifest.generated.js";

/** `^[a-z0-9][a-z0-9-]{0,63}$` — also the URL segment under `/plugins/`. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `1.2.3` with an optional prerelease/build tail. */
export const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

/** A port name: local to its plugin, never containing the `:` that joins it to an id. */
export const PORT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export type PluginState = "enabled" | "disabled" | "pending" | "failed";

/**
 * One entry of what the server tells the loader (`GET /api/plugins`).
 *
 * `baseUrl` is version-scoped — `/plugins/<id>/<version>/` — so every asset is
 * immutable and cacheable forever (SPEC §8), and a plugin upgrade is a new URL
 * rather than a cache invalidation.
 */
export interface InstalledPlugin {
  readonly manifest: PluginManifest;
  readonly baseUrl: string;
  readonly state: PluginState;
  /** `true` for the base distribution — what `?safe=1` boots (SPEC §6.1). */
  readonly base: boolean;
  /**
   * Short content fingerprint of the frontend assets, appended by the loader as `?v=`.
   * Busts every cache layer when the served bytes change without a version bump (a
   * rebuilt base distribution); same bytes keep the same URL, so "immutable, cached
   * forever" stays true. Absent on older servers — URLs are then plain, as before.
   */
  readonly assetsVersion?: string;
}

export interface ManifestProblem {
  readonly field: string;
  readonly message: string;
}

/**
 * Structural validation of a manifest: an interpreter over the generated schema.
 *
 * The server runs the same interpreter over the same schema (`manifest_schema.rs`), and
 * `schema/fixtures/manifests.json` pins that both report the same fields. This is still the
 * client's own floor rather than a duplicate of the install-time checks (dependency
 * resolution, capability approval, zip hardening are all server-side): a stale offline
 * client re-checks what it was served (SPEC §6.4).
 */
export function validateManifest(value: unknown): readonly ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  check(MANIFEST_SCHEMA, value, "", problems);
  return problems;
}

/** The same as `validateManifest`, typed as a guard for callers that only need yes or no. */
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

/**
 * The message for a string that fails `format`, or `undefined` when it passes. Each check
 * has the same definition as its twin in `manifest_schema.rs`.
 */
export function formatProblem(format: string, text: string): string | undefined {
  switch (format) {
    case "plugin-id":
      return PLUGIN_ID_PATTERN.test(text) ? undefined : `must match ${String(PLUGIN_ID_PATTERN).slice(1, -1)}`;
    case "semver":
      return isValidVersion(text) ? undefined : "must be a semver version";
    case "semver-range":
      return isSemverRange(text) ? undefined : "must be a semver range, e.g. ^1.0";
    case "relative-path":
      // The server canonicalizes too; a client that trusted the manifest here would
      // happily fetch `/plugins/x/1.0.0/../../etc/passwd`.
      return isSafeRelativePath(text) ? undefined : "must be a relative path inside the package, without `..`";
    case "port-name":
      return PORT_NAME_PATTERN.test(text) ? undefined : `must match ${String(PORT_NAME_PATTERN).slice(1, -1)}`;
    case "protocol-exact": {
      const ref = parseProtocolRef(text);
      return ref && isValidVersion(ref.version)
        ? undefined
        : "must be <publisher>/<name>@<version>, e.g. lm/router@1.0.0";
    }
    case "protocol-range": {
      const ref = parseProtocolRef(text);
      return ref && isSemverRange(ref.version)
        ? undefined
        : "must be <publisher>/<name>@<range>, e.g. lm/router@^1.0";
    }
    default:
      return undefined;
  }
}

/**
 * `1.2.3` with an optional `-prerelease` / `+build` tail, **every character checked**: the
 * version is a path segment on the server (`<PLUGINS_DIR>/<id>/<version>/`).
 */
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

/** `*`, or an optional `^ ~ = >= <= > <` and one to three numeric parts, with an optional tail. */
export function isSemverRange(range: string): boolean {
  return range === "*" || /^(?:\^|~|>=|<=|=|>|<)?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.+-]+)?$/.test(range);
}

/** Non-empty, not absolute, no backslash or drive letter, no `.` or `..` segment. */
export function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !path.split("/").some((segment) => segment === ".." || segment === ".")
  );
}

/** `<publisher>/<name>`: publisher like a plugin id, name dotted and possibly camelCase. */
export function isProtocolId(id: string): boolean {
  const slash = id.indexOf("/");
  if (slash === -1) return false;
  const publisher = id.slice(0, slash);
  const name = id.slice(slash + 1);
  return (
    PLUGIN_ID_PATTERN.test(publisher) &&
    /^[a-z0-9][A-Za-z0-9.-]{0,127}$/.test(name) &&
    !name.endsWith(".") &&
    !name.includes("..")
  );
}

/** Split `lm/router@^1.0` into its id and version (or range). */
export function parseProtocolRef(text: string): { readonly id: string; readonly version: string } | undefined {
  const at = text.indexOf("@");
  if (at === -1) return undefined;
  const id = text.slice(0, at);
  const version = text.slice(at + 1);
  return isProtocolId(id) && version.length > 0 ? { id, version } : undefined;
}

/**
 * Does `version` satisfy `range`? Supports exactly what manifests use: `*`,
 * `^x.y`, `^x.y.z`, `~x.y.z`, `>=x.y.z`, and an exact `x.y.z`.
 *
 * Deliberately not a semver library — a dependency in the kernel contract is a
 * dependency in every plugin's bundle, and this is 30 lines. The *server* does the
 * real resolution at install time (SPEC §6.2); this is the loader's boot-time
 * re-check of one version against one range.
 */
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
      // Caret on 0.x is the strict reading: 0.2.x and 0.3.x are incompatible.
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
      // A bare `1.2` means "any patch of 1.2"; a bare `1.2.3` is exact.
      return wanted.length === 3 ? cmp === 0 : major === wMajor && minor === wMinor;
  }
}

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

/** `^[a-z0-9][a-z0-9-]{0,63}$` — also the URL segment under `/plugins/`. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `1.2.3` with an optional prerelease/build tail. */
export const PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

export interface PluginCapabilities {
  /** Gates the server-side document host functions (SPEC §6.2). */
  readonly documents?: readonly ("read" | "write")[];
  /** Outbound HTTP, per declared hosts. No wildcards. */
  readonly http?: { readonly hosts: readonly string[] };
  readonly notifications?: boolean;
  /** Unauthenticated routes under `/api/plugins/<id>` — shown at install. */
  readonly "public-routes"?: readonly string[];
}

export interface PluginConfigField {
  readonly type: "string" | "number" | "boolean";
  /** Write-only in the admin UI, encrypted at rest (SPEC §6.2). */
  readonly secret?: boolean;
  readonly label?: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface PluginBackend {
  /** Path inside the package, e.g. `backend.wasm`. */
  readonly module: string;
  readonly hooks?: readonly ("document.created" | "document.changed" | "document.deleted")[];
  /** UTC cron expressions. */
  readonly cron?: readonly string[];
}

export interface PluginFrontend {
  /** Path inside the package, e.g. `frontend/index.mjs`. */
  readonly module: string;
  /** Linked on activation (SPEC §6.4). */
  readonly style?: string;
}

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  /** Semver range against the `@kernel` contract version. */
  readonly kernel: string;
  /** Plugin id → semver range. Resolved server-side at install. */
  readonly dependencies?: Readonly<Record<string, string>>;
  /** Blessed runtime-layer libraries and their ranges (SPEC §6.4). */
  readonly peerLibraries?: Readonly<Record<string, string>>;
  readonly capabilities?: PluginCapabilities;
  readonly config?: Readonly<Record<string, PluginConfigField>>;
  readonly backend?: PluginBackend;
  readonly frontend?: PluginFrontend;
  /** Human metadata; never load-bearing. */
  readonly name?: string;
  readonly description?: string;
  readonly author?: string;
  readonly license?: string;
}

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
 * Structural validation of a manifest. Independent of the server's, deliberately:
 * this is the client's own floor, not a duplicate of the install-time checks
 * (dependency resolution, capability approval, zip hardening are all server-side).
 */
export function validateManifest(value: unknown): readonly ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [{ field: "", message: "manifest must be a JSON object" }];
  }
  const m = value as Record<string, unknown>;

  const id = m["id"];
  if (typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) {
    problems.push({ field: "id", message: `must match ${String(PLUGIN_ID_PATTERN)}` });
  }
  const version = m["version"];
  if (typeof version !== "string" || !PLUGIN_VERSION_PATTERN.test(version)) {
    problems.push({ field: "version", message: "must be a semver version" });
  }
  if (typeof m["kernel"] !== "string") {
    problems.push({ field: "kernel", message: "must be a semver range, e.g. ^1.0" });
  }
  for (const key of ["dependencies", "peerLibraries"] as const) {
    const bag = m[key];
    if (bag === undefined) continue;
    if (typeof bag !== "object" || bag === null || Array.isArray(bag)) {
      problems.push({ field: key, message: "must be an object of ranges" });
      continue;
    }
    for (const [name, range] of Object.entries(bag)) {
      if (typeof range !== "string") {
        problems.push({ field: `${key}.${name}`, message: "range must be a string" });
      }
    }
  }
  const frontend = m["frontend"];
  if (frontend !== undefined) {
    if (typeof frontend !== "object" || frontend === null) {
      problems.push({ field: "frontend", message: "must be an object" });
    } else {
      const f = frontend as Record<string, unknown>;
      if (typeof f["module"] !== "string") {
        problems.push({ field: "frontend.module", message: "must be a path inside the package" });
      }
      for (const key of ["module", "style"] as const) {
        const path = f[key];
        // The server canonicalizes too; a client that trusted the manifest here
        // would happily fetch `/plugins/x/1.0.0/../../etc/passwd`.
        if (typeof path === "string" && (path.startsWith("/") || path.includes(".."))) {
          problems.push({ field: `frontend.${key}`, message: "must be a relative path without `..`" });
        }
      }
    }
  }
  return problems;
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

/**
 * Path normalization and route matching: the whole of the router that is worth
 * testing, with no DOM and no kernel in it.
 *
 * The rules, decided here so they are decided once:
 *
 * - **A path is the part after `#`**, normalized: exactly one leading `/`, no
 *   duplicate separators, no trailing `/` (except the root), query and fragment
 *   trimmed off. `#/doc/01J…`, `/doc/01J…` and `doc/01J…/` are the same route.
 * - **`:name` captures one segment** and is percent-decoded. A pattern matches only
 *   when the segment counts agree, so `/doc/:id` never eats `/doc/a/b`.
 * - **A trailing `*` captures the rest** into `params.rest`, and is the lowest-
 *   priority form there is — it exists so a catch-all route is possible without
 *   making every other route negotiate with it.
 * - **Most specific wins, seat order breaks ties.** Specificity is the count of literal
 *   segments, because that is what "`/settings/theme` beats `/settings/:section`"
 *   means; between genuinely equivalent patterns the position in `routes` decides,
 *   and the host hands routes over in the wiring's seat order (PLUGIN-PROTOCOLS
 *   §6a), so ties are stable across reloads and editable in the wiring. A route's
 *   own `order` field is the default-seat hint and is not read here.
 * - **Literal segments compare exactly**, case included. Case-insensitive matching
 *   would make `/Doc/x` and `/doc/x` the same URL and two different cache entries in
 *   every layer above.
 */

import type { Route } from "@protocols/lm/router.route";

export interface RouteMatch {
  /** The `main.view` id to render. */
  readonly view: string;
  readonly params: Readonly<Record<string, string>>;
  /** The pattern that matched, for diagnostics. */
  readonly pattern: string;
}

/**
 * `#/a//b/?x=1` → `/a/b`. Accepts a full hash, a bare path, or an empty string
 * (which is the root: a first visit has no hash at all).
 */
export function normalizePath(raw: string): string {
  let path = raw.startsWith("#") ? raw.slice(1) : raw;
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** The query string of a hash path (`#/search?q=x` → `?q=x`), or `""`. */
export function pathQuery(raw: string): string {
  const path = raw.startsWith("#") ? raw.slice(1) : raw;
  const at = path.indexOf("?");
  return at < 0 ? "" : path.slice(at);
}

/**
 * Normalized path **plus** query — what the router reports as "the current path".
 *
 * The query is part of the address even though it plays no part in matching: a
 * `:name` segment cannot hold a `/`, so a view addressed by something path-shaped
 * (`#/search?q=home/lists`) has to carry it in the query, and such a view has to be
 * told when *only* the query changed.
 */
export function fullPath(raw: string): string {
  return `${normalizePath(raw)}${pathQuery(raw)}`;
}

/** Params if `pattern` matches `path`, otherwise `undefined`. */
export function matchPath(
  pattern: string,
  path: string,
): Readonly<Record<string, string>> | undefined {
  const expected = segmentsOf(pattern);
  const actual = segmentsOf(normalizePath(path));
  const wildcard = expected.at(-1) === "*";
  const fixed = wildcard ? expected.slice(0, -1) : expected;

  if (wildcard ? actual.length < fixed.length : actual.length !== fixed.length) return undefined;

  const params: Record<string, string> = {};
  for (const [index, segment] of fixed.entries()) {
    const value = actual[index];
    if (value === undefined) return undefined;
    if (segment.startsWith(":")) {
      const name = segment.slice(1);
      if (name.length === 0) return undefined;
      params[name] = decode(value);
      continue;
    }
    if (segment !== value) return undefined;
  }
  if (wildcard) params["rest"] = actual.slice(fixed.length).map(decode).join("/");
  return params;
}

/**
 * The best match among `routes`, or `undefined`. `routes` arrives in seat order, which
 * is the final tiebreaker — so this is a stable sort, not a scan.
 */
export function matchRoutes(
  routes: readonly Route[],
  path: string,
): RouteMatch | undefined {
  const normalized = normalizePath(path);
  const candidates: { readonly route: Route; readonly index: number; readonly params: Readonly<Record<string, string>> }[] = [];

  for (const [index, route] of routes.entries()) {
    const params = matchPath(route.path, normalized);
    if (params) candidates.push({ route, index, params });
  }
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => compareSpecificity(a.route, b.route) || a.index - b.index);
  const best = candidates[0];
  if (!best) return undefined;
  return { view: best.route.view, params: best.params, pattern: best.route.path };
}

/**
 * Negative ⇒ `a` wins; `0` ⇒ equally specific, and the caller's order (seat order)
 * decides. Exported because the ordering is a documented promise.
 */
export function compareSpecificity(a: Route, b: Route): number {
  const left = shape(a.path);
  const right = shape(b.path);
  if (left.wildcard !== right.wildcard) return left.wildcard ? 1 : -1;
  if (left.literals !== right.literals) return right.literals - left.literals;
  return left.params - right.params;
}

/** Fill a pattern's `:name` slots. The only sanctioned way to build a path. */
export function buildPath(pattern: string, params: Readonly<Record<string, string>> = {}): string {
  const filled = segmentsOf(pattern).map((segment) => {
    if (segment === "*") return encodeURIComponent(params["rest"] ?? "");
    if (!segment.startsWith(":")) return segment;
    const name = segment.slice(1);
    const value = params[name];
    if (value === undefined || value === "") {
      throw new Error(`cannot build "${pattern}": no value for ":${name}"`);
    }
    return encodeURIComponent(value);
  });
  return filled.length === 0 ? "/" : `/${filled.join("/")}`;
}

function segmentsOf(pattern: string): readonly string[] {
  return pattern.split("/").filter((segment) => segment.length > 0);
}

function shape(pattern: string): { literals: number; params: number; wildcard: boolean } {
  let literals = 0;
  let params = 0;
  let wildcard = false;
  for (const segment of segmentsOf(pattern)) {
    if (segment === "*") wildcard = true;
    else if (segment.startsWith(":")) params += 1;
    else literals += 1;
  }
  return { literals, params, wildcard };
}

/** A half-typed `%` in the address bar is a bad URL, not a crash. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

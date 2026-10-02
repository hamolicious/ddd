import type { Route } from "./api.js";

export interface RouteMatch {
  readonly view: string;
  readonly params: Readonly<Record<string, string>>;
  readonly pattern: string;
}

export function normalizePath(raw: string): string {
  let path = raw.startsWith("#") ? raw.slice(1) : raw;
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function pathQuery(raw: string): string {
  const path = raw.startsWith("#") ? raw.slice(1) : raw;
  const at = path.indexOf("?");
  return at < 0 ? "" : path.slice(at);
}

export function fullPath(raw: string): string {
  return `${normalizePath(raw)}${pathQuery(raw)}`;
}

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

export function compareSpecificity(a: Route, b: Route): number {
  const left = shape(a.path);
  const right = shape(b.path);
  if (left.wildcard !== right.wildcard) return left.wildcard ? 1 : -1;
  if (left.literals !== right.literals) return right.literals - left.literals;
  return left.params - right.params;
}

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

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

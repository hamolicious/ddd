/**
 * `router` — URL ↔ view (SPEC §6.5).
 *
 * ## API (`plugin:router`)
 *
 * Contributions:
 * - `addRoute(route | routes)` → unregister. `Route` is `{ path, view, order? }`; a route
 *   with the same `path` as an earlier one replaces it.
 *
 * The old `lm/router` service, member for member, as named exports:
 * - `navigate(path, { replace? })`, `current()`, `query()`, `match(path)`,
 *   `onChange(listener)` → unsubscribe, `href(pattern, params?)`, `url(path)`,
 *   `documentPath(id)`, `Link` (component).
 *
 * Constants: `NOT_FOUND_VIEW`, `DOCUMENT_ROUTE`.
 * Types: `Route`, `LinkProps`, `RouteMatch`, `Router` (the service members as one type),
 * `RouterApi` (the same).
 *
 * **Hash paths driven through the History API.** The address is `#/doc/01J…`
 * because the Flutter shell serves the bundle from a local origin with no server to
 * rewrite paths (SPEC §7) and the service worker's `index.html` fallback is the
 * PWA's equivalent — a hash path is the one form that works in both with no special
 * case, and it is the spelling the rest of the distribution already writes
 * (`location.hash = "/settings"`, `#/admin/plugins`). Navigation itself goes through
 * `history.pushState`/`replaceState` so "replace, don't push" is expressible and
 * back/forward arrive as `popstate`; on an origin where `pushState` is refused
 * (`file://` in a webview) it degrades to assigning `location.hash`, which is the
 * same navigation minus the ability to replace.
 *
 * The router does not render views: it resolves a URL to a view id plus params and
 * tells the shell (`shell-ui`'s `setMainView`). That separation is what lets a command
 * open a view without touching the URL, and a URL open a view without a command.
 *
 * Routes are kept sorted by `order`, then the order they were added in; the most
 * specific pattern wins and that order only breaks ties (`match.ts`).
 */

import { createRegistry, s, type Kernel } from "@kernel";

import { addView, setMainView } from "plugin:shell-ui";

import type { Route, RouteMatch, Router } from "./api.js";
import { createLink } from "./Link.js";
import { buildPath, fullPath, matchRoutes, pathQuery } from "./match.js";

export type { LinkProps, Route, RouteMatch, Router } from "./api.js";

/** The navigation exports as one type; the same as `Router`. */
export type RouterApi = Router;

/** The view the router selects when nothing matches. Added in `activate`. */
export const NOT_FOUND_VIEW = "router.notFound";

/**
 * The canonical document route, exported so `document-surface` registers exactly the
 * path `markdown`'s `doc://` links and every doc list build. One constant beats four
 * plugins hand-concatenating the same string slightly differently.
 */
export const DOCUMENT_ROUTE = "/doc/:id";

const routes = createRegistry<Route>({
  key: (route) => route.path,
  order: (route) => route.order ?? 0,
  shape: s.object({ path: s.string(), view: s.string(), order: s.optional(s.number()) }),
});

/** Add a route (or several). Returns the function that removes them again. */
export const addRoute: (items: Route | readonly Route[]) => () => void = routes.add;

const listeners = new Set<(path: string) => void>();
let applied: string | undefined;

/** The current path and query string, without the leading `#`. */
export function current(): string {
  return fullPath(location.hash);
}

/** The `<a href>` form of a concrete path (`/doc/x` → `#/doc/x`). */
export function url(path: string): string {
  return `#${fullPath(path)}`;
}

/**
 * Resolve the current URL, tell the shell, and notify subscribers once.
 *
 * The dedupe key is the path **and** query: a view addressed by a query
 * (`#/search?q=groceries`) matches the same route for every query, so comparing
 * paths alone would navigate the shell and tell nobody.
 */
function resolve(): void {
  const path = current();
  const found = matchRoutes(routes.get(), path);
  if (found) setMainView(found.view, found.params);
  else setMainView(NOT_FOUND_VIEW, { path });

  if (path === applied) return;
  applied = path;
  for (const listener of [...listeners]) listener(path);
}

/** Navigate, pushing history (or replacing it). `path` is concrete: `/doc/01J…`. */
export function navigate(path: string, options?: { readonly replace?: boolean }): void {
  const hash = url(path);
  try {
    const href = `${location.pathname}${location.search}${hash}`;
    if (options?.replace) history.replaceState(history.state, "", href);
    else history.pushState(null, "", href);
  } catch {
    // `pushState` is refused on an opaque origin (`file://` in the shell webview).
    // Assigning the hash is the same navigation; `replace` becomes a push.
    location.hash = hash.slice(1);
  }
  resolve();
}

/** The current query string, parsed (`#/search?q=cake`). */
export function query(): URLSearchParams {
  return new URLSearchParams(pathQuery(location.hash));
}

/** Resolve a path against the added routes. */
export function match(path: string): RouteMatch | undefined {
  const found = matchRoutes(routes.get(), path);
  return found ? { view: found.view, params: found.params } : undefined;
}

/** Hear every navigation, with the new path and query. */
export function onChange(listener: (path: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Build a path from a pattern and params; never hand-concatenate one. */
export function href(pattern: string, params?: Readonly<Record<string, string>>): string {
  return buildPath(pattern, params);
}

/** The canonical path for one document. */
export function documentPath(id: string): string {
  return buildPath(DOCUMENT_ROUTE, { id });
}

/** An anchor that navigates in-app and marks itself `aria-current="page"`. */
export const Link: Router["Link"] = createLink({ current, onChange, navigate, url });

/** What `activate` set up outside the registries; undone by `deactivate`. */
let teardown: (() => void) | undefined;

export default function activate(_kernel: Kernel): void {
  teardown?.();

  // Where the router puts a URL nobody claimed. It is a view like any other, so a
  // workspace that wants a prettier 404 replaces it by id.
  const removeView = addView({
    id: NOT_FOUND_VIEW,
    title: "Not found",
    component: ({ params }) => (
      <div className="router:mx-auto router:max-w-[34rem] router:px-4 router:py-8 router:font-sans router:text-text-muted">
        <h1 className="router:mb-2 router:mt-0 router:text-xl router:text-text">Nothing here</h1>
        <p>
          No route matches <code className="router:break-all router:rounded router:border router:border-border router:bg-bg-subtle router:px-1">{params?.["path"] ?? current()}</code>.
        </p>
        <p>
          <a className="router:tap-h router:inline-flex router:items-center" href="#/">Go to the start page</a>
        </p>
      </div>
    ),
  });

  // Two listeners, one resolution path: `popstate` is back/forward and our own
  // `pushState` navigations' history entries, `hashchange` is everything that writes
  // `location.hash` directly (other plugins, the address bar, an external link).
  addEventListener("popstate", resolve);
  addEventListener("hashchange", resolve);
  // A route added after the first render must be able to claim the current URL.
  // `subscribe` fires at once, which is the first resolution.
  const stopRoutes = routes.subscribe(() => resolve());

  teardown = () => {
    removeEventListener("popstate", resolve);
    removeEventListener("hashchange", resolve);
    stopRoutes();
    removeView();
  };
}

export function deactivate(): void {
  teardown?.();
  teardown = undefined;
  applied = undefined;
}

/**
 * `router` — URL ↔ view (SPEC §6.5).
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
 * The router does not render views: it resolves a URL to a `main.view` id plus params
 * and tells the shell through its `shell` port (`lm/shell`, `setMainView` only). That
 * separation is what lets a command open a view without touching the URL, and a URL
 * open a view without a command.
 *
 * Routes arrive on the `routes` host in seat order; the most specific pattern wins and
 * seat order only breaks ties (`match.ts`).
 */

import type { Kernel } from "@kernel";

import type { MainView } from "@protocols/lm/main.view";
import type { Router, RouteMatch } from "@protocols/lm/router";
import type { Route } from "@protocols/lm/router.route";
import type { Shell } from "@protocols/lm/shell";

import { createLink } from "./Link.js";
import { buildPath, fullPath, matchRoutes, pathQuery } from "./match.js";

/** The view the router selects when nothing matches. Offered below. */
export const NOT_FOUND_VIEW = "router.notFound";

/**
 * The canonical document route, exported so `document-surface` registers exactly the
 * path `markdown`'s `doc://` links and every doc list build. One constant beats four
 * plugins hand-concatenating the same string slightly differently.
 */
export const DOCUMENT_ROUTE = "/doc/:id";

/** The service this plugin serves on its `router` port: `lm/router`. */
export type RouterApi = Router;

export default function activate(kernel: Kernel): RouterApi {
  const routes = kernel.ports.collect<Route>("routes");

  // Limited to `setMainView` by the port's `needs`: the router tells the shell what to
  // show and asks it nothing else.
  const shell = kernel.ports.use<Pick<Shell, "setMainView">>("shell");

  const listeners = new Set<(path: string) => void>();
  let applied: string | undefined;

  const current = (): string => fullPath(location.hash);
  const url = (path: string): string => `#${fullPath(path)}`;

  /**
   * Resolve the current URL, tell the shell, and notify subscribers once.
   *
   * The dedupe key is the path **and** query: a view addressed by a query
   * (`#/search?q=groceries`) matches the same route for every query, so comparing
   * paths alone would navigate the shell and tell nobody.
   */
  const resolve = (): void => {
    const path = current();
    const found = matchRoutes(routes.get(), path);
    if (found) shell.setMainView(found.view, found.params);
    else shell.setMainView(NOT_FOUND_VIEW, { path });

    if (path === applied) return;
    applied = path;
    for (const listener of [...listeners]) listener(path);
  };

  const navigate = (path: string, options?: { readonly replace?: boolean }): void => {
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
  };

  const api: RouterApi = {
    navigate,
    current,
    query: () => new URLSearchParams(pathQuery(location.hash)),
    match: (path): RouteMatch | undefined => {
      const found = matchRoutes(routes.get(), path);
      return found ? { view: found.view, params: found.params } : undefined;
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    href: (pattern, params) => buildPath(pattern, params),
    url,
    documentPath: (id) => buildPath(DOCUMENT_ROUTE, { id }),
    Link: createLink({ current, onChange: (l) => api.onChange(l), navigate, url }),
  };

  // Where the router puts a URL nobody claimed. It is an offered `main.view` like any
  // other, so a workspace that wants a prettier 404 replaces it by id.
  kernel.ports.offer<MainView>("not-found", {
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
  teardown = () => {
    removeEventListener("popstate", resolve);
    removeEventListener("hashchange", resolve);
  };
  // A route wired in after the first render must be able to claim the current URL.
  routes.subscribe(() => resolve());

  kernel.ports.serve("router", api);
  return api;
}

/** The window listeners `activate` added; the kernel withdraws everything else (§6c). */
let teardown: (() => void) | undefined;

export function deactivate(): void {
  teardown?.();
  teardown = undefined;
}

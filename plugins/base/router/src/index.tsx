import { createRegistry, s, type Kernel } from "@kernel";

import { addView, setMainView } from "plugin:shell-ui";

import type { Route, RouteMatch, Router } from "./api.js";
import { createLink } from "./Link.js";
import { buildPath, fullPath, matchRoutes, pathQuery } from "./match.js";

export type { LinkProps, Route, RouteMatch, Router } from "./api.js";

export type RouterApi = Router;

export const NOT_FOUND_VIEW = "router.notFound";

export const DOCUMENT_ROUTE = "/doc/:id";

const routes = createRegistry<Route>({
  key: (route) => route.path,
  order: (route) => route.order ?? 0,
  shape: s.object({ path: s.string(), view: s.string(), order: s.optional(s.number()) }),
});

export const addRoute: (items: Route | readonly Route[]) => () => void = routes.add;

const listeners = new Set<(path: string) => void>();
let applied: string | undefined;

export function current(): string {
  return fullPath(location.hash);
}

export function url(path: string): string {
  return `#${fullPath(path)}`;
}

function resolve(): void {
  const path = current();
  const found = matchRoutes(routes.get(), path);
  if (found) setMainView(found.view, found.params);
  else setMainView(NOT_FOUND_VIEW, { path });

  if (path === applied) return;
  applied = path;
  for (const listener of [...listeners]) listener(path);
}

export function navigate(path: string, options?: { readonly replace?: boolean }): void {
  const hash = url(path);
  try {
    const href = `${location.pathname}${location.search}${hash}`;
    if (options?.replace) history.replaceState(history.state, "", href);
    else history.pushState(null, "", href);
  } catch {
    location.hash = hash.slice(1);
  }
  resolve();
}

export function query(): URLSearchParams {
  return new URLSearchParams(pathQuery(location.hash));
}

export function match(path: string): RouteMatch | undefined {
  const found = matchRoutes(routes.get(), path);
  return found ? { view: found.view, params: found.params } : undefined;
}

export function onChange(listener: (path: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function href(pattern: string, params?: Readonly<Record<string, string>>): string {
  return buildPath(pattern, params);
}

export function documentPath(id: string): string {
  return buildPath(DOCUMENT_ROUTE, { id });
}

export const Link: Router["Link"] = createLink({ current, onChange, navigate, url });

let teardown: (() => void) | undefined;

export default function activate(_kernel: Kernel): void {
  teardown?.();

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

  addEventListener("popstate", resolve);
  addEventListener("hashchange", resolve);
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

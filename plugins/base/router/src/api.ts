/**
 * The types `router` exports (`plugin:router`): URL to view, hash-based.
 */

import type { ReactNode } from "react";

import type { Unsubscribe } from "@kernel";

/**
 * One route. `path` is a pattern with `:name` segments (`/doc/:id`); matches are passed to
 * the view as `params`. The more specific pattern matches first; `order`, then the order
 * routes were added, only breaks ties. A route added with the same `path` as an earlier
 * one replaces it.
 */
export interface Route {
  readonly path: string;
  /** The id of the view (`shell-ui`'s `addView`) to render. */
  readonly view: string;
  /** Low first, among equally specific patterns. Default `0`. */
  readonly order?: number;
}

export interface LinkProps {
  /** A concrete path (`/doc/01J…`), not a pattern. Build it with `href`. */
  readonly to: string;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly title?: string;
  /** Replace the current history entry instead of pushing one. */
  readonly replace?: boolean;
  /** Set `aria-current="page"` when `to` is the current path. Default `true`. */
  readonly current?: boolean;
  readonly onNavigate?: () => void;
}

export interface RouteMatch {
  readonly view: string;
  readonly params: Readonly<Record<string, string>>;
}

/** The navigation half of `plugin:router`'s exports, as one type (the old `ddd/router` service). */
export interface Router {
  /** Navigate, pushing history. `path` is concrete: `/doc/01J…`. */
  readonly navigate: (path: string, options?: { readonly replace?: boolean }) => void;
  /** The current path and query string, without the leading `#`. */
  readonly current: () => string;
  /** The current query string, parsed (`#/search?q=cake`). */
  readonly query: () => URLSearchParams;
  /** Resolve a path against the added routes. */
  readonly match: (path: string) => RouteMatch | undefined;
  readonly onChange: (listener: (path: string) => void) => Unsubscribe;
  /** Build a path from a pattern and params; never hand-concatenate one. */
  readonly href: (pattern: string, params?: Readonly<Record<string, string>>) => string;
  /** The `<a href>` form of a concrete path (`/doc/x` → `#/doc/x`). */
  readonly url: (path: string) => string;
  /** The canonical path for one document. */
  readonly documentPath: (id: string) => string;
  /** An anchor that navigates in-app and marks itself `aria-current="page"`. */
  readonly Link: (props: LinkProps) => ReactNode;
}

/**
 * lm/router@1.0.0: service, owned by `router`.
 *
 * URL to view, hash-based. Navigate, read the current path and query, build paths from
 * patterns, and render in-app links. Consumers name the members they use in `needs`: most
 * need only `navigate`.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ReactNode } from "react";
import type { Unsubscribe } from "@kernel";

/** The protocol this package describes. */
export type ProtocolId = "lm/router";
export type ProtocolVersion = "1.0.0";

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

export interface Router {
  /** Navigate, pushing history. `path` is concrete: `/doc/01J…`. */
  readonly navigate: (path: string, options?: { readonly replace?: boolean }) => void;
  /** The current path and query string, without the leading `#`. */
  readonly current: () => string;
  /** The current query string, parsed (`#/search?q=cake`). */
  readonly query: () => URLSearchParams;
  /** Resolve a path against the wired routes. */
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

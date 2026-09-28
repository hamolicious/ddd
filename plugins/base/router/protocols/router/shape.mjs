import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/router",
  version: "1.0.0",
  kind: "service",
  name: "Router",
  description: `
URL to view, hash-based. Navigate, read the current path and query, build paths from
patterns, and render in-app links. Consumers name the members they use in \`needs\`: most
need only \`navigate\`.`,
  imports: `import type { ReactNode } from "react";

import type { Unsubscribe } from "@kernel";`,
  declarations: `
export interface LinkProps {
  /** A concrete path (\`/doc/01J…\`), not a pattern. Build it with \`href\`. */
  readonly to: string;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly title?: string;
  /** Replace the current history entry instead of pushing one. */
  readonly replace?: boolean;
  /** Set \`aria-current="page"\` when \`to\` is the current path. Default \`true\`. */
  readonly current?: boolean;
  readonly onNavigate?: () => void;
}

export interface RouteMatch {
  readonly view: string;
  readonly params: Readonly<Record<string, string>>;
}`,
  shape: s.object({
    navigate: s
      .func()
      .as("(path: string, options?: { readonly replace?: boolean }) => void")
      .describe("Navigate, pushing history. `path` is concrete: `/doc/01J…`."),
    current: s.func().as("() => string").describe("The current path and query string, without the leading `#`."),
    query: s.func().as("() => URLSearchParams").describe("The current query string, parsed (`#/search?q=cake`)."),
    match: s.func().as("(path: string) => RouteMatch | undefined").describe("Resolve a path against the wired routes."),
    onChange: s.func().as("(listener: (path: string) => void) => Unsubscribe"),
    href: s
      .func()
      .as("(pattern: string, params?: Readonly<Record<string, string>>) => string")
      .describe("Build a path from a pattern and params; never hand-concatenate one."),
    url: s.func().as("(path: string) => string").describe("The `<a href>` form of a concrete path (`/doc/x` → `#/doc/x`)."),
    documentPath: s.func().as("(id: string) => string").describe("The canonical path for one document."),
    Link: s
      .component()
      .as("(props: LinkProps) => ReactNode")
      .describe("An anchor that navigates in-app and marks itself `aria-current=\"page\"`."),
  }),
};

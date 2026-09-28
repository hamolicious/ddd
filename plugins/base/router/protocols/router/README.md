# lm/router

`1.0.0` · service · owned by `router`

URL to view, hash-based. Navigate, read the current path and query, build paths from
patterns, and render in-app links. Consumers name the members they use in `needs`: most
need only `navigate`.

| Key | Type | Required | |
|---|---|---|---|
| `navigate` | `(path: string, options?: { readonly replace?: boolean }) => void` | yes | Navigate, pushing history. `path` is concrete: `/doc/01J…`. |
| `current` | `() => string` | yes | The current path and query string, without the leading `#`. |
| `query` | `() => URLSearchParams` | yes | The current query string, parsed (`#/search?q=cake`). |
| `match` | `(path: string) => RouteMatch \| undefined` | yes | Resolve a path against the wired routes. |
| `onChange` | `(listener: (path: string) => void) => Unsubscribe` | yes |  |
| `href` | `(pattern: string, params?: Readonly<Record<string, string>>) => string` | yes | Build a path from a pattern and params; never hand-concatenate one. |
| `url` | `(path: string) => string` | yes | The `<a href>` form of a concrete path (`/doc/x` → `#/doc/x`). |
| `documentPath` | `(id: string) => string` | yes | The canonical path for one document. |
| `Link` | `(props: LinkProps) => ReactNode` | yes | An anchor that navigates in-app and marks itself `aria-current="page"`. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

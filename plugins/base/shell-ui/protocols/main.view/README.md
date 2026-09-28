# lm/main.view

`1.0.0` · slot · owned by `shell-ui` · key `id`

A full-pane view, addressed by id. `lm/router.route` maps a URL to one of these, so a view
and its URL are provided independently: a view can be opened by the router, by a command, or
in a split.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `component` | `ComponentType<{ readonly params?: Readonly<Record<string, string>> }>` | yes |  |
| `title` | `string` |  | Shown in window and tab titles. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

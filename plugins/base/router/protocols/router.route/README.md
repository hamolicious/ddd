# lm/router.route

`1.0.0` · slot · owned by `router` · key `path`

One route. `path` is a pattern with `:name` segments (`/doc/:id`); matches are passed to the
view as `params`. Hash-based, so the app works from `file://` in the shell with no server
rewrites. The more specific pattern matches first; seat order only breaks ties.

| Key | Type | Required | |
|---|---|---|---|
| `path` | `string` | yes |  |
| `view` | `string` | yes | The `lm/main.view` id to render. |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

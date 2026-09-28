# lm/shell.overlay

`1.0.0` · slot · owned by `shell-ui` · key `id`

A component that is always mounted, outside the header, sidebar and main region: a command
palette, a toast stack, a sheet. The shell holds the only `kernel.ui.mount`, so this is how
a plugin gets a persistent React presence that is not part of the layout. It should render
nothing until it has something to show, and anything modal should portal or position itself.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `component` | `ComponentType<Record<string, never>>` | yes |  |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

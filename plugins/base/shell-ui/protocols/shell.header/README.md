# lm/shell.header

`1.0.0` · slot · owned by `shell-ui` · key `id`

The spot above the sidebar and main region. A host shows one: `shell-ui` hosts it with
`"seats": 1`, so a new connection takes the seat and benches the previous header. The
component owns its whole row, `<header>` included.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `component` | `ComponentType<Record<string, never>>` | yes |  |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

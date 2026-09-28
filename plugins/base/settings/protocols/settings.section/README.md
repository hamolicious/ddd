# lm/settings.section

`1.0.0` · slot · owned by `settings` · key `id`

One section of the settings screen. Sections appear in seat order.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `title` | `string` | yes |  |
| `component` | `ComponentType<Record<string, never>>` | yes |  |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |
| `description` | `string` |  |  |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

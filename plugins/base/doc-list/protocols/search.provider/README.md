# lm/search.provider

`1.0.0` · slot · owned by `doc-list` · key `id`

A search backend. The default is the local index; the server is a fallback, and a plugin may
add its own (a semantic index, an external wiki). Providers run in seat order.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `label` | `string` | yes |  |
| `order` | `number` |  | Default-seat hint only; the local index is 0. |
| `search` | `(query: string, options: { readonly limit?: number; readonly includeDeleted?: boolean }) => Promise<readonly SearchHit[]>` | yes |  |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

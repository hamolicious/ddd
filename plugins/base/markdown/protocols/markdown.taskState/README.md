# lm/markdown.taskState

`1.0.0` · slot · owned by `markdown` · key `marker`

A task marker. `[ ]` and `[x]` are markdown's own; a plugin may add `[/]`, `[-]`, `[?]`.
Marker meaning comes from the client, so a client without the providing plugin renders the
marker as literal text and can count tasks differently. States appear in the state menu in seat order.

| Key | Type | Required | |
|---|---|---|---|
| `marker` | `string` | yes | The single character inside the brackets; `" "` for unchecked. |
| `label` | `string` | yes |  |
| `icon` | `ReactNode` | yes |  |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |
| `done` | `boolean` |  | `true` ⇒ counts as completed. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

# lm/slash.command

`1.0.0` · slot · owned by `slash-commands` · key `id`

One entry in the `/` menu. Typing `/att` lists the commands whose title or keywords start with it.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `title` | `string` | yes |  |
| `description` | `string` |  |  |
| `icon` | `ReactNode` |  |  |
| `keywords` | `readonly (string)[]` |  | Other words it is found by. |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |
| `when` | `(context: { readonly documentId: DocumentId }) => boolean` |  | `false` ⇒ not offered in this document. |
| `run` | `(context: SlashCommandContext) => void` | yes | Called with the typed `/command` removed, inside the key press or tap that chose it. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

# lm/commands.command

`2.0.0` · slot · owned by `commands` · key `id`

A command: one id, one title, one function. The palette lists them; keybindings run them.
Two providers claiming one id: the lower seat wins and the other is reported.

A command with `takes: "documents"` acts on documents it is handed: its argument is the
ids, as `readonly string[]`. The document list's Actions button offers it for the
documents listed; the palette and keybindings, which have no documents to hand it, leave
it out.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `title` | `string` | yes |  |
| `run` | `(argument?: unknown) => void \| Promise<void>` | yes |  |
| `category` | `string` |  | Grouping in the palette. |
| `icon` | `string` |  | An icon's name in `lm/icons` (Tabler), drawn beside the title. |
| `takes` | `"documents"` |  | What the command acts on. `"documents"`: `run` gets `readonly string[]` of document ids. |
| `when` | `() => boolean` |  | Return `false` to hide the command in the current context. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

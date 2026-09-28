# lm/commands.command

`1.0.0` · slot · owned by `commands` · key `id`

A command: one id, one title, one function. The palette lists them; keybindings run them.
Two providers claiming one id: the lower seat wins and the other is reported.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `title` | `string` | yes |  |
| `run` | `(argument?: unknown) => void \| Promise<void>` | yes |  |
| `category` | `string` |  | Grouping in the palette. |
| `icon` | `ReactNode` |  |  |
| `when` | `() => boolean` |  | Return `false` to hide the command in the current context. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

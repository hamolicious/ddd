# lm/keybindings.default

`1.0.0` · slot · owned by `commands` · key `keys|command`

A suggested default binding. The user's own configuration wins; between providers, the lower
seat wins and conflicts are listed rather than silently resolved. `keys` is a chord in the
canonical spelling: `Mod+K` (`Mod` is Cmd on Apple, Ctrl elsewhere), `Shift+Alt+F`, or a
sequence like `g d`.

| Key | Type | Required | |
|---|---|---|---|
| `command` | `string` | yes |  |
| `keys` | `string` | yes |  |
| `when` | `string` |  |  |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

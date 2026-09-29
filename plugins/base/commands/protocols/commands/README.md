# lm/commands

`1.0.0` · service · owned by `commands`

The command registry, for plugins that run commands rather than offer them: a list to
build a menu from, and a way to run one by id. `when()` is honoured by both.

| Key | Type | Required | |
|---|---|---|---|
| `list` | `() => readonly Command[]` | yes | Every command enabled right now, in seat order. |
| `run` | `(id: string, argument?: unknown) => Promise<void>` | yes | Run a command by id. Rejects for an unknown id; does nothing when its `when()` says no. |
| `openPalette` | `(initialQuery?: string) => void` | yes |  |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

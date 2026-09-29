# lm/folders.decoration

`2.0.0` · slot · owned by `folders` · key `id`

Dresses note rows in the folder tree: a background, a text colour, an icon, in any
combination. The icon and the name are drawn together in a pill that takes `background`.
The tree asks `decorate` for every note it draws, by id, and redraws when `onChange`
fires. With several providers, each field comes from the first one in seat order that sets
it.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `decorate` | `(id: string) => FolderLook \| undefined` | yes | Called on every render of every row, with the note's id: answer from memory, never await. |
| `onChange` | `(listener: () => void) => Unsubscribe` | yes | Fires when any answer `decorate` gives may have changed. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

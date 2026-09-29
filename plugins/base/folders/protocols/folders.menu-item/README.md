# lm/folders.menu-item

`2.0.0` · slot · owned by `folders` · key `id`

An entry in a note's actions menu in the folder tree (the ⋯ button, right-click, long press),
listed after the tree's own entries and before "Delete", in seat order. `run` is called once
the menu has closed, so it may open a menu or sheet of its own.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `label` | `string` | yes |  |
| `hint` | `string` |  | A second, quieter line under the label. |
| `when` | `(id: string) => boolean` |  | Return `false` to leave the entry out for this note. |
| `run` | `(id: string, anchor?: HTMLElement) => void` | yes | `id` is the note's; `anchor` is the control that opened the menu, when there was one. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

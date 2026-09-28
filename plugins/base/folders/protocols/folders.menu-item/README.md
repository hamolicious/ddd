# lm/folders.menu-item

`1.0.0` · slot · owned by `folders` · key `id`

An entry in a folder's actions menu (the ⋯ button, right-click, long press), listed after the
tree's own entries and before "Delete folder", in seat order. `run` is called once the menu
has closed, so it may open a menu or sheet of its own.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `label` | `string` | yes |  |
| `hint` | `string` |  | A second, quieter line under the label. |
| `when` | `(path: string) => boolean` |  | Return `false` to leave the entry out for this folder. |
| `run` | `(path: string, anchor?: HTMLElement) => void` | yes | `path` is the folder's; `anchor` is the control that opened the menu, when there was one. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

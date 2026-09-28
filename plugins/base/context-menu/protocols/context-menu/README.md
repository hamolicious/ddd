# lm/context-menu

`1.0.0` · service · owned by `context-menu`

Menus, sheets and questions. One menu is open at a time; opening another replaces it. With an
`anchor` it is a popover beside that control on a wide screen; on a phone, or with no anchor,
it is a bottom sheet. Focus moves in on open, Escape and a click outside close it, and focus
returns to whatever opened it. `modal` and `confirm` ask a question instead: a centred
dialog (a bottom sheet on a phone) that resolves with the answer.

| Key | Type | Required | |
|---|---|---|---|
| `open` | `(menu: MenuRequest) => void` | yes |  |
| `openSheet` | `(sheet: SheetRequest) => void` | yes |  |
| `modal` | `(request: ModalRequest) => Promise<ModalResult \| undefined>` | yes | Ask something: resolves with the button and field values, or `undefined` when dismissed. |
| `confirm` | `(request: ConfirmRequest) => Promise<boolean>` | yes | "Are you sure?": resolves `true` only when the confirm button is chosen. |
| `close` | `() => void` | yes |  |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

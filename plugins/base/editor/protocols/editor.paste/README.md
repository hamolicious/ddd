# lm/editor.paste

`1.0.0` · slot · owned by `editor` · key `id`

A paste and drop handler. The editor asks each one in seat order when something is pasted or
dropped onto it, and the first to return `true` takes it. `paste` must answer synchronously,
since the browser's paste or drop is cancelled in the same tick; slow work (an upload) starts
here and finishes later through the `EditorInsertion` it got from `insert`.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |
| `paste` | `(event: EditorPasteEvent) => boolean` | yes |  |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

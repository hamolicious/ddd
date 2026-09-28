# lm/editor.extension

`1.0.0` · slot · owned by `editor` · key `id`

A CodeMirror 6 extension. This is the protocol that pins the runtime layer: the value is a
`@codemirror/state` `Extension` from the shared copy, so replacing the editor means another
CodeMirror-based editor. A plugin that adds markdown syntax should pair its renderer with an
extension here, or the syntax is invisible while editing.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `extension` | `Extension` | yes |  |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

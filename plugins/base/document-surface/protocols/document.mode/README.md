# lm/document.mode

`1.0.0` · slot · owned by `document-surface` · key `id`

A way of showing one document. Read and Edit are symmetric providers: the surface owns the
route and the modes, and has no built-in favourite. Modes are offered in seat order, and the
first one whose `when` accepts the document is the default.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `label` | `string` | yes |  |
| `component` | `ComponentType<DocumentModeProps>` | yes |  |
| `icon` | `ReactNode` |  |  |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |
| `when` | `(row: DocumentRow) => boolean` |  | Whether the mode applies to this document; asked again whenever the row changes. Absent: every document. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

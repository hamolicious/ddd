# lm/document-browser.created

`1.0.0` · event · owned by `doc-list`

A document was just created through `lm/document-browser` on this device. Sent once, after
the create went through and before it opens.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `parent` | `string` |  | The caller's `parent` hint, when it gave one. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

# lm/markdown.attachment

`1.0.0` · slot · owned by `markdown` · key `id`

What an embedded file (`![name](attachment://<ulid>)`) renders as. The first seat wins; with
none wired, markdown draws its own inline image or chip. Also what the viewer shows for a
wrapper document, with `placement: "page"`.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `component` | `ComponentType<MarkdownAttachmentProps>` | yes |  |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

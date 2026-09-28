# lm/attachments.viewer

`1.0.0` · slot · owned by `attachments` · key `id`

A way of showing files of some types, by extension. Several viewers may claim one extension:
the first seat shows it unless the user picked another in Settings, Attachments.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `label` | `string` | yes | Shown in Settings when viewers compete for a type. |
| `extensions` | `readonly (string)[]` | yes | Lower case, no dot: `["png", "jpg"]`. |
| `component` | `ComponentType<AttachmentViewerProps>` | yes |  |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

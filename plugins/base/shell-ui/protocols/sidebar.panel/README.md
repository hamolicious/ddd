# lm/sidebar.panel

`1.0.0` · slot · owned by `shell-ui` · key `id`

A panel in the sidebar (folders, the document list, an outline). Collapsible. Panels appear
top to bottom in seat order.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `title` | `string` | yes |  |
| `component` | `ComponentType<Record<string, never>>` | yes |  |
| `icon` | `ReactNode` |  |  |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |
| `defaultOpen` | `boolean` |  | `true` ⇒ the panel starts open on first run. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

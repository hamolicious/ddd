# lm/altbar.panel

`1.0.0` · slot · owned by `shell-ui` · key `id`

A panel in the altbar: the column opposite the sidebar, about whatever the main view is
showing (a document's history, the neighbourhood graph). The shell draws the ones whose
`when` accepts the current view; with none, the altbar and its toggle are absent.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `title` | `string` | yes |  |
| `component` | `ComponentType<{ readonly view: ShownView }>` | yes |  |
| `icon` | `ReactNode` |  |  |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |
| `defaultOpen` | `boolean` |  | `true` ⇒ the panel starts expanded on first run. Default `true`. |
| `when` | `(view: ShownView) => boolean` |  | Whether this panel has anything to say about `view`. Default: every view. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

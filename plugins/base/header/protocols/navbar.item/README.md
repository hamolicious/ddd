# lm/navbar.item

`1.0.0` · slot · owned by `header` · key `id`

One item in the top bar, placed in one of the header's two sides. `component` renders it;
`onSelect` is the shorthand for the common case, a button that runs a command.

A provider's items appear in its seat's order; the header's own "Top bar" setting lets each
person rearrange them on top of that.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `label` | `string` | yes |  |
| `icon` | `ReactNode` |  | Any renderable node: an inline SVG, a character, a component's output. |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |
| `side` | `"start" \| "end"` |  | `start` sits after the sidebar toggle and grows, scrolling sideways when full; `end` is pushed right and never shrinks. Default `start`. |
| `onSelect` | `() => void` |  |  |
| `component` | `ComponentType<Record<string, never>>` |  | Takes over rendering entirely (the notice bell, the sync pill). |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

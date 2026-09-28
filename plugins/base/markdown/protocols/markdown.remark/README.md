# lm/markdown.remark

`1.0.0` · slot · owned by `markdown` · key `id`

A raw remark/unified plugin: the escalated path. It can change the meaning of the whole
document, so it is the last resort, not the first. Plugins run in seat order.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `plugin` | `unknown` | yes | A unified `Pluggable`, typed loosely so the protocol does not pin unified's types. |
| `options` | `unknown` |  |  |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

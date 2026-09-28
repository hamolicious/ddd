# lm/markdown.codeBlock

`1.0.0` · slot · owned by `markdown` · key `id`

The renderer for a fenced code block no `lm/markdown.fence` claims: ```rust, ```ts, or a
fence with no language. The first seat wins; with none wired, markdown draws its own `<pre>`.
A fence for the block's language always goes first: this is the default for code, not an
override of fences.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `component` | `ComponentType<MarkdownCodeBlockProps>` | yes |  |
| `order` | `number` |  | Default-seat hint only; the wiring's seat order wins. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

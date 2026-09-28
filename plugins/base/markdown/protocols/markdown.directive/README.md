# lm/markdown.directive

`1.0.0` · slot · owned by `markdown` · key `kind|name`

A directive: `:::name` (container), `::name` (leaf), `:name[text]{attrs}` (inline).
Directives and fences are the blessed syntaxes: named, collision-free, and they degrade to
literal text when the plugin is absent.

| Key | Type | Required | |
|---|---|---|---|
| `name` | `string` | yes |  |
| `kind` | `"container" \| "leaf" \| "text"` | yes |  |
| `component` | `ComponentType<MarkdownDirectiveProps>` | yes |  |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

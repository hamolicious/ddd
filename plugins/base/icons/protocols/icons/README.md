# lm/icons

`1.0.0` · service · owned by `icons`

An icon set, by name: something to draw one with and something to let a person choose one.
Icons are line drawings in `currentColor`, so they take the colour of the text around them.
A name is stable across versions of the set; one the set does not have draws nothing.

The drawings download on first use, a few at a time, so `Icon` can render empty for a
moment on a cold start.

| Key | Type | Required | |
|---|---|---|---|
| `Icon` | `ComponentType<IconProps>` | yes |  |
| `Picker` | `ComponentType<IconPickerProps>` | yes | A search box over a scrolling grid of every icon that matches. |
| `search` | `(query: string, limit?: number) => Promise<readonly IconInfo[]>` | yes | Best matches first, by name, then tags. An empty query is every icon, a suggested few first. |
| `has` | `(name: string) => Promise<boolean>` | yes |  |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

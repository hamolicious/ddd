# lm/themes.theme

`1.0.0` · slot · owned by `themes` · key `id`

A theme: token overrides on top of the kernel defaults. `themes` overrides the palette, it
does not own it, so a theme need only name the tokens it changes and everything else stays
legible.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes |  |
| `name` | `string` | yes |  |
| `scheme` | `"light" \| "dark"` | yes |  |
| `tokens` | `Readonly<Record<string, string>>` | yes | Partial `ThemeTokens`: token name → CSS value. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

# lm/syntax.language

`1.0.0` · slot · owned by `syntax-highlight` · key `id`

A tree-sitter grammar code blocks can be highlighted with. Offered in Settings, Code
languages; nothing is downloaded until the user installs it. The URLs must be same-origin: a
plugin serves its grammars from its own `frontend/` directory. The grammar must be built for
the ABI of the `web-tree-sitter` that `syntax-highlight` bundles.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes | Canonical name, lowercase: `rust`, `typescript`. |
| `name` | `string` | yes | Display name: `Rust`, `TypeScript`. |
| `aliases` | `readonly (string)[]` |  | Other info strings that mean this language: `rs`, `ts`. |
| `wasmUrl` | `string` | yes |  |
| `highlightsUrl` | `string` | yes | A tree-sitter `highlights.scm` query. |
| `size` | `number` |  | Download size in bytes, shown before installing. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

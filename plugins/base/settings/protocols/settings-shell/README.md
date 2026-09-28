# lm/settings-shell

`1.0.0` · service · owned by `settings`

The settings screen: open it at a section, and list the sections wired into it.

| Key | Type | Required | |
|---|---|---|---|
| `open` | `(sectionId?: string) => void` | yes |  |
| `sections` | `() => readonly SettingsSection[]` | yes |  |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

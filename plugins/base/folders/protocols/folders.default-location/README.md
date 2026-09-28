# lm/folders.default-location

`1.0.0` · event · owned by `folders` · sticky

Where new notes go when the caller names no folder. Sent at activation and on every change,
here or on another device. Sticky: a listener that starts or restarts later still hears the
current value at once. An explicit location, like "New document here" in the tree, always
beats it.

| Key | Type | Required | |
|---|---|---|---|
| `path` | `string` | yes | A folder path, `""` for the root. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

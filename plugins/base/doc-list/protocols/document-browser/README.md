# lm/document-browser

`1.0.0` · service · owned by `doc-list`

Creating documents from anywhere in the app, and the list of ids currently shown.

| Key | Type | Required | |
|---|---|---|---|
| `createDocument` | `(options?: NewDocumentOptions) => Promise<string>` | yes | Create an empty document and navigate to it. Rejects when the server cannot be reached. |
| `newDocument` | `(options?: NewDocumentOptions) => void` | yes | The same, for UI entry points: never rejects, and reports a failure as a notice with a retry. |
| `visible` | `() => readonly string[]` | yes | The ids currently shown, for "select all" style commands. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

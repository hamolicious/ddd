# lm/workspace-index

`1.0.0` · service · owned by `indexer`

Indexes over the local projection, kept current on every change: a keystroke on this device
or a change arriving from the feed. Nothing is written anywhere; every client builds its own,
offline included.

Trashed documents are counted in `stats().documents.trashed` and nowhere else. Every
frontmatter field of every live document is indexed, machine-owned ones included, and keys
nested in a map are dotted paths (`project.status`). Content stats are for human documents
unless `includeMachine`. Every read is synchronous and answers from the current index;
before `ready` resolves that is an empty workspace.

| Key | Type | Required | |
|---|---|---|---|
| `ready` | `Promise<void>` | yes | Resolves after the first full build; rejects if the projection could not be read. |
| `version` | `number` | yes | Goes up by one each time any index changes. |
| `stats` | `(scope?: IndexScope) => WorkspaceStats` | yes |  |
| `fmFields` | `(scope?: FieldScope) => readonly FmField[]` | yes | Every frontmatter key in use, nested keys included; most-used first. |
| `fmValues` | `(key: string, scope?: FieldScope) => readonly FmValueCount[]` | yes | The values one key holds, most-used first. |
| `documents` | `(scope?: IndexScope) => readonly IndexedDocument[]` | yes | Every live document, by title; machine-owned ones only with `includeMachine`. |
| `connections` | `(id: DocumentId) => NoteConnections` | yes | Outgoing and incoming connections of one document. An unknown id has none. |
| `subscribe` | `(listener: () => void) => Unsubscribe` | yes | Called after every change to any index. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

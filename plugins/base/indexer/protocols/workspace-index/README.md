# lm/workspace-index

`1.0.0` · service · owned by `indexer`

Indexes over the local projection, kept current on every change: a keystroke on this device
(once the kernel's local row catches up, about 250 ms later) or a change arriving from the
feed. Nothing is written anywhere; every client builds its own, offline included.

Trashed documents are counted in `stats().documents.trashed` and nowhere else: they have no
fields, no words and no connections. Every frontmatter field of every live document is
indexed, machine-owned ones (`machine: true`) included. Keys nested in a map
are dotted paths (`project.status`), the spelling the filter language uses
(`fm.project.status`), and the parent key is listed too, with kind `map`. To offer only what
a person typed, filter on `machineOnly`.

Content stats are for human documents unless `includeMachine`, but links from machine-owned
documents always count: a link is a link. Every read is synchronous and answers from the
current index; before `ready` resolves that is an empty workspace, so await it when an empty
answer would be wrong.

| Key | Type | Required | |
|---|---|---|---|
| `ready` | `Promise<void>` | yes | Resolves after the first full build; rejects if the projection could not be read. |
| `version` | `number` | yes | Goes up by one each time any index changes. |
| `stats` | `(scope?: IndexScope) => WorkspaceStats` | yes | Content stats are for human documents unless `includeMachine`; `documents` always counts both. |
| `fmFields` | `(scope?: FieldScope) => readonly FmField[]` | yes | Every frontmatter key in use in any live document, nested keys included; most-used first. |
| `fmValues` | `(key: string, scope?: FieldScope) => readonly FmValueCount[]` | yes | The values one key (dotted for a nested one) holds, most-used first. |
| `documents` | `(scope?: IndexScope) => readonly IndexedDocument[]` | yes | Every live document, by title; machine-owned ones only with `includeMachine`. |
| `connections` | `(id: DocumentId) => NoteConnections` | yes | Outgoing and incoming connections of one document. An unknown id has none. |
| `subscribe` | `(listener: () => void) => Unsubscribe` | yes | Called after every change to any index. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

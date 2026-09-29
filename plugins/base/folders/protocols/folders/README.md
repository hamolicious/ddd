# lm/folders

`1.2.0` · service · owned by `folders`

Where a note sits in the folder tree. A folder is a note: its children are listed in its own
`%%% folders` section, which only `folders` writes, so other plugins file notes through
this service. A note has at most one parent; `""` is the root.

It also says how a note is dressed — the colour and icon other plugins give it in the tree
(`lm/folders.decoration`) — so a link to the note elsewhere can wear the same.

| Key | Type | Required | |
|---|---|---|---|
| `parentOf` | `(id: string) => string \| undefined` | yes | The note's parent id, `""` at the root, `undefined` for a note the tree does not know. |
| `file` | `(id: string, parent: string, index?: number) => Promise<void>` | yes | Put the note under `parent` (`""` for the root), before the child at `index` or last. Rejects a parent inside the note itself. |
| `fileNew` | `(id: string, kind: "note" \| "file") => Promise<void>` | yes | File a document just created where the person asked new ones of that kind to go ("New notes go to", "Files go to"). Does nothing when that is the root. |
| `look` | `(id: string) => NoteLook \| undefined` | yes | The note's colour and icon, as the tree draws them. Since 1.2.0. |
| `onLookChange` | `(listener: () => void) => Unsubscribe` | yes | Fires when any answer `look` gives may have changed. Since 1.2.0. |
| `ensurePath` | `(titles: readonly string[]) => Promise<string>` | yes | The id of the note at that chain of titles from the root, creating the missing ones (without opening them). `[]` is the root, `""`. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

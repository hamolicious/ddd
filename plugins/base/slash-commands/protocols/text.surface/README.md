# lm/text.surface

`1.0.0` · slot · owned by `slash-commands` · key `id`

An editor, as anything that works at the caret sees it: the `/` menu, frontmatter
autocomplete. Editor-neutral on purpose: CodeMirror and a plain textarea both provide one
while mounted and withdraw it on unmount. One provider can feed several hosts.

| Key | Type | Required | |
|---|---|---|---|
| `id` | `string` | yes | Unique per mounted editor. |
| `documentId` | `DocumentId` | yes |  |
| `element` | `HTMLElement` | yes | Where keys arrive. Capture-phase listeners here run before the editor's. |
| `hasFocus` | `() => boolean` | yes |  |
| `focus` | `() => void` | yes |  |
| `textBeforeCaret` | `() => string` | yes | The caret's line, from its start up to the caret. |
| `caretRect` | `() => { readonly left: number; readonly top: number; readonly bottom: number } \| null` | yes | The caret on screen, for placing a popup; `null` when it is not visible. |
| `takeBeforeCaret` | `(length: number) => TextMark` | yes | Delete `length` characters before the caret, and mark the spot they were in. |
| `subscribe` | `(listener: () => void) => () => void` | yes | Fires after every change to the text, the caret or focus. |
| `documentBeforeCaret` | `() => string` |  | The whole text up to the caret: what tells autocomplete the caret is in the frontmatter. A surface without it still gets the `/` menu, and no autocomplete. |
| `replaceBeforeCaret` | `(length: number, text: string) => void` |  | Replace `length` characters before the caret, never past the line start, with `text`, leaving the caret after it: choosing a suggestion. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

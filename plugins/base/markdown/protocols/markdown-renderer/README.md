# lm/markdown-renderer

`1.0.0` · service · owned by `markdown`

The unified/remark to React pipeline: render a document's body, and the pieces around it.

| Key | Type | Required | |
|---|---|---|---|
| `render` | `(text: string, options?: { readonly documentId?: string; readonly offset?: number }) => ReactNode` | yes | Render a body to React. `offset` is where `text[0]` sits in the document, for task clicks. |
| `bodyOf` | `(text: string) => string` | yes | Strip the frontmatter and the `%%%` sections: what read mode shows. |
| `regions` | `(text: string) => DocumentRegions` | yes |  |
| `taskStates` | `() => readonly MarkdownTaskState[]` | yes | The task states wired in, in menu order. |
| `renderAttachment` | `(attachmentId: string, options: RenderAttachmentOptions) => ReactNode \| undefined` | yes | An attachment as the winning renderer draws it, or `undefined` when none is wired. |
| `promoteToDocument` | `(attachmentId: string, options?: { readonly path?: string }) => Promise<string>` | yes | Turn an embedded `attachment://` into a wrapper document. |
| `onChange` | `(listener: () => void) => Unsubscribe` | yes | Fires when a markdown contribution changes, so a cached render can re-render. |

Types: `index.d.ts`. GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.

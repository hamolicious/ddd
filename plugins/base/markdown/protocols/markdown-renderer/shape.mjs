import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/markdown-renderer",
  version: "2.1.0",
  kind: "service",
  name: "MarkdownRenderer",
  description: "The unified/remark to React pipeline: render a document's body, and the pieces around it.",
  imports: `import type { ReactNode } from "react";

import type { Unsubscribe } from "@kernel";

import type { MarkdownTaskState } from "@protocols/lm/markdown.taskState";`,
  declarations: `
export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/** Offsets of the three regions of one document text. */
export interface DocumentRegions {
  /** The frontmatter block including both \`---\` lines and the closing newline. */
  readonly frontmatter: TextSpan | null;
  /** The whole trailing \`%%%\` run. */
  readonly sections: TextSpan | null;
  /** What read mode renders: after the frontmatter, before the run. */
  readonly body: TextSpan;
}

export interface RenderAttachmentOptions {
  readonly placement: "inline" | "page";
  readonly alt?: string;
  readonly fallback: ReactNode;
}`,
  shape: s.object({
    render: s
      .func()
      .as("(text: string, options?: { readonly documentId?: string; readonly offset?: number }) => ReactNode")
      .describe("Render a body to React. `offset` is where `text[0]` sits in the document, for task clicks."),
    bodyOf: s.func().as("(text: string) => string").describe("Strip the frontmatter and the `%%%` sections: what read mode shows."),
    regions: s.func().as("(text: string) => DocumentRegions"),
    taskStates: s.func().as("() => readonly MarkdownTaskState[]").describe("The task states wired in, in menu order."),
    renderAttachment: s
      .func()
      .as("(attachmentId: string, options: RenderAttachmentOptions) => ReactNode | undefined")
      .describe("An attachment as the winning renderer draws it, or `undefined` when none is wired."),
    promoteToDocument: s
      .func()
      .as("(attachmentId: string) => Promise<string>")
      .describe("Turn an embedded `attachment://` into a wrapper document, filed where \"Files go to\" says when `folders` is wired."),
    renderDocLink: s
      .func()
      .as("(documentId: string) => ReactNode")
      .describe("A link to a document as the body draws `[](doc://…)`: its live title, colour and icon; a click opens it. Since 2.1.0."),
    onChange: s
      .func()
      .as("(listener: () => void) => Unsubscribe")
      .describe("Fires when a markdown contribution changes, so a cached render can re-render."),
  }),
};

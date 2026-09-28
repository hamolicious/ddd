/**
 * `source-view` — a third way of showing a document, and the proof of two properties of
 * `document.mode` (SPEC §6.5):
 *
 * - **Any number of modes.** The surface has no idea there are "read and edit"; this is
 *   a third contribution, and the header's icon switch and the phone's floating button
 *   make room for it without being told.
 * - **A mode decides where it applies.** `when` is this plugin's own rule: the source is
 *   only worth a mode on a document that has something Read mode hides — a frontmatter
 *   block or a `%%%` machine section. On a plain note it is not offered at all, and it
 *   appears the moment the document grows a frontmatter block.
 *
 * Read-only on purpose: it renders `row.content` and never touches the replica, so it
 * needs no hydration and cannot write.
 */

import type { ReactElement } from "react";

import type { Kernel } from "@kernel";
/*
 * The protocol's types, as a third party gets them: the generated `index.d.ts` the server
 * serves at `/protocols/lm/document.mode/1.0.0/index.d.ts` (see `alt-editor`).
 */
import type { DocumentMode, DocumentModeProps } from "@protocols/lm/document.mode";

/** A frontmatter block at the top, or a `%%%` fence opening a machine section anywhere. */
export function hasHiddenParts(content: string): boolean {
  return /^---\r?\n/.test(content) || /(^|\n)%%%[^\n]*\n/.test(content);
}

export default function activate(kernel: Kernel): void {
  // On the `mode` port: the manifest wires it to `document-surface`'s host.
  kernel.ports.offer<DocumentMode>("mode", {
    id: "source",
    label: "Source",
    order: 30,
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
      </svg>
    ),
    // `content` is optional on a row the projection has not materialized yet: no text, no mode.
    when: (row) => hasHiddenParts(row.content ?? ""),
    component: Source,
  });
}

function Source({ row }: DocumentModeProps): ReactElement {
  return (
    <pre
      className="source-view sourceview:m-0 sourceview:flex-1 sourceview:overflow-auto sourceview:whitespace-pre-wrap sourceview:break-words sourceview:p-4 sourceview:font-mono sourceview:text-[0.9rem] sourceview:leading-normal sourceview:text-text"
      data-testid="source-view"
    >
      {row.content}
    </pre>
  );
}

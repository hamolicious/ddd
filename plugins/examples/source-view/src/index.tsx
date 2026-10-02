import type { ReactElement } from "react";

import { addMode, type DocumentModeProps } from "plugin:document-surface";

export function hasHiddenParts(content: string): boolean {
  return /^---\r?\n/.test(content) || /(^|\n)%%%[^\n]*\n/.test(content);
}

export default function activate(): void {
  addMode({
    id: "source",
    label: "Source",
    order: 30,
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 7l-5 5 5 5M16 7l5 5-5 5" />
      </svg>
    ),
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

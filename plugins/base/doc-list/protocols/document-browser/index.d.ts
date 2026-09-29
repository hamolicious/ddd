/**
 * lm/document-browser@2.0.0: service, owned by `doc-list`.
 *
 * Creating documents from anywhere in the app, and the list of ids currently shown.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

/** The protocol this package describes. */
export type ProtocolId = "lm/document-browser";
export type ProtocolVersion = "2.0.0";

export interface NewDocumentOptions {
  /**
   * Where the new document belongs, as a hint for whoever files documents (`folders`
   * files it under this note). Passed through on `lm/document-browser.created`.
   */
  readonly parent?: string;
  readonly title?: string;
}

export interface DocumentBrowser {
  /** Create an empty document and navigate to it. Rejects when the server cannot be reached. */
  readonly createDocument: (options?: NewDocumentOptions) => Promise<string>;
  /** The same, for UI entry points: never rejects, and reports a failure as a notice with a retry. */
  readonly newDocument: (options?: NewDocumentOptions) => void;
  /** The ids currently shown, for "select all" style commands. */
  readonly visible: () => readonly string[];
}

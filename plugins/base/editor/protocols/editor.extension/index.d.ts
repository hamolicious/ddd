/**
 * lm/editor.extension@1.0.0: slot, owned by `editor`.
 *
 * A CodeMirror 6 extension. This is the protocol that pins the runtime layer: the value is
 * a `@codemirror/state` `Extension` from the shared copy, so replacing the editor means
 * another CodeMirror-based editor. A plugin that adds markdown syntax should pair its
 * renderer with an extension here, or the syntax is invisible while editing.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { Extension } from "@codemirror/state";

/** The protocol this package describes. */
export type ProtocolId = "lm/editor.extension";
export type ProtocolVersion = "1.0.0";

export interface EditorExtension {
  readonly id: string;
  readonly extension: Extension;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
}

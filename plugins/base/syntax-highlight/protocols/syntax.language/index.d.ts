/**
 * lm/syntax.language@1.0.0: slot, owned by `syntax-highlight`.
 *
 * A tree-sitter grammar code blocks can be highlighted with. Offered in Settings, Code
 * languages; nothing is downloaded until the user installs it. The URLs must be
 * same-origin: a plugin serves its grammars from its own `frontend/` directory. The
 * grammar must be built for the ABI of the `web-tree-sitter` that `syntax-highlight`
 * bundles.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

/** The protocol this package describes. */
export type ProtocolId = "lm/syntax.language";
export type ProtocolVersion = "1.0.0";

export interface SyntaxLanguage {
  /** Canonical name, lowercase: `rust`, `typescript`. */
  readonly id: string;
  /** Display name: `Rust`, `TypeScript`. */
  readonly name: string;
  /** Other info strings that mean this language: `rs`, `ts`. */
  readonly aliases?: readonly (string)[];
  readonly wasmUrl: string;
  /** A tree-sitter `highlights.scm` query. */
  readonly highlightsUrl: string;
  /** Download size in bytes, shown before installing. */
  readonly size?: number;
}

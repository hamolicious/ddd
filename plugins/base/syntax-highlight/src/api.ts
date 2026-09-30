/**
 * What other plugins write against: the language type and the registry `addLanguage`
 * fills. The item shape is checked when a language is added, so a malformed one fails in
 * the adding plugin's `activate`.
 */

import { createRegistry, s } from "@kernel";

import type { CustomLanguage, CustomUpload } from "./custom.js";
import type { LoadState, Span } from "./engine.js";

/**
 * A tree-sitter grammar code blocks can be highlighted with. Offered in Settings, Code
 * languages; nothing is downloaded until the user installs it, and an installed language
 * is fetched once per device. The URLs must be same-origin: a plugin serves its grammars
 * from its own `frontend/` directory and builds the URLs from `import.meta.url`. The
 * grammar must be built for the ABI of the `web-tree-sitter` that `syntax-highlight`
 * bundles.
 */
export interface SyntaxLanguage {
  /** Canonical name, lowercase: `rust`, `typescript`. */
  readonly id: string;
  /** Display name: `Rust`, `TypeScript`. */
  readonly name: string;
  /** Other info strings that mean this language, lowercase: `rs`, `ts`. */
  readonly aliases?: readonly string[];
  readonly wasmUrl: string;
  /** A tree-sitter `highlights.scm` query. */
  readonly highlightsUrl: string;
  /** Download size in bytes, shown before installing. */
  readonly size?: number;
}

/** What the code block, the editor extension and the settings page work through. */
export interface SyntaxApi {
  /** Every language on offer, installed or not. */
  languages(): readonly SyntaxLanguage[];
  /** The language an info string (`ts`, `Rust`, `rust {1}`) means, if any is on offer. */
  resolve(infoString: string | undefined): SyntaxLanguage | undefined;
  isInstalled(id: string): boolean;
  /** Mark installed for this user and fetch it here. Rejects when it cannot be fetched. */
  install(id: string): Promise<void>;
  /** Unmark it, and drop its files from this device's cache. */
  remove(id: string): Promise<void>;
  state(id: string): LoadState | undefined;
  /** Start fetching an installed language, unless it already is; `retry` after a failure. */
  ensureLoaded(id: string, retry?: boolean): void;
  /** Spans for `code` in `language` (an id or alias), or `undefined` while it is not ready. */
  highlight(code: string, language: string): readonly Span[] | undefined;
  /** The languages this user uploaded themselves. */
  custom(): readonly CustomLanguage[];
  /**
   * Check an uploaded grammar and query in this browser, store them as attachments, and
   * install the language. Rejects with a message fit to show.
   */
  addCustom(upload: CustomUpload): Promise<void>;
  /** Uninstall and forget an uploaded language, deleting its files. */
  removeCustom(id: string): Promise<void>;
  /** Something changed: a grammar loaded, the installed set, the catalog. */
  subscribe(listener: () => void): () => void;
  /** Bumps on every such change, for `useSyncExternalStore`. */
  revision(): number;
}

/** Every language on offer, in the order added. The same `id` replaces the earlier one. */
export const languageRegistry = createRegistry<SyntaxLanguage>({
  key: (language) => language.id,
  shape: s.object({
    id: s.string(),
    name: s.string(),
    aliases: s.optional(s.array(s.string())),
    wasmUrl: s.string(),
    highlightsUrl: s.string(),
    size: s.optional(s.number()),
  }),
});

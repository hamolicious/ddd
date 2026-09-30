/**
 * `kernel.core` — the shared Rust core, exposed to plugins.
 *
 * Thin by design: every method is one Wasm call, and the reason it exists at all
 * is to make a TypeScript re-implementation of the parser unnecessary (SPEC §2).
 */

import type { CoreApi, ParsedText } from "@kernel";

import type { CoreBindings } from "../wasm/index.js";

export class CoreHost implements CoreApi {
  constructor(private readonly bindings: CoreBindings) {}

  parseDocument(text: string): ParsedText {
    return this.bindings.parseDocument(text);
  }

  resolveTitle(text: string): string {
    return this.bindings.resolveTitle(text);
  }

  normalizeDate(input: string): string {
    return this.bindings.normalizeDate(input);
  }

  semanticsVersion(): number {
    return this.bindings.semanticsVersion();
  }
}

/**
 * `kernel.core` — the shared Rust core, exposed to plugins.
 *
 * Thin by design: every method is one Wasm call, and the reason it exists at all
 * is to make a TypeScript re-implementation of the parser unnecessary (SPEC §2).
 *
 * Two of the four methods are unimplemented, and the gap is in the *bindings*, not
 * the core: the Wasm ABI already exports `resolve_title` and `normalize_date`, but
 * `CoreBindings` (`kernel/src/wasm/index.ts`) surfaces only three of the five
 * exports. `web/CONTRACTS.md` records this as open under area `wasm`; adding
 * `resolveTitle()` and `normalizeDate()` there finishes this file.
 */

import { notImplemented, type CoreApi, type ParsedText } from "@kernel";

import type { CoreBindings } from "../wasm/index.js";

export class CoreHost implements CoreApi {
  constructor(private readonly bindings: CoreBindings) {}

  parseDocument(text: string): ParsedText {
    return this.bindings.parseDocument(text);
  }

  resolveTitle(text: string): string {
    return notImplemented("core.resolveTitle (CoreBindings does not expose resolve_title yet)");
  }

  normalizeDate(input: string): string {
    return notImplemented("core.normalizeDate (CoreBindings does not expose normalize_date yet)");
  }

  semanticsVersion(): number {
    return this.bindings.semanticsVersion();
  }
}

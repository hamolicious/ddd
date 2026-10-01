/**
 * `@ddd/kernel` — M2 surface.
 *
 * What exists here is the offline-first substrate of SPEC §4: the wire protocol,
 * the IndexedDB projection store, the sync client (change feed + lazy document
 * hydration), the local query engine, and the shared Rust core compiled to Wasm.
 *
 * What does *not* exist here yet, on purpose: the plugin loader, the extension
 * registry, the event bus, React, and the `@kernel` object plugins receive — all
 * M3 (SPEC §9). Nothing in this tree may import React.
 */

export * from "./protocol.js";
export * from "./store/index.js";
export * from "./sync/index.js";
export * from "./query/index.js";
export {
  filterRow,
  loadCore,
  resetCoreForTests,
  type CoreBindings,
  type FilterJson,
  type FilterRow,
  type ParsedDocument,
} from "./wasm/index.js";

/** Kernel bundle version. One semver covers the `@kernel` surface + Wasm ABI (SPEC §6.4). */
export const KERNEL_VERSION = "0.1.0";

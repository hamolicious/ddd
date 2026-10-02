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

export const KERNEL_VERSION = "0.1.0";

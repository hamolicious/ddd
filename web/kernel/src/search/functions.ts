import type { CoreBindings, SqlParam } from "../wasm/index.js";

export interface SqlFunction {
  readonly name: string;
  readonly arity: number;
  readonly deterministic: boolean;
  call(args: readonly SqlParam[]): SqlParam;
}

export function coreSqlFunctions(core: Pick<CoreBindings, "searchFunctions" | "searchCall">): readonly SqlFunction[] {
  return core.searchFunctions().map((info, index) => ({
    name: info.name,
    arity: info.arity,
    deterministic: info.deterministic,
    call: (args) => core.searchCall(index, args),
  }));
}

export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

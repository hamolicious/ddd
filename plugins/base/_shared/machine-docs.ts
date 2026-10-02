import type { FilterJson } from "@kernel";

export const MACHINE_KEY = "machine";

export function isMachineDocument(row: { readonly fm: Readonly<Record<string, unknown>> }): boolean {
  return row.fm[MACHINE_KEY] === true;
}

export const EXCLUDE_MACHINE_DOCUMENTS: FilterJson = {
  not: { cmp: { field: `fm.${MACHINE_KEY}`, op: "eq", value: { bool: true } } },
};

export function withoutMachineDocuments(filter?: FilterJson): FilterJson {
  return filter === undefined ? EXCLUDE_MACHINE_DOCUMENTS : { and: [filter, EXCLUDE_MACHINE_DOCUMENTS] };
}

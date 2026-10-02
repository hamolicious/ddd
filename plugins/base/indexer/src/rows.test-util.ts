import type { CoreMap, DocumentRow } from "@kernel";

export function row(id: string, content: string, fm: CoreMap = {}, extra: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id,
    title: typeof fm.title === "string" ? fm.title : id,
    content,
    fm,
    plugins: {},
    fm_parse_error: false,
    materialized_version: "v1",
    created_at: "2026-09-01T00:00:00Z",
    created_by: null,
    updated_at: "2026-09-01T00:00:00Z",
    updated_by: null,
    deleted: false,
    deleted_at: null,
    deleted_by: null,
    purged: false,
    ...extra,
  };
}

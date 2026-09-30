/**
 * The `table` plugin's API types, exported from `index.tsx` as `plugin:table`.
 *
 * A search shown as a table, for a page that is not a note (the all-documents page).
 * `TablePage` is `search`'s `SearchShell` with the table in it; its settings (`cols`,
 * `rows`) are the host's to keep. `save` makes a saved search shown as a table (`type:
 * table`), with those settings in the note's `%%% table` section.
 */

import type { ComponentType } from "react";

import type { SearchShellProps, SearchSpec } from "plugin:search";

export interface TablePageProps extends Omit<SearchShellProps, "renderView" | "renderSettings" | "pageSize" | "showsEmpty"> {
  /** The table's settings: `cols`, `rows`. */
  readonly options: Readonly<Record<string, string>>;
  readonly onOptionsChange: (options: Readonly<Record<string, string>>) => void;
}

export interface SaveTableOptions {
  /** The new note's title; the search text, or "Saved search", by default. */
  readonly title?: string;
  /** Where the note belongs: a note's id, `""` for the root; where new notes go when absent. */
  readonly parent?: string;
}

export interface Table {
  readonly TablePage: ComponentType<TablePageProps>;
  /** Save the search and the table's settings to a new note, and open it. Resolves to the note's id. */
  readonly save: (spec: SearchSpec, options: Readonly<Record<string, string>>, save?: SaveTableOptions) => Promise<string>;
}

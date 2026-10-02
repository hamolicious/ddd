import type { ComponentType } from "react";

import type { SearchShellProps, SearchSpec } from "plugin:search";

export interface TablePageProps extends Omit<SearchShellProps, "renderView" | "renderSettings" | "pageSize" | "showsEmpty"> {
  readonly options: Readonly<Record<string, string>>;
  readonly onOptionsChange: (options: Readonly<Record<string, string>>) => void;
}

export interface SaveTableOptions {
  readonly title?: string;
  readonly parent?: string;
}

export interface Table {
  readonly TablePage: ComponentType<TablePageProps>;
  readonly save: (spec: SearchSpec, options: Readonly<Record<string, string>>, save?: SaveTableOptions) => Promise<string>;
}

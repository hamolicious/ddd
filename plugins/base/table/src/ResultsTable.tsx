/**
 * The results, as a table: the title, then the columns the search chose (`columns.ts`).
 *
 * **It is a box `rows` rows tall** and scrolls the rest inside itself, so a search embedded
 * in a note takes the room of its first rows rather than the whole result set. The height
 * is measured, not guessed: once the `rows`-th row has been drawn, the box stops at its
 * bottom edge, whatever the rows' heights (a search result carries a snippet line). With
 * no more rows than that, the box is just the table.
 *
 * **Virtual inside the box** (`_shared/virtual-list.ts`, which finds the box as its scroll
 * parent): only the rows in view are in the DOM, with spacer rows standing in for the
 * rest. The next page loads a box-height before the end is reached (`LoadMore` rooted in
 * the box).
 *
 * **A header sorts.** Clicking a column's header sorts by it — every column is a field
 * path, and so a sort key — and clicking it again flips the direction. The "Match"
 * column is the exception: a search result's matched line, which nothing sorts on.
 */

import { useLayoutEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import type { DocumentRow } from "@kernel";

import { target as mark } from "../../_shared/target.js";
import { useVirtualList } from "../../_shared/virtual-list.js";

import { MATCH_COLUMN, cellText, columnLabel, columnOption } from "./columns.js";
import { LoadMore } from "../../_shared/LoadMore.js";
import type { SearchSnippet as Snippet } from "plugin:search";

export interface ResultsTableProps {
  readonly rows: readonly DocumentRow[];
  /** The columns after the title, as field paths. */
  readonly columns: readonly string[];
  /** How many rows the box shows at a time. */
  readonly rowLimit: number;
  /** The matched line under a search result's title. */
  readonly snippetOf: (row: DocumentRow) => Snippet | undefined;
  readonly renderSnippet: (snippet: Snippet) => ReactNode;
  readonly sortField: string;
  readonly sortDirection: "asc" | "desc";
  readonly onSort: (field: string, direction: "asc" | "desc") => void;
  readonly onOpen: (id: string, line?: number) => void;
  /** Open the menu of the row `button` is in (`context-menu`'s `openFor`), beside the button. */
  readonly onRowMenu: (button: HTMLElement) => void;
  /** A row with an action in flight. */
  readonly busy?: string | undefined;
  /** More rows exist: load them as the end nears. */
  readonly more?: { readonly busy: boolean; readonly onMore: () => void } | undefined;
}

export function ResultsTable({
  rows,
  columns,
  rowLimit,
  snippetOf,
  renderSnippet,
  sortField,
  sortDirection,
  onSort,
  onOpen,
  onRowMenu,
  busy,
  more,
}: ResultsTableProps): ReactElement {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  const withSnippets = columns.includes(MATCH_COLUMN) && rows.some((row) => snippetOf(row) !== undefined);
  const virtual = useVirtualList({
    count: rows.length,
    keyOf: (index) => rows[index]?.id ?? String(index),
    estimate: withSnippets ? 72 : 40,
    // The box is the viewport, wherever the page has scrolled it (an embed half off screen).
    clipToWindow: false,
  });
  const capped = rows.length > rowLimit || more !== undefined;

  // Stop the box at the bottom of the `rowLimit`-th row, once it has been drawn. Guarded,
  // so a settled height is not set again; a row scrolled out of the DOM keeps the last one.
  useLayoutEffect(() => {
    if (!box) return;
    if (!capped) {
      if (height !== undefined) setHeight(undefined);
      return;
    }
    const last = box.querySelector<HTMLElement>(`tbody > tr[data-virtual-index="${String(rowLimit - 1)}"]`);
    if (!last) return;
    const next = Math.ceil(last.getBoundingClientRect().bottom - box.getBoundingClientRect().top + box.scrollTop);
    if (height === undefined || Math.abs(next - height) > 1) setHeight(next);
  });

  const header = (field: string, label: string, className = ""): ReactElement => {
    const sorted = sortField === field;
    if (field !== "title" && !columnOption(field).sortable) {
      return (
        <th
          key={field}
          scope="col"
          className={`table:border-b table:border-border table:px-2 table:py-1 table:text-left table:text-xs table:font-semibold table:uppercase table:tracking-wide table:text-text-muted ${className}`}
        >
          {label}
        </th>
      );
    }
    const first = field === "title" || columnOption(field).kind !== "date" ? "asc" : "desc";
    return (
      <th
        key={field}
        scope="col"
        className={`table:border-b table:border-border table:px-2 table:py-1 table:text-left table:text-xs table:font-semibold table:uppercase table:tracking-wide table:text-text-muted ${className}`}
        aria-sort={sorted ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
      >
        <button
          type="button"
          className="table:inline-flex table:min-h-0! table:items-center table:gap-1 table:border-0! table:bg-transparent! table:p-0! table:font-semibold table:uppercase table:text-inherit table:hover:text-text"
          title={`Sort by ${label}`}
          onClick={() => onSort(field, sorted ? (sortDirection === "asc" ? "desc" : "asc") : first)}
        >
          {label}
          {sorted && <span aria-hidden="true">{sortDirection === "asc" ? "↑" : "↓"}</span>}
        </button>
      </th>
    );
  };

  return (
    <div
      ref={setBox}
      className="search-table-box table:min-w-0 table:overflow-auto table:overscroll-contain table:rounded table:border table:border-border"
      style={capped ? { maxHeight: height ?? 40 + rowLimit * (withSnippets ? 72 : 40) } : undefined}
    >
      <table className="search-table table:w-full table:border-collapse">
        <thead className="table:sticky table:top-0 table:z-[1] table:bg-bg-subtle">
          <tr>
            {header("title", "Title", "table:min-w-[12rem]")}
            {columns.map((field) => header(field, columnLabel(field)))}
            <th scope="col" className="table:w-[var(--lm-tap-target)] table:border-b table:border-border">
              <span className="table:sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody ref={virtual.listRef}>
          {virtual.before > 0 && <tr aria-hidden="true" style={{ height: virtual.before }} />}
          {rows.slice(virtual.first, virtual.end).map((row, offset) => {
            const snippet = snippetOf(row);
            return (
              <tr
                key={row.id}
                data-virtual-index={virtual.first + offset}
                {...mark("lm/document", row.id, { label: row.title })}
                className="search-item table:border-b table:border-border table:last:border-b-0"
              >
                {/* `max-w-0` with `w-full`: the title takes the room the other columns leave,
                    and truncates in it, so a long one cannot push the ⋯ off a phone. */}
                <td className="table:w-full table:min-w-0 table:max-w-0 table:px-2 table:py-1 table:align-top">
                  <button
                    type="button"
                    className="search-open table:flex table:min-h-[calc(var(--lm-tap-target)/2)] table:max-w-full table:items-center table:overflow-hidden table:text-ellipsis table:whitespace-nowrap table:border-0! table:bg-transparent! table:p-0! table:text-left table:text-base table:text-link table:compact:min-h-[var(--lm-tap-target)]"
                    // Draggable so the `folders` tree can be dropped onto: a bare
                    // `text/plain` document id, the only thing two plugins can agree on
                    // without importing each other (SPEC §6.1).
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", row.id);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => onOpen(row.id, snippet?.line)}
                  >
                    {row.title}
                  </button>
                  {row.fm_parse_error && (
                    <span className="search-warning table:text-xs table:text-warning" title="Some frontmatter lines could not be parsed">
                      frontmatter problem
                    </span>
                  )}
                </td>
                {columns.map((field) => {
                  if (field === MATCH_COLUMN) {
                    return (
                      <td key={field} className="table:min-w-[16rem] table:max-w-[40ch] table:px-2 table:py-1 table:align-top">
                        {snippet && renderSnippet(snippet)}
                      </td>
                    );
                  }
                  const text = cellText(row, field);
                  return (
                    <td
                      key={field}
                      className="table:max-w-[24ch] table:truncate table:px-2 table:py-1 table:align-top table:text-sm table:text-text-muted"
                      title={text}
                    >
                      {text}
                    </td>
                  );
                })}
                <td className="table:px-1 table:align-top">
                  <button
                    type="button"
                    className="search-row-menu table:inline-flex table:w-[var(--lm-tap-target)] table:items-center table:justify-center table:border-transparent! table:bg-transparent! table:p-0! table:text-text-muted table:hover:border-border! table:hover:text-text"
                    aria-haspopup="menu"
                    aria-label={`Actions for ${row.title}`}
                    disabled={busy === row.id}
                    onClick={(event) => onRowMenu(event.currentTarget)}
                  >
                    ⋯
                  </button>
                </td>
              </tr>
            );
          })}
          {virtual.after > 0 && <tr aria-hidden="true" style={{ height: virtual.after }} />}
        </tbody>
      </table>
      {more && <LoadMore busy={more.busy} onMore={more.onMore} root={box} />}
    </div>
  );
}

/**
 * The table's settings, in the search's View panel: how many rows it shows at a time, and which
 * columns follow the title. The chosen columns are chips, in order, each movable and
 * removable; one field adds another, suggesting the fixed columns and every property in
 * use (a `<datalist>`, as the filter's property field has it) and taking any other key
 * typed.
 */

import { useId, useState } from "react";
import type { ReactElement } from "react";

import type { FieldOption } from "../../_shared/conditions.js";
import type { ViewSettingsProps } from "../../_shared/saved-view-mode.js";

import {
  FIXED_COLUMNS,
  MAX_ROWS,
  clampRows,
  columnForKey,
  columnLabel,
  tableFromOptions,
  tableOptions,
  type TableSettings,
} from "./columns.js";

export function TableSettingsPanel({ options: viewOptions, onOptionsChange, fields }: ViewSettingsProps): ReactElement {
  const table = tableFromOptions(viewOptions);
  const onChange = (next: TableSettings): void => onOptionsChange(tableOptions(next, viewOptions));
  const options: readonly FieldOption[] = [
    ...FIXED_COLUMNS,
    ...fields
      .filter((field) => field.field.startsWith("fm."))
      .map((field): FieldOption => ({ field: field.field, label: field.label, kind: "str", sortable: true })),
  ];
  const listId = useId();
  const [typed, setTyped] = useState("");
  const offered = options.filter((option) => !table.columns.includes(option.field));
  /** What was typed, as a column: a label picked from the list, or a property key. */
  const typedColumn =
    offered.find((option) => optionName(option) === typed.trim())?.field ?? columnForKey(typed);
  const setColumns = (columns: readonly string[]): void => onChange({ ...table, columns });
  const move = (index: number, delta: number): void => {
    const next = [...table.columns];
    const [field] = next.splice(index, 1);
    if (field === undefined) return;
    next.splice(Math.max(0, Math.min(next.length, index + delta)), 0, field);
    setColumns(next);
  };

  return (
    <div className="search-table-settings table:flex table:flex-col table:gap-2">
      <div className="search-row">
        <label className="search-field table:w-[9rem]">
          <span>Rows at a time</span>
          <input
            type="number"
            min={1}
            max={MAX_ROWS}
            value={table.rows}
            onChange={(event) => {
              if (event.target.value !== "") onChange({ ...table, rows: clampRows(event.target.value) });
            }}
          />
        </label>
        <form
          className="table:flex table:flex-[1_1_14rem] table:items-end table:gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!typedColumn || table.columns.includes(typedColumn)) return;
            setColumns([...table.columns, typedColumn]);
            setTyped("");
          }}
        >
          <label className="search-field search-grow">
            <span>Add a column</span>
            <input
              value={typed}
              list={listId}
              placeholder="Property, e.g. status"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
          <datalist id={listId}>
            {offered.map((option) => (
              <option key={option.field} value={optionName(option)} />
            ))}
          </datalist>
          <button type="submit" disabled={!typedColumn || table.columns.includes(typedColumn)}>
            Add
          </button>
        </form>
      </div>

      <ul className="table:m-0 table:flex table:list-none table:flex-wrap table:items-center table:gap-1.5 table:p-0 table:text-sm" aria-label="Columns">
        <li className="table:rounded table:border table:border-border table:bg-bg table:px-2 table:py-1 table:text-text-muted">Title</li>
        {table.columns.map((field, index) => (
          <li
            key={field}
            className="table:flex table:items-center table:rounded table:border table:border-border table:bg-bg table:pl-2 table:[&_button]:min-h-0! table:[&_button]:border-0! table:[&_button]:bg-transparent! table:[&_button]:px-1.5! table:[&_button]:py-1! table:[&_button]:text-text-muted table:[&_button:hover]:text-text"
          >
            <span className="table:pr-0.5">{columnLabel(field)}</span>
            {index > 0 && (
              <button type="button" aria-label={`Move ${columnLabel(field)} left`} title="Move left" onClick={() => move(index, -1)}>
                ‹
              </button>
            )}
            {index < table.columns.length - 1 && (
              <button type="button" aria-label={`Move ${columnLabel(field)} right`} title="Move right" onClick={() => move(index, 1)}>
                ›
              </button>
            )}
            <button
              type="button"
              aria-label={`Remove ${columnLabel(field)}`}
              title="Remove"
              onClick={() => setColumns(table.columns.filter((column) => column !== field))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How a column is named in the add field: the label for a fixed one, the key otherwise. */
function optionName(option: FieldOption): string {
  return option.field.startsWith("fm.") ? columnLabel(option.field) : option.label;
}

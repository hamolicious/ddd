import { useState } from "react";
import type { ReactElement } from "react";

import { FmKeySelect } from "plugin:search";

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
  const [typed, setTyped] = useState("");
  const builtIn = FIXED_COLUMNS.filter((column) => !table.columns.includes(column.field)).map((column) => ({
    key: column.field,
    label: column.label,
  }));
  const typedColumn =
    builtIn.find((column) => column.key === typed.trim() || column.label === typed.trim())?.key ?? columnForKey(typed);
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
          <div className="search-field search-grow">
            <span>Add a column</span>
            <FmKeySelect
              value={typed}
              builtIn={builtIn}
              label="Add a column"
              placeholder="Property, e.g. status"
              onChange={setTyped}
              onPick={(key) => {
                const column = builtIn.some((choice) => choice.key === key) ? key : columnForKey(key);
                if (column === undefined || table.columns.includes(column)) return;
                setColumns([...table.columns, column]);
                setTyped("");
              }}
            />
          </div>
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

/**
 * The filter bar above the board (`layout.ts`'s `filterRows`): a pill per property the
 * cards show. Idle, a pill names the property and the value chosen ("Any" for none) —
 * muted, or in the accent while a value is chosen. Clicked, it opens to `search`'s
 * `FmValueSelect` in place: the value typed, or picked from every value the workspace
 * holds for the property, commonest first, each with its note count.
 *
 * A value some card on the board holds applies as soon as it is typed or picked, and an
 * emptied box lifts the filter at once. Enter, a pick, or leaving the pill applies whatever
 * was typed and closes it; Escape only closes it. "× Clear" lifts every filter.
 */

import { useRef, useState } from "react";
import type { ComponentType, ReactElement } from "react";

import type { DocumentRow } from "@kernel";
import type { FmValueSelectProps } from "plugin:search";

import { filterChoices, type Filters, type Scalar } from "./layout.js";

const PILL =
  "kanban:relative kanban:inline-flex kanban:h-7 kanban:items-center kanban:gap-1 kanban:rounded-full! kanban:border! kanban:pl-2.5! kanban:pr-2! kanban:py-0! kanban:text-xs kanban:shadow-1 kanban:transition-colors kanban:duration-150 kanban:compact:h-9";
const NAME = "kanban:text-[0.65rem] kanban:font-medium kanban:uppercase kanban:tracking-wide kanban:opacity-70";
/** The picker's box and list, dressed as the pill's: the box bare inside it, the list hung under the whole pill. */
const PICKER =
  "kanban:[&_.search-combobox]:static kanban:[&_.search-combobox]:w-36 kanban:[&_input]:h-full kanban:[&_input]:min-h-0! kanban:[&_input]:border-0! kanban:[&_input]:bg-transparent! kanban:[&_input]:p-0! kanban:[&_input]:font-sans kanban:[&_input]:text-xs! kanban:[&_input]:font-semibold kanban:[&_input]:text-text kanban:[&_input]:outline-none kanban:[&_input]:placeholder:font-normal kanban:[&_input]:placeholder:text-text-muted kanban:[&_.search-combobox>div]:right-auto kanban:[&_.search-combobox>div]:w-64 kanban:[&_.search-combobox>div]:max-w-[80vw]";

export interface FilterBarProps {
  /** The properties to filter by (`filterFields`). */
  readonly fields: readonly string[];
  /** Every card loaded: what each property takes on the board. */
  readonly rows: readonly DocumentRow[];
  readonly filters: Filters;
  readonly onFilter: (field: string, value: Scalar | undefined) => void;
  readonly onClear: () => void;
  readonly FmValueSelect: ComponentType<FmValueSelectProps>;
}

export function FilterBar({ fields, rows, filters, onFilter, onClear, FmValueSelect }: FilterBarProps): ReactElement {
  return (
    <div className="kanban-filters kanban:flex kanban:flex-wrap kanban:items-center kanban:gap-1.5 kanban:text-xs" role="group" aria-label="Filter the board">
      <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="kanban:shrink-0 kanban:text-text-muted">
        <path d="M4 5h16l-6 7v5l-4 2v-7z" />
      </svg>
      {fields.map((field) => (
        <FilterPill
          key={field}
          field={field}
          choices={filterChoices(rows, field)}
          current={filters.get(field)}
          onChange={(value) => onFilter(field, value)}
          Select={FmValueSelect}
        />
      ))}
      {filters.size > 0 && (
        <button
          type="button"
          className="kanban:inline-flex kanban:h-7 kanban:min-h-0! kanban:items-center kanban:gap-1 kanban:rounded-full! kanban:border! kanban:border-transparent! kanban:bg-transparent! kanban:px-2! kanban:py-0! kanban:text-xs kanban:text-text-muted kanban:transition-colors kanban:duration-150 kanban:hover:border-border! kanban:hover:bg-bg-raised! kanban:hover:text-text kanban:compact:h-9"
          onClick={onClear}
        >
          <span aria-hidden="true">×</span> Clear
        </button>
      )}
    </div>
  );
}

function FilterPill({
  field,
  choices,
  current,
  onChange,
  Select,
}: {
  readonly field: string;
  /** The values cards on the board hold: typed exactly, one applies at once, as its own kind. */
  readonly choices: readonly Scalar[];
  readonly current: Scalar | undefined;
  readonly onChange: (value: Scalar | undefined) => void;
  readonly Select: ComponentType<FmValueSelectProps>;
}): ReactElement {
  const name = field.slice("fm.".length);
  const active = current !== undefined;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  /** The draft as the handlers see it: a pick's `onChange` lands before the click reaches the pill. */
  const typed = useRef("");
  /** Closed already: the blur that follows must not apply the draft again. */
  const closed = useRef(true);
  /** The click in flight is on one of the list's options. */
  const picking = useRef(false);

  const open = (): void => {
    const text = active ? String(current) : "";
    setDraft(text);
    typed.current = text;
    closed.current = false;
    setEditing(true);
  };
  const close = (): void => {
    closed.current = true;
    setEditing(false);
  };
  const held = (text: string): Scalar | undefined => choices.find((choice) => String(choice) === text.trim());
  /** Apply `text`: a value a card holds as that value, anything else as typed, nothing as no filter. */
  const apply = (text: string): void => {
    const trimmed = text.trim();
    onChange(trimmed === "" ? undefined : (held(trimmed) ?? trimmed));
  };
  const type = (text: string): void => {
    setDraft(text);
    typed.current = text;
    // What a card holds, or nothing at all, shows on the board as it is typed.
    const value = held(text);
    if (value !== undefined) onChange(value);
    else if (text.trim() === "" && active) onChange(undefined);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className={`${PILL} kanban:min-h-0! kanban:cursor-pointer ${
          active
            ? "kanban:border-accent! kanban:bg-accent-subtle! kanban:text-text"
            : "kanban:border-border! kanban:bg-bg-raised! kanban:text-text-muted kanban:hover:border-border-strong! kanban:hover:text-text"
        }`}
        aria-haspopup="listbox"
        aria-label={`Filter by ${name}: ${active ? String(current) : "any"}`}
        title={`Filter by ${name}`}
        onClick={open}
      >
        <span className={NAME}>{name}</span>
        <span className={`kanban:max-w-[10rem] kanban:truncate ${active ? "kanban:font-semibold" : ""}`}>{active ? String(current) : "Any"}</span>
        <span aria-hidden="true" className="kanban:text-[0.6rem] kanban:opacity-60">
          ▾
        </span>
      </button>
    );
  }
  return (
    <div
      className={`${PILL} ${PICKER} kanban:border-accent! kanban:bg-bg! kanban:text-text kanban:shadow-2`}
      // Before the box's own Escape, which would blur it and so apply the draft.
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      // After the box's own Enter, which picks the option under the cursor.
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        apply(typed.current);
        close();
      }}
      onClickCapture={(event) => {
        picking.current = (event.target as Element).closest('[role="option"]') !== null;
      }}
      onClick={() => {
        if (!picking.current) return;
        picking.current = false;
        apply(typed.current);
        close();
      }}
      onBlur={(event) => {
        if (closed.current || event.currentTarget.contains(event.relatedTarget)) return;
        apply(typed.current);
        close();
      }}
    >
      <span className={NAME}>{name}</span>
      <Select fmKey={name} value={draft} onChange={type} label={`Filter by ${name}`} placeholder="Any" autoFocus />
    </div>
  );
}

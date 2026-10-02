import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { ColumnDef, ColumnSort } from "./layout.js";

const INPUT = "kanban:tap-h kanban:min-w-0 kanban:rounded kanban:border kanban:border-border kanban:bg-bg kanban:px-2 kanban:text-base kanban:text-text";
const LABEL = "kanban:flex kanban:flex-col kanban:gap-0.5 kanban:text-sm kanban:text-text-muted";
const BUTTON = "kanban:tap-h kanban:cursor-pointer kanban:rounded kanban:border kanban:border-border-strong kanban:bg-bg-raised kanban:px-3 kanban:text-sm kanban:text-text kanban:disabled:cursor-default kanban:disabled:opacity-50";

export const SWATCHES = ["#e03131", "#f76707", "#f59f00", "#2f9e44", "#0c8599", "#1971c2", "#6741d9", "#c2255c", "#868e96"];

export function normalizeColor(input: string): string | undefined {
  const hex = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{3}$/.test(hex)) return `#${[...hex].map((digit) => digit + digit).join("")}`;
  return undefined;
}

function AnyColor({ value, onChange }: { readonly value: string | undefined; readonly onChange: (color: string) => void }): ReactElement {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => {
    setDraft((current) => (normalizeColor(current) === value ? current : (value ?? "")));
  }, [value]);
  const valid = draft.trim() === "" || normalizeColor(draft) !== undefined;
  return (
    <span className="kanban:inline-flex kanban:items-center kanban:gap-1">
      <input
        type="color"
        aria-label="Pick any colour"
        className="kanban:tap-h kanban:w-[2.75rem] kanban:cursor-pointer kanban:rounded kanban:border kanban:border-border-strong kanban:bg-bg-raised kanban:p-0.5"
        value={value ?? "#868e96"}
        onChange={(event) => {
          const color = normalizeColor(event.target.value);
          if (color === undefined) return;
          setDraft(color);
          onChange(color);
        }}
      />
      <input
        type="text"
        aria-label="Hex colour"
        aria-invalid={!valid}
        placeholder="#rrggbb"
        spellCheck={false}
        className={`${INPUT} kanban:w-[7rem] kanban:font-mono ${valid ? "" : "kanban:border-danger"}`}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          const color = normalizeColor(event.target.value);
          if (color !== undefined && color !== value) onChange(color);
        }}
      />
    </span>
  );
}

export interface ColumnEditorProps {
  readonly initial: ColumnDef;
  readonly position: number;
  readonly places: number;
  readonly taken: readonly string[];
  readonly adding: boolean;
  readonly sortFields: readonly { readonly field: string; readonly label: string }[];
  readonly unsorted: string;
  readonly onSave: (def: ColumnDef, position: number) => void;
  readonly onRemove?: () => void;
  readonly onCancel: () => void;
}

export function ColumnEditor({
  initial,
  position: start,
  places,
  taken,
  adding,
  sortFields,
  unsorted,
  onSave,
  onRemove,
  onCancel,
}: ColumnEditorProps): ReactElement {
  const [value, setValue] = useState(initial.value);
  const [label, setLabel] = useState(initial.label ?? "");
  const [color, setColor] = useState<string | undefined>(initial.color);
  const [collapsed, setCollapsed] = useState(initial.collapsed === true);
  const [position, setPosition] = useState(start);
  const [sort, setSort] = useState<ColumnSort | undefined>(initial.sort);
  const trimmed = value.trim();
  const problem = trimmed === "" ? "A column needs a value." : taken.includes(trimmed) ? `There is already a “${trimmed}” column.` : undefined;
  const save = (): void => {
    if (problem) return;
    onSave(
      {
        value: trimmed,
        ...(label.trim() !== "" ? { label: label.trim() } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(collapsed ? { collapsed: true } : {}),
        ...(sort ? { sort } : {}),
      },
      position,
    );
  };

  return (
    <form
      className="kanban-column-editor kanban:flex kanban:flex-col kanban:gap-3 kanban:font-sans kanban:text-text"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label className={LABEL}>
        <span>Value</span>
        <input
          className={INPUT}
          autoFocus={adding}
          placeholder="e.g. doing"
          spellCheck={false}
          value={value}
          aria-invalid={problem !== undefined && value !== ""}
          onChange={(event) => setValue(event.target.value)}
        />
        <span className="kanban:text-xs">
          {!adding && trimmed !== initial.value && trimmed !== ""
            ? `Cards keep “${initial.value}”: they will show in a column of their own until moved here.`
            : "What a card in this column holds."}
        </span>
      </label>

      <label className={LABEL}>
        <span>Label</span>
        <input className={INPUT} placeholder={trimmed || "shown instead of the value"} value={label} onChange={(event) => setLabel(event.target.value)} />
      </label>

      <fieldset className="kanban:m-0 kanban:flex kanban:flex-col kanban:gap-1.5 kanban:border-0 kanban:p-0">
        <legend className="kanban:mb-1 kanban:p-0 kanban:text-sm kanban:text-text-muted">Colour</legend>
        <div className="kanban:flex kanban:flex-wrap kanban:items-center kanban:gap-1">
          <button
            type="button"
            aria-label="No colour"
            aria-pressed={color === undefined}
            title="None"
            className={`kanban:size-7 kanban:min-h-0! kanban:min-w-0! kanban:cursor-pointer kanban:rounded-full kanban:border-2 kanban:bg-bg kanban:p-0 kanban:text-xs kanban:text-text-muted ${color === undefined ? "kanban:border-text" : "kanban:border-border"}`}
            onClick={() => setColor(undefined)}
          >
            ⌀
          </button>
          {SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={swatch}
              aria-pressed={color === swatch}
              className={`kanban:size-7 kanban:min-h-0! kanban:min-w-0! kanban:cursor-pointer kanban:rounded-full kanban:border-2 kanban:p-0 ${color === swatch ? "kanban:border-text" : "kanban:border-transparent"}`}
              style={{ background: swatch }}
              onClick={() => setColor(swatch)}
            />
          ))}
        </div>
        <AnyColor value={color} onChange={setColor} />
      </fieldset>

      <label className="kanban:inline-flex kanban:cursor-pointer kanban:items-center kanban:gap-2 kanban:text-sm">
        <input type="checkbox" checked={collapsed} onChange={(event) => setCollapsed(event.target.checked)} />
        Folded to a strip
      </label>

      <div className="kanban:flex kanban:flex-wrap kanban:items-end kanban:gap-2">
        <label className={`${LABEL} kanban:min-w-[12rem] kanban:flex-1`}>
          <span>Sort cards by</span>
          <select
            className={INPUT}
            value={sort?.field ?? ""}
            onChange={(event) => {
              const field = event.target.value;
              setSort(field === "" ? undefined : { field, direction: sort?.direction ?? "asc" });
            }}
          >
            <option value="">{unsorted}</option>
            {!sortFields.some((choice) => choice.field === sort?.field) && sort && <option value={sort.field}>{sort.field.replace(/^fm\./, "")}</option>}
            {sortFields.map((choice) => (
              <option key={choice.field} value={choice.field}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        {sort && (
          <div className="kanban:flex kanban:gap-1" role="group" aria-label="Direction">
            <button type="button" className={`${BUTTON} kanban:aria-pressed:border-accent kanban:aria-pressed:bg-accent-subtle`} aria-pressed={sort.direction === "asc"} onClick={() => setSort({ ...sort, direction: "asc" })}>
              ↑ Ascending
            </button>
            <button type="button" className={`${BUTTON} kanban:aria-pressed:border-accent kanban:aria-pressed:bg-accent-subtle`} aria-pressed={sort.direction === "desc"} onClick={() => setSort({ ...sort, direction: "desc" })}>
              ↓ Descending
            </button>
          </div>
        )}
      </div>

      {places > 1 && (
        <div className="kanban:flex kanban:items-center kanban:gap-2 kanban:text-sm">
          <span className="kanban:text-text-muted">Position</span>
          <button type="button" className={BUTTON} aria-label="Move left" disabled={position === 0} onClick={() => setPosition((at) => at - 1)}>
            ←
          </button>
          <span className="kanban:tabular-nums">
            {position + 1} of {places}
          </span>
          <button type="button" className={BUTTON} aria-label="Move right" disabled={position >= places - 1} onClick={() => setPosition((at) => at + 1)}>
            →
          </button>
        </div>
      )}

      {problem && value !== "" && (
        <p className="kanban:m-0 kanban:text-sm kanban:text-danger" role="alert">
          {problem}
        </p>
      )}

      <div className="kanban:flex kanban:flex-wrap kanban:items-center kanban:gap-2">
        {onRemove && (
          <button type="button" className={`${BUTTON} kanban:text-danger kanban:border-danger`} onClick={onRemove}>
            Remove column
          </button>
        )}
        <span className="kanban:flex-1" />
        <button type="button" className={BUTTON} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={`${BUTTON} kanban:border-accent kanban:bg-accent kanban:text-accent-text`} disabled={problem !== undefined}>
          {adding ? "Add column" : "Save"}
        </button>
      </div>
    </form>
  );
}

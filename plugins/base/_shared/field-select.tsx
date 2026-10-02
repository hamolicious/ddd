import { useEffect, useState } from "react";
import type { ComponentType, ReactElement } from "react";

import type { FmKeySelectLike } from "./conditions-editor.js";
import { FIXED_DATE_FIELDS } from "./dates.js";

export interface FieldChoice {
  readonly field: string;
  readonly label: string;
  readonly kind?: string;
}

export interface FieldSelectProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (field: string) => void;
  readonly fields: readonly FieldChoice[];
  readonly dates?: boolean;
  readonly none?: string;
  readonly className?: string;
  readonly KeySelect?: ComponentType<FmKeySelectLike>;
}

const KEY = /^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64})*$/;

function nameOf(choice: FieldChoice): string {
  return choice.field.startsWith("fm.") ? choice.field.slice(3) : choice.label;
}

export function FieldSelect(props: FieldSelectProps): ReactElement {
  return props.KeySelect !== undefined ? <FieldKeySelect {...props} KeySelect={props.KeySelect} /> : <FieldDropdown {...props} />;
}

function FieldKeySelect({
  label,
  value,
  onChange,
  dates = false,
  none,
  className,
  KeySelect,
}: FieldSelectProps & { readonly KeySelect: ComponentType<FmKeySelectLike> }): ReactElement {
  const builtIn = [
    ...(none !== undefined ? [{ key: "", label: none }] : []),
    ...(dates ? FIXED_DATE_FIELDS.map((choice) => ({ key: choice.field, label: choice.label })) : []),
  ];
  const textOf = (field: string): string =>
    builtIn.find((choice) => choice.key === field)?.label ?? (field.startsWith("fm.") ? field.slice(3) : field);
  const fieldOf = (text: string): string | undefined => {
    const trimmed = text.trim();
    const fixed = builtIn.find((choice) => choice.key === trimmed || choice.label === trimmed);
    if (fixed !== undefined) return fixed.key;
    if (trimmed === "" && none !== undefined) return "";
    return KEY.test(trimmed) ? `fm.${trimmed}` : undefined;
  };

  const [draft, setDraft] = useState(() => textOf(value));
  useEffect(() => setDraft(textOf(value)), [value]);

  const commit = (text: string): void => {
    const field = fieldOf(text);
    if (field === undefined) {
      setDraft(textOf(value));
      return;
    }
    setDraft(textOf(field));
    if (field !== value) onChange(field);
  };

  return (
    <div
      className={className}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit(draft);
      }}
    >
      <span>{label}</span>
      <KeySelect value={draft} builtIn={builtIn} label={label} placeholder={none ?? "Property"} onChange={setDraft} onPick={commit} />
    </div>
  );
}

function FieldDropdown({ label, value, onChange, fields, dates = false, none, className }: FieldSelectProps): ReactElement {
  const properties = fields.filter((choice) => choice.field.startsWith("fm."));
  const dated = dates ? properties.filter((choice) => choice.kind === "date") : [];
  const other = properties.filter((choice) => !dated.includes(choice));
  const fixed = dates ? FIXED_DATE_FIELDS : [];
  const known = [...fixed, ...properties].some((choice) => choice.field === value);

  return (
    <label className={className}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {none !== undefined && <option value="">{none}</option>}
        {!known && value !== "" && <option value={value}>{value.replace(/^fm\./, "")}</option>}
        {fixed.map((choice) => (
          <option key={choice.field} value={choice.field}>
            {choice.label}
          </option>
        ))}
        {dated.length > 0 && (
          <optgroup label="Date properties">
            {dated.map((choice) => (
              <option key={choice.field} value={choice.field}>
                {nameOf(choice)}
              </option>
            ))}
          </optgroup>
        )}
        {other.length > 0 && (
          <optgroup label={dates ? "Other properties" : "Properties"}>
            {other.map((choice) => (
              <option key={choice.field} value={choice.field}>
                {nameOf(choice)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

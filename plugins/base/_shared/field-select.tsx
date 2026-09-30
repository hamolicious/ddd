/**
 * Picking which field a view reads — "Date from", "Group by" — in a search view's settings.
 *
 * A `<select>` over the fields the search's View panel hands a view's settings
 * (`ViewSettingsProps.fields`: the fixed roots, then every property in use). With
 * `dates`, the fixed date fields come first and date-valued properties are grouped ahead of
 * the rest; any property can still be picked, since a key only *usually* holds dates. A
 * stored field that is no longer offered (its last note deleted) stays listed, so opening
 * the settings never silently changes it.
 *
 * With `KeySelect` (`search`'s `FmKeySelect`) the field is typed or picked from the keys in
 * use instead, the fixed fields and "none" listed first by name. Typing is a draft: the
 * view changes on a pick, or on leaving the box with a key in it, never mid-word. A draft
 * that is not a key goes back to the field in force.
 *
 * Unstyled beyond what is passed: the classes are the host plugin's, under its own prefix.
 */

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
  /** Offer the fixed date fields and put date-valued properties first. */
  readonly dates?: boolean;
  /** Offer "none" (value `""`) with this label. */
  readonly none?: string;
  readonly className?: string;
  /** Pick the field by typing or from the keys in use: `search`'s `FmKeySelect`. */
  readonly KeySelect?: ComponentType<FmKeySelectLike>;
}

/** A frontmatter key as the property box takes it: dotted segments of letters, digits, `_` and `-`. */
const KEY = /^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64})*$/;

/** A property's name as a person reads it: the key, without `fm.`. */
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
  /** The box's text for a field: a fixed one's name, a key without its `fm.`. */
  const textOf = (field: string): string =>
    builtIn.find((choice) => choice.key === field)?.label ?? (field.startsWith("fm.") ? field.slice(3) : field);
  /** The field a text names: a fixed one by key or name, a key, or nothing. */
  const fieldOf = (text: string): string | undefined => {
    const trimmed = text.trim();
    const fixed = builtIn.find((choice) => choice.key === trimmed || choice.label === trimmed);
    if (fixed !== undefined) return fixed.key;
    if (trimmed === "" && none !== undefined) return "";
    return KEY.test(trimmed) ? `fm.${trimmed}` : undefined;
  };

  const [draft, setDraft] = useState(() => textOf(value));
  // The field in force changed elsewhere: show it.
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

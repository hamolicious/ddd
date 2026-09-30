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
 * Unstyled beyond what is passed: the classes are the host plugin's, under its own prefix.
 */

import type { ReactElement } from "react";

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
}

/** A property's name as a person reads it: the key, without `fm.`. */
function nameOf(choice: FieldChoice): string {
  return choice.field.startsWith("fm.") ? choice.field.slice(3) : choice.label;
}

export function FieldSelect({ label, value, onChange, fields, dates = false, none, className }: FieldSelectProps): ReactElement {
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

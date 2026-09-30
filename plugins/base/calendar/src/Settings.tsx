/** The calendar's settings: which field places a note on a day, and which ends it. */

import type { ReactElement } from "react";

import { FmKeySelect } from "plugin:search";

import type { ViewSettingsProps } from "../../_shared/saved-view-mode.js";

import { FieldSelect } from "../../_shared/field-select.js";

import { calendarOptions, withCalendar } from "./layout.js";

const FIELD = "calendar:flex calendar:flex-col calendar:gap-0.5 calendar:text-sm calendar:text-text-muted calendar:[&_select]:tap-h calendar:[&_select]:rounded calendar:[&_select]:border calendar:[&_select]:border-border calendar:[&_select]:bg-bg calendar:[&_select]:px-2 calendar:[&_select]:text-base calendar:[&_select]:text-text";

export function CalendarSettings({ options, onOptionsChange, fields }: ViewSettingsProps): ReactElement {
  const settings = calendarOptions(options);
  return (
    <div className="calendar-settings calendar:flex calendar:flex-wrap calendar:gap-3">
      <FieldSelect
        KeySelect={FmKeySelect}
        className={FIELD}
        label="Date from"
        value={settings.date}
        onChange={(date) => onOptionsChange(withCalendar({ ...settings, date }, options))}
        fields={fields}
        dates
      />
      <FieldSelect
        KeySelect={FmKeySelect}
        className={FIELD}
        label="Ends on"
        value={settings.end}
        onChange={(end) => onOptionsChange(withCalendar({ ...settings, end }, options))}
        fields={fields}
        dates
        none="Same day"
      />
    </div>
  );
}

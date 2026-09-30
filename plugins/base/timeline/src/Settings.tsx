/** The timeline's settings: which fields start and end a note, what splits it into lanes, and the scale. */

import type { ReactElement } from "react";

import type { ViewSettingsProps } from "../../_shared/saved-view-mode.js";

import { FieldSelect } from "../../_shared/field-select.js";

import { SCALES, timelineOptions, withTimeline, type Scale } from "./layout.js";

const FIELD = "timeline:flex timeline:flex-col timeline:gap-0.5 timeline:text-sm timeline:text-text-muted timeline:[&_select]:tap-h timeline:[&_select]:rounded timeline:[&_select]:border timeline:[&_select]:border-border timeline:[&_select]:bg-bg timeline:[&_select]:px-2 timeline:[&_select]:text-base timeline:[&_select]:text-text";

export function TimelineSettings({ options, onOptionsChange, fields }: ViewSettingsProps): ReactElement {
  const settings = timelineOptions(options);
  const set = (patch: Partial<typeof settings>): void => onOptionsChange(withTimeline({ ...settings, ...patch }, options));
  return (
    <div className="timeline-settings timeline:flex timeline:flex-wrap timeline:gap-3">
      <FieldSelect className={FIELD} label="Starts on" value={settings.start} onChange={(start) => set({ start })} fields={fields} dates />
      <FieldSelect className={FIELD} label="Ends on" value={settings.end} onChange={(end) => set({ end })} fields={fields} dates none="No end (a point)" />
      <FieldSelect className={FIELD} label="Lanes by" value={settings.group} onChange={(group) => set({ group })} fields={fields} none="One lane" />
      <label className={FIELD}>
        <span>Scale</span>
        <select value={settings.scale} onChange={(event) => set({ scale: event.target.value as Scale })}>
          {SCALES.map((scale) => (
            <option key={scale.id} value={scale.id}>
              {scale.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

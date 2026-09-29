import { useState, type ReactElement } from "react";

import type { Icons } from "@protocols/lm/icons";

import { normalizeColor, resolveStyle, textOn, type FolderStyle } from "./styles.js";

/** A starting point, not a limit: the colour field takes any hex. */
const SWATCHES = [
  "#e03131",
  "#f76707",
  "#f59f00",
  "#2f9e44",
  "#0c8599",
  "#1971c2",
  "#6741d9",
  "#c2255c",
  "#868e96",
];

const BUTTON_CLASSES =
  "folderstyle:tap-h folderstyle:cursor-pointer folderstyle:rounded folderstyle:border folderstyle:border-border-strong folderstyle:bg-bg-raised folderstyle:px-1.5 folderstyle:font-sans folderstyle:text-text";

const LEGEND_CLASSES =
  "folderstyle:mb-1 folderstyle:p-0 folderstyle:text-[0.9em] folderstyle:text-text-muted";

export interface EditorProps {
  /** The note's title, for the preview. */
  readonly name: string;
  readonly initial: FolderStyle | undefined;
  /** Applied at once, so the tree behind the sheet shows it; `undefined` clears that field. */
  readonly onChange: (change: { background?: string | undefined; icon?: string | undefined }) => void;
  /** `undefined` when no icon set is wired: the sheet is then background only. */
  readonly icons: Pick<Icons, "Icon" | "Picker"> | undefined;
  /** What an unset field shows instead, in the preview: the defaults, for a note. */
  readonly fallback?: FolderStyle;
}

/** Every change applies as it is made; the sheet closes the usual ways (Escape, outside). */
export function Editor({ name, initial, onChange, icons, fallback = {} }: EditorProps): ReactElement {
  const [background, setBackground] = useState(initial?.background);
  const [icon, setIcon] = useState(initial?.icon);
  const [draft, setDraft] = useState(initial?.background ?? "");

  const chooseBackground = (next: string | undefined): void => {
    setBackground(next);
    setDraft(next ?? "");
    onChange({ background: next });
  };
  const chooseIcon = (next: string | undefined): void => {
    setIcon(next);
    onChange({ icon: next });
  };
  const draftColor = normalizeColor(draft);
  const shown = resolveStyle({ ...(background !== undefined ? { background } : {}), ...(icon !== undefined ? { icon } : {}) }, fallback);

  return (
    <div className="folder-style-editor folderstyle:flex folderstyle:flex-col folderstyle:gap-3">
      {/* The row as the tree will draw it. */}
      <p className="folderstyle:m-0">
        <span
          className={`folder-style-preview folderstyle:inline-flex folderstyle:items-center folderstyle:gap-1 folderstyle:leading-[1.4] folderstyle:font-medium ${shown?.background !== undefined ? "folderstyle:rounded folderstyle:px-1.5" : ""}`}
          style={shown?.background !== undefined ? { background: shown.background, color: textOn(shown.background) } : undefined}
        >
          {icons !== undefined && shown?.icon !== undefined && (
            <icons.Icon name={shown.icon} size="1.05em" className="folderstyle:block folderstyle:shrink-0" />
          )}
          <span>{name}</span>
        </span>
      </p>

      <fieldset className="folderstyle:m-0 folderstyle:flex folderstyle:flex-col folderstyle:gap-1.5 folderstyle:border-0 folderstyle:p-0">
        <legend className={LEGEND_CLASSES}>Background</legend>
        <div className="folderstyle:flex folderstyle:flex-wrap folderstyle:gap-1">
          {SWATCHES.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={swatch}
              aria-pressed={background === swatch}
              title={swatch}
              className={`folder-style-swatch folderstyle:size-[1.75rem] folderstyle:min-h-0! folderstyle:min-w-0! folderstyle:cursor-pointer folderstyle:rounded-full folderstyle:border-2 folderstyle:p-0 ${background === swatch ? "folderstyle:border-text" : "folderstyle:border-transparent"}`}
              style={{ background: swatch }}
              onClick={() => chooseBackground(swatch)}
            />
          ))}
        </div>
        <div className="folderstyle:flex folderstyle:flex-wrap folderstyle:items-center folderstyle:gap-1">
          <input
            type="color"
            aria-label="Pick any color"
            className="folderstyle:tap-h folderstyle:w-[2.75rem] folderstyle:cursor-pointer folderstyle:rounded folderstyle:border folderstyle:border-border-strong folderstyle:bg-bg-raised folderstyle:p-0.5"
            value={background ?? fallback.background ?? "#868e96"}
            onChange={(event) => chooseBackground(normalizeColor(event.target.value))}
          />
          <input
            type="text"
            aria-label="Hex color"
            placeholder="#rrggbb"
            spellCheck={false}
            className={`folderstyle:tap-h folderstyle:w-[7rem] folderstyle:rounded folderstyle:border folderstyle:bg-bg-raised folderstyle:px-1.5 folderstyle:font-mono folderstyle:text-text ${draft === "" || draftColor !== undefined ? "folderstyle:border-border-strong" : "folderstyle:border-danger"}`}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              const next = normalizeColor(event.target.value);
              if (next !== undefined && next !== background) {
                setBackground(next);
                onChange({ background: next });
              }
            }}
          />
          {background !== undefined && (
            <button type="button" className={BUTTON_CLASSES} onClick={() => chooseBackground(undefined)}>
              {fallback.background !== undefined ? "Use default" : "No background"}
            </button>
          )}
        </div>
      </fieldset>

      {icons !== undefined && (
        <fieldset className="folderstyle:m-0 folderstyle:border-0 folderstyle:p-0">
          <legend className={LEGEND_CLASSES}>Icon</legend>
          <icons.Picker {...(icon !== undefined ? { value: icon } : {})} onChange={chooseIcon} />
        </fieldset>
      )}
    </div>
  );
}

/**
 * The picker: one `lm/settings.section` item with the appearance control and a theme list per
 * scheme.
 *
 * It is two radio groups and a swatch, and the only thing worth explaining is the
 * layout choice: themes are grouped by the scheme they declare, and the group that is
 * not currently painted says so. That is the honest presentation of the model — a
 * dark theme cannot show up while the light appearance is active — and it is what
 * makes `system` usable instead of surprising.
 *
 * Swatches are rendered from the theme's tokens over the kernel defaults, so a theme
 * is previewed exactly as it will paint, including the tokens it does not set.
 */

import { useEffect, useId, useState, type ReactNode } from "react";

import type { ColorScheme, Kernel, Registry } from "@kernel";
import type { Theme } from "./api.js";

import type { ThemesController } from "./controller.js";

export interface ThemePickerProps {
  readonly kernel: Kernel;
  /** Every installed theme (the `addTheme` registry). */
  readonly themes: Registry<Theme>;
  readonly controller: ThemesController;
}

export function ThemePicker({ kernel, themes: host, controller }: ThemePickerProps): ReactNode {
  const [themes, setThemes] = useState<readonly Theme[]>(() => host.get());
  const [appearance, setAppearance] = useState(() => controller.appearance());
  const [scheme, setScheme] = useState<ColorScheme>(() => kernel.ui.colorScheme);
  const [revision, setRevision] = useState(0);
  const group = useId();

  useEffect(() => host.subscribe(setThemes), [host]);
  // Re-read the *preference*, not just the resolved scheme.
  //
  // `appearance` is local state so the radio responds to a click without waiting for a
  // round trip, but it must not become the only story: the preference also changes
  // from outside this component — another tab, a command, and above all the per-user
  // settings document being adopted after this section first rendered (a cold client
  // whose settings arrive after `themes` activated). Left alone, the control then
  // claims "Match my system" while the app is painting the stored dark appearance,
  // which is the one thing a preference control must never do.
  useEffect(
    () =>
      kernel.ui.onColorScheme((next) => {
        setScheme(next);
        setAppearance(controller.appearance());
      }),
    [kernel, controller],
  );
  useEffect(
    () =>
      controller.onChange(() => {
        setAppearance(controller.appearance());
        setRevision((value) => value + 1);
      }),
    [controller],
  );
  // `revision` exists to re-render on a selection made elsewhere (a command, another
  // tab, a sync update); reading it here is what makes that dependency explicit.
  void revision;

  return (
    <div className="theme-picker themes:grid themes:max-w-[34rem] themes:gap-4 themes:font-sans themes:compact:max-w-none themes:compact:gap-2">
      <fieldset className="themes:m-0 themes:grid themes:gap-0.5 themes:rounded themes:border themes:border-border themes:p-2">
        <legend>Appearance</legend>
        {(["system", "light", "dark"] as const).map((value) => (
          <label key={value} className="themes:tap-h themes:flex themes:cursor-pointer themes:items-center themes:gap-2 themes:rounded themes:px-1 themes:hover:bg-bg-subtle">
            <input
              type="radio"
              name={`${group}-appearance`}
              value={value}
              checked={appearance === value}
              onChange={() => {
                setAppearance(value);
                void controller.setAppearance(value);
              }}
            />
            <span className="themes:flex-1">
              {value === "system" ? "Match my system" : value === "light" ? "Light" : "Dark"}
            </span>
          </label>
        ))}
        <p className="themes:mx-1 themes:my-0.5 themes:text-sm themes:text-text-muted">
          Showing <strong>{scheme}</strong>.
        </p>
      </fieldset>

      {(["light", "dark"] as const).map((target) => (
        <SchemeGroup
          key={target}
          scheme={target}
          active={scheme === target}
          group={group}
          themes={themes.filter((theme) => theme.scheme === target)}
          selected={controller.forScheme(target)}
          missing={controller.isMissing(target)}
          preview={(theme) => controller.previewTokens(theme)}
          onSelect={(id) => {
            if (id === undefined) void controller.clear(target);
            else void controller.select(id);
          }}
        />
      ))}

      {controller.durable ? null : (
        <p className="themes:mx-1 themes:my-0.5 themes:text-sm themes:text-warning">
          Saved on this device. It reaches your other devices when you are online.
        </p>
      )}
    </div>
  );
}

function SchemeGroup({
  scheme,
  active,
  group,
  themes,
  selected,
  missing,
  preview,
  onSelect,
}: {
  readonly scheme: ColorScheme;
  readonly active: boolean;
  readonly group: string;
  readonly themes: readonly Theme[];
  readonly selected: string | undefined;
  readonly missing: boolean;
  readonly preview: (theme: Theme) => Record<string, string>;
  readonly onSelect: (id: string | undefined) => void;
}): ReactNode {
  return (
    <fieldset className="themes:m-0 themes:grid themes:gap-0.5 themes:rounded themes:border themes:border-border themes:p-2">
      <legend className="themes:flex themes:items-center themes:gap-2 themes:px-1 themes:font-semibold">
        {scheme === "dark" ? "Dark theme" : "Light theme"}
        {active ? <span className="themes:rounded themes:border themes:border-accent themes:bg-accent-subtle themes:px-1 themes:text-xs themes:font-normal themes:lowercase themes:text-text">active now</span> : null}
      </legend>
      {!active ? (
        <p className="themes:mx-1 themes:my-0.5 themes:text-sm themes:text-text-muted">Used in {scheme}.</p>
      ) : null}
      {missing ? (
        <p className="themes:mx-1 themes:my-0.5 themes:text-sm themes:text-warning">
          The saved theme <code>{selected}</code> is not installed. Using the kernel default.
        </p>
      ) : null}

      <label className="themes:tap-h themes:flex themes:cursor-pointer themes:items-center themes:gap-2 themes:rounded themes:px-1 themes:hover:bg-bg-subtle themes:[&>input]:size-6 themes:[&>input]:m-0 themes:[&>input]:min-h-0 themes:[&>input]:accent-accent">
        <input
          type="radio"
          name={`${group}-${scheme}`}
          checked={selected === undefined || missing}
          onChange={() => onSelect(undefined)}
        />
        <Swatch tokens={undefined} />
        <span className="themes:flex-1">Kernel default</span>
      </label>

      {themes.map((theme) => (
        <label key={theme.id} className="themes:tap-h themes:flex themes:cursor-pointer themes:items-center themes:gap-2 themes:rounded themes:px-1 themes:hover:bg-bg-subtle themes:[&>input]:size-6 themes:[&>input]:m-0 themes:[&>input]:min-h-0 themes:[&>input]:accent-accent">
          <input
            type="radio"
            name={`${group}-${scheme}`}
            value={theme.id}
            checked={!missing && selected === theme.id}
            onChange={() => onSelect(theme.id)}
          />
          <Swatch tokens={preview(theme)} />
          <span className="themes:flex-1">{theme.name}</span>
        </label>
      ))}

      {themes.length === 0 ? (
        <p className="themes:mx-1 themes:my-0.5 themes:text-sm themes:text-text-muted">
          No {scheme} themes are installed beyond the kernel default.
        </p>
      ) : null}
    </fieldset>
  );
}

/** A miniature of the palette: background, text, border, accent. */
function Swatch({ tokens }: { readonly tokens: Record<string, string> | undefined }): ReactNode {
  const style = tokens
    ? {
        background: tokens["--lm-bg"],
        color: tokens["--lm-text"],
        borderColor: tokens["--lm-border-strong"],
      }
    : undefined;
  const accent = tokens?.["--lm-accent"];
  return (
    <span className="themes:inline-flex themes:h-[1.7rem] themes:w-12 themes:shrink-0 themes:items-center themes:justify-center themes:gap-[0.2em] themes:rounded themes:border themes:border-border-strong themes:bg-bg themes:text-xs themes:leading-none themes:text-text themes:compact:w-10" style={style} aria-hidden="true">
      Aa
      <span className="themes:size-[0.55em] themes:rounded-full themes:bg-accent" style={accent ? { background: accent } : undefined} />
    </span>
  );
}

/**
 * The surface's own settings screen: **"Open documents in"**.
 *
 * `document-surface` has declared a `defaultMode` per-user setting since M3, with a
 * label and a description written for a human — and nothing rendered it
 * (POLISH-BACKLOG item 2), so the only way to change it was to hand-edit a settings
 * document. This is the section that renders it, which is the same thing `themes` and
 * `commands` already do for theirs: `SettingsApi.schema()` is plugin-scoped by design
 * (`kernel-api/src/settings.ts`), so a generic "render every plugin's settings" screen
 * in `settings` would need a new `@kernel` surface. A plugin renders its own.
 *
 * **The options come from the registry, not from this file.** `document.mode` has no
 * built-in favourite (SPEC §6.5) — that symmetry is what M3's acceptance test rests on
 * — so the select lists whatever is contributed, labelled the way the contributing
 * plugin labels it. A workspace that replaced `editor` gets its replacement's label
 * here with nothing to change; a workspace with one mode gets a select with one option
 * rather than a special case.
 *
 * The remembered per-document choice still wins over this setting when there is one
 * (that is what "unless the mode switch says otherwise" means), so the section also
 * offers the one control that makes the preference reassert itself everywhere:
 * forgetting the memory. Without it, "why is this still opening in Read?" has no
 * answer a user can act on.
 */

import type { Kernel, Unsubscribe } from "@kernel";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { DocumentMode } from "../../_shared/points.js";

export interface DefaultModeSectionProps {
  readonly kernel: Kernel;
  /** The visible-anywhere mode list, live. */
  readonly modes: () => readonly DocumentMode[];
  readonly onModesChange: (listener: () => void) => Unsubscribe;
  /** The stored preference, or `undefined` when none is stored. */
  readonly defaultMode: () => string | undefined;
  readonly setDefaultMode: (modeId: string) => Promise<void>;
  /** How many per-document choices are remembered, and how to drop them. */
  readonly rememberedCount: () => number;
  readonly forgetRemembered: () => Promise<void>;
}

export function DefaultModeSection({
  kernel,
  modes,
  onModesChange,
  defaultMode,
  setDefaultMode,
  rememberedCount,
  forgetRemembered,
}: DefaultModeSectionProps): ReactNode {
  const [available, setAvailable] = useState<readonly DocumentMode[]>(() => modes());
  const [selected, setSelected] = useState<string | undefined>(() => defaultMode());
  const [remembered, setRemembered] = useState<number>(() => rememberedCount());
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** A write of our own is in flight; its optimistic value outranks the stored one. */
  const writing = useRef(false);

  // A mode contributed after this screen rendered has to appear in the select. The
  // whole app is built on registries that fill in after first paint (web/README.md
  // "every consumer of a registry point has to be live"), and a settings screen is the
  // easiest place to forget it.
  useEffect(() => onModesChange(() => setAvailable(modes())), [modes, onModesChange]);

  /*
   * ...and the same rule applies to the *setting*, which this screen was reading once at
   * mount. `defaultMode` is per-user state in a synced document (SPEC §6.4): a second
   * tab, a second device, or simply switching modes on a few documents changes it under
   * this component, and neither the select nor the "N documents open the way you last
   * left them" count followed. The count is the sharper half — it is the number
   * "Forget remembered modes" is about to clear, so a stale one describes a button's
   * effect wrongly.
   *
   * Guarded, because `activate` is not on the stack here but a settings host that
   * refuses to subscribe must not take out the settings screen with it. Skipped while a
   * write of ours is in flight, so the optimistic value is not overwritten by the value
   * it is replacing.
   */
  useEffect(() => {
    try {
      return kernel.settings.subscribe(() => {
        if (writing.current) return;
        setSelected(defaultMode());
        setRemembered(rememberedCount());
      });
    } catch (error: unknown) {
      kernel.log.warn("settings changes will not be followed on this screen", error);
      return undefined;
    }
  }, [defaultMode, kernel, rememberedCount]);

  const choose = (modeId: string): void => {
    const previous = selected;
    setSelected(modeId);
    setProblem(undefined);
    writing.current = true;
    void setDefaultMode(modeId)
      .catch((error: unknown) => {
        kernel.log.error("could not store the default document mode", error);
        setSelected(previous);
        setProblem(describe(error));
      })
      .finally(() => {
        writing.current = false;
      });
  };

  return (
    <div className="docsurface-settings">
      <label className="docsurface-setting">
        <span className="docsurface-setting-label">Open documents in</span>
        <select
          className="docsurface-setting-select"
          value={selected ?? ""}
          onChange={(event) => choose(event.target.value)}
        >
          {/* Only while the registry is empty — a select with no options is a control
              that cannot say what it is showing. */}
          {available.length === 0 ? <option value="">No modes installed</option> : null}
          {available.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>

      <p className="docsurface-setting-hint">
        Used when you open a document you have not switched modes on. Switching modes on
        a document is remembered for that document and wins over this.
      </p>

      {remembered > 0 ? (
        <p className="docsurface-setting-hint">
          <button
            type="button"
            className="docsurface-setting-button"
            onClick={() => {
              setProblem(undefined);
              void forgetRemembered()
                .then(() => setRemembered(rememberedCount()))
                .catch((error: unknown) => {
                  kernel.log.error("could not forget the remembered document modes", error);
                  setProblem(describe(error));
                });
            }}
          >
            Forget remembered modes
          </button>{" "}
          {remembered === 1
            ? "One document opens the way you last left it."
            : `${String(remembered)} documents open the way you last left them.`}
        </p>
      ) : null}

      {problem ? (
        <p className="docsurface-setting-error" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

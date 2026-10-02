import type { Kernel, Unsubscribe } from "@kernel";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { DocumentMode } from "./api.js";

export interface DefaultModeSectionProps {
  readonly kernel: Kernel;
  readonly modes: () => readonly DocumentMode[];
  readonly onModesChange: (listener: () => void) => Unsubscribe;
  readonly defaultMode: () => string | undefined;
  readonly setDefaultMode: (modeId: string) => Promise<void>;
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
  const writing = useRef(false);

  useEffect(() => onModesChange(() => setAvailable(modes())), [modes, onModesChange]);

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
    <div className="docsurface:flex docsurface:max-w-[48ch] docsurface:flex-col docsurface:gap-2">
      <label className="docsurface:flex docsurface:min-w-0 docsurface:flex-col docsurface:gap-1">
        <span className="docsurface:font-semibold docsurface:text-text">Open documents in</span>
        <select
          className="docsurface:tap-h docsurface:min-w-0 docsurface:max-w-full docsurface:rounded docsurface:border docsurface:border-border-strong docsurface:bg-bg-raised docsurface:px-2 docsurface:text-text docsurface:focus-visible:outline-2 docsurface:focus-visible:outline-offset-2 docsurface:focus-visible:outline-focus"
          value={selected ?? ""}
          onChange={(event) => choose(event.target.value)}
        >
          {available.length === 0 ? <option value="">No modes installed</option> : null}
          {available.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>

      <p className="docsurface:m-0 docsurface:text-sm docsurface:leading-[1.5] docsurface:text-text-muted">
        Used when you open a document you have not switched modes on. Switching modes on
        a document is remembered for that document and wins over this. Some notes open in
        their own mode (a canvas, say) unless you switch them.
      </p>

      {remembered > 0 ? (
        <p className="docsurface:m-0 docsurface:text-sm docsurface:leading-[1.5] docsurface:text-text-muted">
          <button
            type="button"
            className="docsurface:min-h-[calc(var(--ddd-tap-target)-12px)] docsurface:cursor-pointer docsurface:rounded docsurface:border docsurface:border-border-strong docsurface:bg-bg-raised docsurface:px-2 docsurface:text-sm docsurface:text-text docsurface:focus-visible:outline-2 docsurface:focus-visible:outline-offset-2 docsurface:focus-visible:outline-focus"
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
        <p className="docsurface:m-0 docsurface:text-sm docsurface:text-danger" role="alert">
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

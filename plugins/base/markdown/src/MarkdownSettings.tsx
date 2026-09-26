/**
 * Settings → Markdown: how deep `![](doc://…)` embeds nest.
 *
 * One number. 0 turns embedding off (every `![](doc://…)` is a link); the ceiling keeps
 * a chain of embeds from building a page nobody can scroll.
 */

import type { Kernel, SettingsValue } from "@kernel";
import { useEffect, useId, useState, type ReactNode } from "react";

export const EMBED_DEPTH_KEY = "embedDepth";
export const DEFAULT_EMBED_DEPTH = 4;
export const MAX_EMBED_DEPTH = 10;

/** A stored value as a usable depth: whole, 0 to {@link MAX_EMBED_DEPTH}, else the default. */
export function clampEmbedDepth(value: SettingsValue | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_EMBED_DEPTH;
  return Math.min(Math.max(Math.round(value), 0), MAX_EMBED_DEPTH);
}

export function MarkdownSettings({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const id = useId();
  const read = (): number => {
    try {
      return clampEmbedDepth(kernel.settings.get(EMBED_DEPTH_KEY));
    } catch {
      return DEFAULT_EMBED_DEPTH;
    }
  };
  const [depth, setDepth] = useState(read);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  useEffect(() => {
    try {
      return kernel.settings.subscribe(() => setDepth(read()));
    } catch {
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kernel]);

  const choose = (raw: string): void => {
    const next = clampEmbedDepth(Number(raw));
    const previous = depth;
    setDepth(next);
    setProblem(undefined);
    kernel.settings.set(EMBED_DEPTH_KEY, next).catch((error: unknown) => {
      setDepth(previous);
      setProblem(`That could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  return (
    <div className="markdown:flex markdown:max-w-[48ch] markdown:flex-col markdown:gap-2 markdown:font-sans markdown:text-text">
      <label className="markdown:flex markdown:flex-wrap markdown:items-center markdown:gap-3" htmlFor={id}>
        <span className="markdown:font-semibold">Embedded documents, levels deep</span>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_EMBED_DEPTH}
          step={1}
          value={depth}
          onChange={(event) => choose(event.target.value)}
          className="markdown:tap-h markdown:w-[8ch] markdown:rounded markdown:border markdown:border-border-strong markdown:bg-bg-raised markdown:px-2 markdown:text-text markdown:focus-visible:outline-2 markdown:focus-visible:outline-offset-2 markdown:focus-visible:outline-focus"
        />
      </label>
      <p className="markdown:m-0 markdown:text-sm markdown:leading-[1.5] markdown:text-text-muted">
        <code>![](doc://…)</code> shows another document inside this one. A document it
        shows can show another, up to this many levels; past that, and for a document
        already shown above, it is a link. 0 shows every one as a link.
      </p>
      {problem ? (
        <p className="markdown:m-0 markdown:text-sm markdown:text-danger" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

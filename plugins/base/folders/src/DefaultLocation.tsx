import { useId, useState } from "react";
import type { ComponentType, ReactElement } from "react";

import type { NoteSelectProps } from "plugin:search";

export interface DefaultLocationProps {
  readonly label: string;
  readonly hint: string;
  readonly notes: readonly { readonly id: string; readonly path: readonly string[] }[];
  readonly value: string;
  readonly onChange: (id: string) => Promise<void>;
  readonly NoteSelect?: ComponentType<NoteSelectProps>;
}

export function DefaultLocation({ label, hint, notes, value, onChange, NoteSelect }: DefaultLocationProps): ReactElement {
  const id = useId();
  const [pending, setPending] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const current = pending ?? value;

  const choose = (next: string): void => {
    setPending(next);
    setProblem(undefined);
    void onChange(next)
      .catch((cause: unknown) => {
        setProblem(`That could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`);
      })
      .finally(() => setPending(undefined));
  };

  const missing = current !== "" && !notes.some((note) => note.id === current);

  return (
    <div className="folders:flex folders:flex-col folders:gap-3 folders:font-sans folders:text-text">
      {NoteSelect !== undefined ? (
        <div className="folders:flex folders:flex-wrap folders:items-center folders:gap-3">
          <span>{label}</span>
          <div className="folders:min-w-0 folders:flex-1">
            <NoteSelect label={label} value={current} emptyLabel="Root" onChange={choose} />
          </div>
        </div>
      ) : (
        <label className="folders:flex folders:flex-wrap folders:items-center folders:gap-3" htmlFor={id}>
          <span>{label}</span>
          <select
            className="folders:min-h-[var(--ddd-tap-target)] folders:min-w-0 folders:flex-1 folders:rounded folders:border folders:border-border folders:bg-bg folders:px-2 folders:text-text"
            id={id}
            value={current}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">Root</option>
            {missing && <option value={current}>A note that is gone (the root is used meanwhile)</option>}
            {notes.map((note) => (
              <option key={note.id} value={note.id}>
                {note.path.join(" / ")}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="folders:m-0 folders:text-sm folders:text-text-muted">{hint}</p>
      {problem !== undefined ? (
        <p className="folders:m-0 folders:text-sm folders:text-danger" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "New notes go to" / "Files go to" — a note picker for a default location.
 *
 * The note it names may be gone (deleted, or not synced to this device yet). A picker
 * that silently dropped the stored value would file the next note at the root without
 * saying so, so a value that matches nothing is kept in the list, marked, and left
 * selected until someone changes it. New notes land at the root meanwhile.
 *
 * A `<select>` rather than a tree: it is one tab stop, it is a native picker on a phone,
 * and at 390 px it cannot overflow the pane.
 */

import { useId, useState } from "react";
import type { ReactElement } from "react";

export interface DefaultLocationProps {
  readonly label: string;
  /** One quiet line under the control. */
  readonly hint: string;
  /** Every note, with the titles from the root down to it, in the order to list them. */
  readonly notes: readonly { readonly id: string; readonly path: readonly string[] }[];
  /** The stored note id; `""` for the root. */
  readonly value: string;
  /**
   * Store the choice. **Resolves when it is stored and rejects when it is not** — this
   * control shows the difference, so a caller that swallows the failure makes it lie.
   */
  readonly onChange: (id: string) => Promise<void>;
}

export function DefaultLocation({ label, hint, notes, value, onChange }: DefaultLocationProps): ReactElement {
  const id = useId();
  /*
   * Optimistic, and reverted on failure. A settings write is a CRDT splice into a
   * document that may have to be created first, so it can fail: offline at the wrong
   * moment is enough.
   */
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
      // Either way the stored value takes over again.
      .finally(() => setPending(undefined));
  };

  const missing = current !== "" && !notes.some((note) => note.id === current);

  return (
    <div className="folders:flex folders:flex-col folders:gap-3 folders:font-sans folders:text-text">
      <label className="folders:flex folders:flex-wrap folders:items-center folders:gap-3" htmlFor={id}>
        <span>{label}</span>
        <select
          className="folders:min-h-[var(--lm-tap-target)] folders:min-w-0 folders:flex-1 folders:rounded folders:border folders:border-border folders:bg-bg folders:px-2 folders:text-text"
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
      <p className="folders:m-0 folders:text-sm folders:text-text-muted">{hint}</p>
      {problem !== undefined ? (
        <p className="folders:m-0 folders:text-sm folders:text-danger" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

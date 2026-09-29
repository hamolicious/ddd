/**
 * The destination picker: the keyboard-and-touch half of drag and drop.
 *
 * Drag and drop is a mouse gesture — HTML5 DnD does not fire from touch — so every move
 * has a second, pointer-free path that ends in the same list splices: the row's ⋯ menu,
 * a long-press, a right-click or the `M` key opens this inside a `context-menu` sheet,
 * and the picker is an ordinary list of buttons. It also moves many notes at once, for
 * the "Move to folder…" command the document list's Actions button runs.
 */

import { useMemo, useState } from "react";
import type { ReactElement } from "react";

import { isWithin, titlePath, type Hierarchy } from "./hierarchy.js";
import { compareText } from "./tree.js";

export interface MovePickerProps {
  readonly hierarchy: Hierarchy;
  /** What is being moved: none of them, nor anything inside one, can be the destination. */
  readonly subjects: readonly { readonly id: string; readonly title: string }[];
  /** The note to file under; `""` is the root. */
  readonly onChoose: (parent: string) => void;
}

/**
 * Pick a destination from a filtered list of every note, each shown with the titles above
 * it. The root is always the first option and is never filtered away — "take this out of
 * every folder" is the one destination nobody can type the name of.
 */
export function MovePicker({ hierarchy, subjects, onChoose }: MovePickerProps): ReactElement {
  const [query, setQuery] = useState("");
  // Marked only when every subject is already there.
  const parents = new Set(subjects.map((subject) => hierarchy.parentOf.get(subject.id) ?? ""));
  const current = parents.size === 1 ? [...parents][0] : undefined;
  const named = subjects.length === 1 ? (subjects[0]?.title ?? "it") : "them";
  const ids = subjects.map((subject) => subject.id).join("\n");

  const all = useMemo(
    () =>
      [...hierarchy.notes.keys()]
        .filter((id) => !subjects.some((subject) => isWithin(hierarchy, id, subject.id)))
        .map((id) => ({ id, path: titlePath(hierarchy, id) }))
        .sort((left, right) => compareText(left.path.join(" / "), right.path.join(" / "))),
    [hierarchy, ids],
  );

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === "" ? all : all.filter((option) => option.path.join(" / ").toLowerCase().includes(needle));
  }, [all, query]);

  const buttonClasses =
    "folders:tap-h folders:flex folders:w-full folders:flex-col folders:items-start folders:rounded folders:border folders:border-transparent folders:bg-transparent folders:px-2 folders:py-1 folders:text-left folders:hover:border-border folders:hover:bg-bg-subtle folders:aria-current:bg-accent-subtle";

  return (
    <div className="folders:flex folders:min-h-0 folders:flex-col folders:gap-3">
      <label>
        <span className="folders:sr-only">Filter notes</span>
        <input
          className="folders:min-h-[var(--lm-tap-target)] folders:w-full folders:rounded folders:border folders:border-border folders:bg-bg folders:px-3 folders:text-text"
          type="text"
          value={query}
          placeholder="Filter notes…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <ul className="folders:m-0 folders:flex folders:max-h-[50dvh] folders:list-none folders:flex-col folders:gap-1 folders:overflow-y-auto folders:p-0 folders:sm:max-h-[22rem]">
        <li>
          <button
            type="button"
            className={buttonClasses}
            onClick={() => onChoose("")}
            aria-current={current === "" ? "true" : undefined}
          >
            <span>Root</span>
            <span className="folders:text-xs folders:text-text-muted">not inside any note</span>
          </button>
        </li>
        {options.map((option) => (
          <li key={option.id}>
            <button
              type="button"
              className={buttonClasses}
              onClick={() => onChoose(option.id)}
              aria-current={option.id === current ? "true" : undefined}
            >
              <span>{option.path[option.path.length - 1]}</span>
              {option.path.length > 1 && (
                <span className="folders:text-xs folders:text-text-muted">{option.path.slice(0, -1).join(" / ")}</span>
              )}
            </button>
          </li>
        ))}
        {options.length === 0 && (
          <li className="folders:p-3 folders:text-sm folders:text-text-muted">
            No note matches “{query.trim()}”. Move {named} to the root instead.
          </li>
        )}
      </ul>
    </div>
  );
}

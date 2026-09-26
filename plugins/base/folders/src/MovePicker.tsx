/**
 * The folder picker: the keyboard-and-touch half of drag and drop.
 *
 * Drag and drop is a mouse gesture — HTML5 DnD does not fire from touch — so every move
 * in this plugin has a second, pointer-free path that ends in the same `fm.path` splice
 * (SPEC §3.3): the row's ⋯ menu, a long-press, a right-click or the `M` key opens this
 * inside a `context-menu` sheet, and the picker is an ordinary list of buttons.
 */

import { useMemo, useState } from "react";
import type { ReactElement } from "react";

import { isWithin, nameOf, normalizePath } from "./path.js";

export interface MovePickerProps {
  /** Every folder in the workspace, already sorted. */
  readonly folders: readonly string[];
  /** What is being moved — shown, and excluded from the list when it is a folder. */
  readonly subject: string;
  /** The folder it is in now; marked so a no-op choice is visibly a no-op. */
  readonly currentFolder: string;
  /** Set when a folder is moving: it and its descendants cannot be its own destination. */
  readonly excludeSubtree?: string;
  readonly onChoose: (folder: string) => void;
}

/**
 * The keyboard-and-touch half of drag and drop: pick a destination from a filtered list.
 *
 * Root is always the first option and is never filtered away — "take this out of its
 * folder" is the one destination a user cannot type the name of.
 */
export function MovePicker({
  folders,
  subject,
  currentFolder,
  excludeSubtree,
  onChoose,
}: MovePickerProps): ReactElement {
  const [query, setQuery] = useState("");

  const options = useMemo(() => {
    const exclude = excludeSubtree === undefined ? undefined : normalizePath(excludeSubtree);
    const needle = query.trim().toLowerCase();
    return folders.filter((folder) => {
      if (exclude !== undefined && isWithin(folder, exclude)) return false;
      if (needle === "") return true;
      return folder.toLowerCase().includes(needle);
    });
  }, [excludeSubtree, folders, query]);

  return (
    <div className="folders:flex folders:min-h-0 folders:flex-col folders:gap-3">
      <label>
        <span className="folders:sr-only">Filter folders</span>
        <input
          className="folders:min-h-[var(--lm-tap-target)] folders:w-full folders:rounded folders:border folders:border-border folders:bg-bg folders:px-3 folders:text-text"
          type="text"
          value={query}
          placeholder="Filter folders…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      <ul className="folders:m-0 folders:flex folders:max-h-[50dvh] folders:list-none folders:flex-col folders:gap-1 folders:overflow-y-auto folders:p-0 folders:sm:max-h-[22rem]">
        <li>
          <button
            type="button"
            className="folders:tap-h folders:flex folders:w-full folders:flex-col folders:items-start folders:rounded folders:border folders:border-transparent folders:bg-transparent folders:px-2 folders:py-1 folders:text-left folders:hover:border-border folders:hover:bg-bg-subtle folders:aria-current:bg-accent-subtle"
            onClick={() => onChoose("")}
            aria-current={currentFolder === "" ? "true" : undefined}
          >
            <span>Root</span>
            <span className="folders:font-mono folders:text-xs folders:text-text-muted">no folder</span>
          </button>
        </li>
        {options.map((folder) => (
          <li key={folder}>
            <button
              type="button"
              className="folders:tap-h folders:flex folders:w-full folders:flex-col folders:items-start folders:rounded folders:border folders:border-transparent folders:bg-transparent folders:px-2 folders:py-1 folders:text-left folders:hover:border-border folders:hover:bg-bg-subtle folders:aria-current:bg-accent-subtle"
              onClick={() => onChoose(folder)}
              aria-current={folder === currentFolder ? "true" : undefined}
            >
              <span>{nameOf(folder)}</span>
              <span className="folders:font-mono folders:text-xs folders:text-text-muted">{folder}</span>
            </button>
          </li>
        ))}
        {options.length === 0 && (
          <li className="folders:p-3 folders:text-sm folders:text-text-muted">
            No folder matches “{query.trim()}”. Move {subject} to Root, or close this and use
            “New folder”.
          </li>
        )}
      </ul>
    </div>
  );
}

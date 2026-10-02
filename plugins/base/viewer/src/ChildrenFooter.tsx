/**
 * The notes filed inside this one, under everything the note says.
 *
 * The tree is `folders`' (an optional plugin): without it, or for a note with nothing
 * inside, there is no footer at all. The list follows the tree live — a note filed or
 * moved elsewhere shows up or goes at once — and each entry is the same link the body
 * draws for `[](doc://…)`: its title, colour and icon. Each is also marked `ddd/document`, so
 * its menu is a note's menu wherever it is right-clicked.
 */

import { useCallback, useSyncExternalStore, type ReactNode } from "react";

import type { Folders } from "plugin:folders";

import { target } from "../../_shared/target.js";

import { columnClasses } from "./width.js";

export type ChildrenSource = Pick<Folders, "childrenOf" | "onChange">;

const NO_CHILDREN = "";

export function ChildrenFooter({
  id,
  folders,
  renderDocLink,
  divided = true,
  fullWidth = false,
}: {
  readonly id: string;
  /** A rule between the body and the list; `false` when the note has no body to divide from. */
  readonly divided?: boolean;
  /** The note's `full-width` flag: the list shares the body's column. */
  readonly fullWidth?: boolean;
  readonly folders: ChildrenSource;
  readonly renderDocLink: (documentId: string) => ReactNode;
}): ReactNode {
  // A string snapshot: the same children are the same answer, however the tree rebuilt.
  const snapshot = useCallback(() => folders.childrenOf(id).join("\n") || NO_CHILDREN, [folders, id]);
  const joined = useSyncExternalStore(folders.onChange, snapshot, snapshot);
  if (joined === NO_CHILDREN) return null;
  const children = joined.split("\n");

  return (
    <footer
      className={`viewer-children viewer:mx-auto viewer:w-full viewer:min-w-0 viewer:pb-6 viewer:compact:pb-4 ${columnClasses(fullWidth)}`}
      aria-labelledby={`viewer-children-${id}`}
    >
      <div className={divided ? "viewer:border-t viewer:border-border viewer:pt-3" : ""}>
        <h2
          id={`viewer-children-${id}`}
          className="viewer:m-0 viewer:mb-2 viewer:text-sm viewer:font-semibold viewer:uppercase viewer:tracking-[0.04em] viewer:text-text-muted"
        >
          Inside this note <span className="viewer:font-normal viewer:tabular-nums">{children.length}</span>
        </h2>
        <ul className="viewer:m-0 viewer:flex viewer:list-none viewer:flex-col viewer:gap-0.5 viewer:p-0">
          {children.map((child) => (
            <li key={child} className="viewer:flex viewer:min-h-[calc(var(--ddd-tap-target)*0.75)] viewer:min-w-0 viewer:items-center viewer:break-words" {...target("ddd/document", child)}>
              {renderDocLink(child)}
            </li>
          ))}
        </ul>
      </div>
    </footer>
  );
}

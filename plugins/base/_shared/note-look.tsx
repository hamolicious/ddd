import { useEffect, useState } from "react";
import type { CSSProperties, ReactElement } from "react";

import type { Folders, NoteLook } from "plugin:folders";

export type Looks = Pick<Folders, "look" | "onLookChange">;

export function lookOf(looks: Looks | undefined, id: string): NoteLook | undefined {
  const look = looks?.look(id);
  return look && (look.background || look.color || look.icon !== undefined) ? look : undefined;
}

export function lookStyle(look: NoteLook | undefined): CSSProperties | undefined {
  if (!look || (!look.background && !look.color)) return undefined;
  return {
    ...(look.background ? { background: look.background } : {}),
    ...(look.color ? { color: look.color } : {}),
  };
}

export function useLookChanges(looks: Looks | undefined): void {
  const [, setRevision] = useState(0);
  useEffect(() => looks?.onLookChange(() => setRevision((value) => value + 1)), [looks]);
}

const ROW: CSSProperties = { display: "flex", minWidth: 0, alignItems: "center", gap: "0.25rem" };
const ICON: CSSProperties = { display: "inline-flex", flexShrink: 0, width: "1em", height: "1em" };
const TEXT: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const ROW_WRAP: CSSProperties = { ...ROW, alignItems: "flex-start" };
const ICON_WRAP: CSSProperties = { ...ICON, height: "1lh", alignItems: "center" };
const TEXT_WRAP: CSSProperties = { minWidth: 0, overflowWrap: "anywhere" };

export function NoteLabel({
  title,
  look,
  wrap = false,
}: {
  readonly title: string;
  readonly look: NoteLook | undefined;
  readonly wrap?: boolean;
}): ReactElement {
  return (
    <span style={wrap ? ROW_WRAP : ROW}>
      {look?.icon !== undefined && (
        <span aria-hidden="true" style={wrap ? ICON_WRAP : ICON}>
          {look.icon}
        </span>
      )}
      <span style={wrap ? TEXT_WRAP : TEXT}>{title}</span>
    </span>
  );
}

/**
 * Marking an element as something with a context menu (`context-menu.addAction`).
 *
 * A component spreads `target(...)` onto the element that *is* the thing: a tree row, a
 * table row, a kanban card. The context-menu plugin finds it under the pointer and asks
 * every plugin that offers actions for that type. Plain `data-*` attributes, so the mark
 * crosses plugin boundaries and needs no React context.
 */

/**
 * An element marked with `target(...)`, as the context menu reads it back. Defined here, not
 * in `context-menu`, because the plugins that mark elements (`shell-ui` among them) sit
 * below `context-menu` in the dependency graph; `context-menu` re-exports it.
 */
export interface Target {
  readonly type: string;
  /** `data-lm-target-id`; `""` when the element has none. */
  readonly id: string;
  /** `data-lm-target-label`: the menu title, or its section's. */
  readonly label?: string;
  readonly element: HTMLElement;
}

/** How long a touch rests before it is a long press: the menu's, and a drag's that starts the same way. */
export const LONG_PRESS_MS = 500;

export const TARGET_ATTR = "data-lm-target";
export const TARGET_ID_ATTR = "data-lm-target-id";
export const TARGET_LABEL_ATTR = "data-lm-target-label";
/** `"release"`: a long press opens the menu on release, not on the timer (a card that also drags). */
export const PRESS_ATTR = "data-lm-press";
/** `"false"`: only a target when nothing marked is nearer (blank space, not what is on it). */
export const ENCLOSING_ATTR = "data-lm-target-enclosing";

export interface TargetOptions {
  /** The menu title (innermost) or the section title (enclosing). */
  readonly label?: string;
  /** More types for the same element and id: a kanban card is also `kanban/card`. */
  readonly types?: readonly string[];
  /** Long press opens on release, when the element also starts a drag on a long press. */
  readonly pressOnRelease?: boolean;
  /**
   * `false`: a target only when it is the nearest one, so its items are not added under
   * those of everything on it. Blank space in a list is the list; a row in it is a row.
   */
  readonly enclosing?: boolean;
}

export type TargetAttributes = Readonly<Record<string, string | undefined>>;

/** The attributes that mark an element as a `type` with this `id`. */
export function target(type: string, id = "", options: TargetOptions = {}): TargetAttributes {
  return {
    [TARGET_ATTR]: [type, ...(options.types ?? [])].join(" "),
    [TARGET_ID_ATTR]: id,
    [TARGET_LABEL_ATTR]: options.label,
    [PRESS_ATTR]: options.pressOnRelease ? "release" : undefined,
    [ENCLOSING_ATTR]: options.enclosing === false ? "false" : undefined,
  };
}

/** Every marked element from `from` outwards, innermost first. */
export function markedElements(from: Element | null): HTMLElement[] {
  const found: HTMLElement[] = [];
  let at = from?.closest<HTMLElement>(`[${TARGET_ATTR}]`) ?? null;
  while (at) {
    if (found.length === 0 || at.getAttribute(ENCLOSING_ATTR) !== "false") found.push(at);
    at = at.parentElement?.closest<HTMLElement>(`[${TARGET_ATTR}]`) ?? null;
  }
  return found;
}

/** The targets of one marked element, one per listed type. */
export function targetsOf(element: HTMLElement): Target[] {
  const types = (element.getAttribute(TARGET_ATTR) ?? "").split(/\s+/).filter(Boolean);
  const id = element.getAttribute(TARGET_ID_ATTR) ?? "";
  const label = element.getAttribute(TARGET_LABEL_ATTR) ?? undefined;
  return types.map((type) => ({ type, id, label, element }));
}

/** Every target from `from` outwards, innermost first. */
export function readChain(from: Element | null): Target[] {
  return markedElements(from).flatMap(targetsOf);
}

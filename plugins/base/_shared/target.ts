export interface Target {
  readonly type: string;
  readonly id: string;
  readonly label?: string;
  readonly element: HTMLElement;
}

export const LONG_PRESS_MS = 500;

export const TARGET_ATTR = "data-ddd-target";
export const TARGET_ID_ATTR = "data-ddd-target-id";
export const TARGET_LABEL_ATTR = "data-ddd-target-label";
export const PRESS_ATTR = "data-ddd-press";
export const ENCLOSING_ATTR = "data-ddd-target-enclosing";

export interface TargetOptions {
  readonly label?: string;
  readonly types?: readonly string[];
  readonly pressOnRelease?: boolean;
  readonly enclosing?: boolean;
}

export type TargetAttributes = Readonly<Record<string, string | undefined>>;

export function target(type: string, id = "", options: TargetOptions = {}): TargetAttributes {
  return {
    [TARGET_ATTR]: [type, ...(options.types ?? [])].join(" "),
    [TARGET_ID_ATTR]: id,
    [TARGET_LABEL_ATTR]: options.label,
    [PRESS_ATTR]: options.pressOnRelease ? "release" : undefined,
    [ENCLOSING_ATTR]: options.enclosing === false ? "false" : undefined,
  };
}

export function markedElements(from: Element | null): HTMLElement[] {
  const found: HTMLElement[] = [];
  let at = from?.closest<HTMLElement>(`[${TARGET_ATTR}]`) ?? null;
  while (at) {
    if (found.length === 0 || at.getAttribute(ENCLOSING_ATTR) !== "false") found.push(at);
    at = at.parentElement?.closest<HTMLElement>(`[${TARGET_ATTR}]`) ?? null;
  }
  return found;
}

export function targetsOf(element: HTMLElement): Target[] {
  const types = (element.getAttribute(TARGET_ATTR) ?? "").split(/\s+/).filter(Boolean);
  const id = element.getAttribute(TARGET_ID_ATTR) ?? "";
  const label = element.getAttribute(TARGET_LABEL_ATTR) ?? undefined;
  return types.map((type) => ({ type, id, label, element }));
}

export function readChain(from: Element | null): Target[] {
  return markedElements(from).flatMap(targetsOf);
}

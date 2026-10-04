import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";

import { isSubmenu } from "./api.js";
import type { DialogRequest, MenuAction, MenuItem, MenuRequest, MenuSubmenu, ModalRequest, ModalResult, SheetRequest } from "./api.js";
import { useCompact } from "../../_shared/compact.js";

import { ModalForm } from "./Modal.js";

const FOCUSABLE = 'button:not([disabled]), input, select, textarea, [href], [tabindex]:not([tabindex="-1"])';
const GAP = 4;
const POINT_FRESH_MS = 1500;

let lastPoint: { readonly x: number; readonly y: number; readonly at: number } | undefined;
if (typeof document !== "undefined") {
  const remember = (event: MouseEvent): void => {
    lastPoint = { x: event.clientX, y: event.clientY, at: Date.now() };
  };
  document.addEventListener("pointerdown", remember, true);
  document.addEventListener("contextmenu", remember, true);
}

function fallbackBox(): { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number } {
  if (lastPoint && Date.now() - lastPoint.at < POINT_FRESH_MS) {
    return { top: lastPoint.y, bottom: lastPoint.y, left: lastPoint.x, right: lastPoint.x };
  }
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused !== document.body) {
    const box = focused.getBoundingClientRect();
    if (box.width > 0 || box.height > 0) return { top: box.top, bottom: box.bottom, left: box.left, right: box.left };
  }
  const middle = innerWidth / 2;
  return { top: innerHeight * 0.15, bottom: innerHeight * 0.15, left: middle, right: middle };
}

export type Open =
  | { readonly kind: "menu"; readonly request: MenuRequest }
  | { readonly kind: "sheet"; readonly request: SheetRequest }
  | { readonly kind: "dialog"; readonly request: DialogRequest }
  | {
      readonly kind: "modal";
      readonly request: ModalRequest & { readonly onClose: () => void };
      readonly settle: (result: ModalResult) => void;
    };

function panelSize(open: Open): string {
  if (open.kind !== "dialog") return "ctxmenu:sm:max-h-[40rem] ctxmenu:sm:max-w-[30rem]";
  return open.request.size === "large"
    ? "ctxmenu:h-[85dvh] ctxmenu:sm:h-[min(48rem,calc(100dvh-4rem))] ctxmenu:sm:max-h-none ctxmenu:sm:max-w-[min(64rem,calc(100vw-4rem))]"
    : "ctxmenu:sm:max-h-[40rem] ctxmenu:sm:max-w-[44rem]";
}

export function MenuHost({
  open,
  close,
}: {
  readonly open: Open | undefined;
  readonly close: () => void;
}): ReactNode {
  if (!open) return null;
  return <Panel key={keyOf(open)} open={open} close={close} />;
}

const keys = new WeakMap<object, number>();
let next = 0;
function keyOf(open: Open): number {
  let key = keys.get(open.request);
  if (key === undefined) {
    key = next++;
    keys.set(open.request, key);
  }
  return key;
}

function Panel({ open, close }: { readonly open: Open; readonly close: () => void }): ReactElement {
  const compact = useCompact();
  const panel = useRef<HTMLDivElement | null>(null);
  const { anchor, title, description } = open.request;
  const popover = open.kind !== "modal" && open.kind !== "dialog" && !compact;
  const anchored = anchor instanceof HTMLElement && anchor.isConnected;
  const [position, setPosition] = useState<{ top: number; left: number } | undefined>(undefined);
  const [fallback] = useState(fallbackBox);

  useLayoutEffect(() => {
    if (!popover || !panel.current) return;
    const place = (): void => {
      const box = anchored && anchor ? anchor.getBoundingClientRect() : undefined;
      const own = panel.current?.getBoundingClientRect();
      const width = own?.width ?? 0;
      const height = own?.height ?? 0;
      if (!box) {
        const left = Math.max(GAP, Math.min(fallback.left, innerWidth - width - GAP));
        const below = fallback.bottom + GAP;
        const top = below + height > innerHeight - GAP ? Math.max(GAP, fallback.top - height - GAP) : below;
        setPosition({ top, left });
        return;
      }
      const left = Math.max(GAP, Math.min(box.right - width, innerWidth - width - GAP));
      const below = box.bottom + GAP;
      const top = below + height > innerHeight - GAP ? Math.max(GAP, box.top - height - GAP) : below;
      setPosition({ top, left });
    };
    place();
    addEventListener("resize", place);
    const growth = new ResizeObserver(place);
    growth.observe(panel.current);
    return () => {
      removeEventListener("resize", place);
      growth.disconnect();
    };
  }, [anchor, anchored, popover, fallback]);

  const shown = !popover || position !== undefined;
  useEffect(() => {
    if (!shown) return undefined;
    const restore = anchor ?? document.activeElement;
    const target =
      panel.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      panel.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => {
      if (restore instanceof HTMLElement && restore.isConnected) restore.focus();
    };
  }, [anchor, shown]);

  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [close]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const level = active?.closest<HTMLElement>("[data-menu-level]") ?? panel.current;
    const focusable = [...(level?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
      (each) => each.closest("[data-menu-level]") === level || level === panel.current,
    );
    if (focusable.length === 0) return;
    const index = focusable.indexOf(document.activeElement as HTMLElement);
    const move = (to: number): void => {
      event.preventDefault();
      focusable[(to + focusable.length) % focusable.length]?.focus();
    };
    const list = open.kind !== "modal" && open.kind !== "dialog";
    if (!list && event.key !== "Tab") return;
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(focusable.length - 1);
    else if (event.key === "Tab") {
      if (event.shiftKey && index <= 0) move(focusable.length - 1);
      else if (!event.shiftKey && index === focusable.length - 1) move(0);
    }
  }, [open.kind]);

  const body =
    open.kind === "menu" ? (
      <MenuSections request={open.request} close={close} drill={!popover} />
    ) : open.kind === "modal" ? (
      <ModalForm request={open.request} settle={open.settle} close={close} />
    ) : open.kind === "dialog" ? (
      <div className="ctxmenu:px-2">{open.request.render(close)}</div>
    ) : (
      open.request.render(close)
    );

  const width = open.kind === "sheet" ? "ctxmenu:max-w-[min(30rem,calc(100vw-1rem))]" : "ctxmenu:max-w-[min(22rem,calc(100vw-1rem))]";
  const panelClasses = popover
    ? `context-menu ctxmenu:fixed ctxmenu:flex ctxmenu:max-h-[min(70vh,32rem)] ctxmenu:min-w-[14rem] ctxmenu:flex-col ctxmenu:gap-1 ctxmenu:overflow-y-auto ctxmenu:rounded-lg ctxmenu:border ctxmenu:border-border ctxmenu:bg-bg-raised ctxmenu:p-1 ctxmenu:font-sans ctxmenu:text-text ctxmenu:shadow-2 ${width}`
    : `context-menu ctxmenu:flex ctxmenu:max-h-[85dvh] ctxmenu:w-full ctxmenu:flex-col ctxmenu:gap-3 ctxmenu:overflow-y-auto ctxmenu:rounded-t-lg ctxmenu:border ctxmenu:border-b-0 ctxmenu:border-border ctxmenu:bg-bg-raised ctxmenu:p-4 ctxmenu:pb-[calc(var(--ddd-space)*1.5+env(safe-area-inset-bottom,0px))] ctxmenu:font-sans ctxmenu:text-text ctxmenu:shadow-2 ctxmenu:sm:rounded-lg ctxmenu:sm:border-b ctxmenu:sm:pb-4 ${panelSize(open)}`;

  return createPortal(
    <div
      className={`ctxmenu:fixed ctxmenu:inset-0 ctxmenu:z-[1000] ${popover ? "" : "ctxmenu:flex ctxmenu:items-end ctxmenu:justify-center ctxmenu:bg-bg-overlay ctxmenu:sm:items-center ctxmenu:sm:p-8"}`}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        close();
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panel}
        className={panelClasses}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={
          popover
            ? position
              ? { top: position.top, left: position.left }
              : { visibility: "hidden", top: 0, left: 0 }
            : undefined
        }
      >
        {popover ? (
          open.kind === "sheet" ? (
            <p className="ctxmenu:m-0 ctxmenu:px-2 ctxmenu:pt-1 ctxmenu:text-sm ctxmenu:font-semibold ctxmenu:text-text-muted">{title}</p>
          ) : null
        ) : (
          <header className="ctxmenu:flex ctxmenu:items-center ctxmenu:gap-3">
            <h2 className="ctxmenu:m-0 ctxmenu:min-w-0 ctxmenu:flex-1 ctxmenu:break-words ctxmenu:text-lg">{title}</h2>
            <button
              type="button"
              className="ctxmenu:tap ctxmenu:shrink-0 ctxmenu:rounded ctxmenu:border ctxmenu:border-transparent ctxmenu:bg-transparent ctxmenu:text-text-muted ctxmenu:hover:border-border ctxmenu:hover:text-text"
              aria-label="Close"
              onClick={close}
            >
              ✕
            </button>
          </header>
        )}
        {description ? <p className="ctxmenu:m-0 ctxmenu:px-2 ctxmenu:text-sm ctxmenu:text-text-muted">{description}</p> : null}
        {body}
      </div>
    </div>,
    document.body,
  );
}

const ENTRY =
  "ctxmenu:tap-h ctxmenu:flex ctxmenu:w-full ctxmenu:items-center ctxmenu:gap-2 ctxmenu:rounded-md ctxmenu:border-0 ctxmenu:bg-transparent ctxmenu:px-3 ctxmenu:py-1 ctxmenu:text-left ctxmenu:hover:bg-bg-subtle ctxmenu:focus-visible:bg-bg-subtle ctxmenu:disabled:opacity-50 ctxmenu:aria-expanded:bg-bg-subtle";

const FLYOUT =
  "context-menu-flyout ctxmenu:fixed ctxmenu:z-10 ctxmenu:flex ctxmenu:max-h-[min(70vh,32rem)] ctxmenu:min-w-[12rem] ctxmenu:max-w-[min(22rem,calc(100vw-1rem))] ctxmenu:flex-col ctxmenu:overflow-y-auto ctxmenu:rounded-lg ctxmenu:border ctxmenu:border-border ctxmenu:bg-bg-raised ctxmenu:p-1 ctxmenu:font-sans ctxmenu:text-text ctxmenu:shadow-2";

const HOVER_MS = 120;
const FLYOUT_OVERLAP = 4;

type Choose = (item: MenuAction) => void;

function focusFirstIn(element: HTMLElement | null): void {
  element?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
}

function MenuSections({
  request,
  close,
  drill,
}: {
  readonly request: MenuRequest;
  readonly close: () => void;
  readonly drill: boolean;
}): ReactElement {
  const [trail, setTrail] = useState<readonly MenuSubmenu[]>([]);
  const level = useRef<HTMLDivElement | null>(null);
  const moved = useRef(false);
  const choose: Choose = (item) => {
    close();
    item.run();
  };
  const enter = drill
    ? (submenu: MenuSubmenu): void => {
        moved.current = true;
        setTrail([...trail, submenu]);
      }
    : undefined;

  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    focusFirstIn(level.current);
  }, [trail]);

  const current = trail[trail.length - 1];
  if (current) {
    const back = (): void => {
      moved.current = true;
      setTrail(trail.slice(0, -1));
    };
    return (
      <div ref={level} className="ctxmenu:flex ctxmenu:flex-col ctxmenu:gap-1" data-menu-level="" role="menu" aria-label={current.label}>
        <button
          type="button"
          className={`${ENTRY} ctxmenu:text-text-muted`}
          onClick={back}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft") return;
            event.preventDefault();
            back();
          }}
        >
          <span aria-hidden="true" className="ctxmenu:flex ctxmenu:w-4 ctxmenu:shrink-0 ctxmenu:justify-center">‹</span>
          <span>Back to {trail[trail.length - 2]?.label ?? request.title}</span>
        </button>
        <p className="ctxmenu:m-0 ctxmenu:border-t ctxmenu:border-border ctxmenu:px-3 ctxmenu:pb-0.5 ctxmenu:pt-1.5 ctxmenu:text-xs ctxmenu:font-semibold ctxmenu:uppercase ctxmenu:tracking-[0.04em] ctxmenu:text-text-muted">
          {current.label}
        </p>
        <Entries items={current.items} choose={choose} enter={enter} />
      </div>
    );
  }

  return (
    <div ref={level} className="ctxmenu:flex ctxmenu:flex-col ctxmenu:gap-1" data-menu-level="" role="menu" aria-label={request.title}>
      {request.sections.map((section, index) => (
        <div key={section.title ?? index} role="group" aria-label={section.title} className={index > 0 ? "ctxmenu:border-t ctxmenu:border-border ctxmenu:pt-1" : ""}>
          {section.title ? (
            <p className="ctxmenu:m-0 ctxmenu:px-3 ctxmenu:pb-0.5 ctxmenu:pt-1.5 ctxmenu:text-xs ctxmenu:font-semibold ctxmenu:uppercase ctxmenu:tracking-[0.04em] ctxmenu:text-text-muted">
              {section.title}
            </p>
          ) : null}
          <Entries items={section.items} choose={choose} enter={enter} />
        </div>
      ))}
    </div>
  );
}

function Entries({
  items,
  choose,
  enter,
}: {
  readonly items: readonly MenuItem[];
  readonly choose: Choose;
  readonly enter: ((submenu: MenuSubmenu) => void) | undefined;
}): ReactElement {
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const settle = (id: string | undefined): void => {
    clearTimeout(timer.current);
    setOpenId(id);
  };
  const hover = (id: string | undefined): void => {
    if (enter) return;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpenId(id), HOVER_MS);
  };
  return (
    <ul role="none" className="ctxmenu:m-0 ctxmenu:flex ctxmenu:list-none ctxmenu:flex-col ctxmenu:p-0">
      {items.map((item) => (
        <li key={item.id} role="none" onMouseEnter={() => hover(isSubmenu(item) ? item.id : undefined)}>
          {isSubmenu(item) ? (
            <SubmenuEntry
              item={item}
              open={openId === item.id}
              setOpen={(open) => settle(open ? item.id : undefined)}
              choose={choose}
              enter={enter}
            />
          ) : (
            <ActionEntry item={item} choose={choose} />
          )}
        </li>
      ))}
    </ul>
  );
}

function EntryLabel({ item }: { readonly item: MenuItem }): ReactElement {
  return (
    <>
      {item.icon === undefined ? null : (
        <span aria-hidden="true" className="ctxmenu:flex ctxmenu:w-4 ctxmenu:shrink-0 ctxmenu:justify-center">
          {item.icon}
        </span>
      )}
      <span className="ctxmenu:flex ctxmenu:min-w-0 ctxmenu:flex-1 ctxmenu:flex-col">
        <span>{item.label}</span>
        {item.hint ? <small className="ctxmenu:text-text-muted">{item.hint}</small> : null}
      </span>
    </>
  );
}

function ActionEntry({ item, choose }: { readonly item: MenuAction; readonly choose: Choose }): ReactElement {
  return (
    <button
      type="button"
      role={item.checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={item.checked}
      disabled={item.disabled}
      className={`${ENTRY} ${item.danger ? "ctxmenu:text-danger" : "ctxmenu:text-text"}`}
      onClick={() => choose(item)}
    >
      {item.checked === undefined ? null : (
        <span aria-hidden="true" className="ctxmenu:w-4 ctxmenu:shrink-0 ctxmenu:text-accent">
          {item.checked ? "✓" : ""}
        </span>
      )}
      <EntryLabel item={item} />
    </button>
  );
}

function SubmenuEntry({
  item,
  open,
  setOpen,
  choose,
  enter,
}: {
  readonly item: MenuSubmenu;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly choose: Choose;
  readonly enter: ((submenu: MenuSubmenu) => void) | undefined;
}): ReactElement {
  const button = useRef<HTMLButtonElement | null>(null);
  const focusInside = useRef(false);
  const show = (): void => {
    if (enter) {
      enter(item);
      return;
    }
    focusInside.current = true;
    if (open) focusFirstIn(document.getElementById(flyoutId(item)));
    else setOpen(true);
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={enter ? undefined : open}
        aria-controls={open ? flyoutId(item) : undefined}
        disabled={item.disabled}
        className={`${ENTRY} ctxmenu:text-text`}
        onClick={show}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          event.stopPropagation();
          show();
        }}
      >
        <EntryLabel item={item} />
        <span aria-hidden="true" className="ctxmenu:shrink-0 ctxmenu:text-text-muted">
          ›
        </span>
      </button>
      {open && !enter ? (
        <Flyout
          anchor={button}
          submenu={item}
          choose={choose}
          focusInside={focusInside}
          dismiss={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

const flyoutIds = new WeakMap<MenuSubmenu, string>();
let flyoutCount = 0;
function flyoutId(submenu: MenuSubmenu): string {
  let id = flyoutIds.get(submenu);
  if (id === undefined) {
    id = `ctxmenu-flyout-${String((flyoutCount += 1))}`;
    flyoutIds.set(submenu, id);
  }
  return id;
}

function Flyout({
  anchor,
  submenu,
  choose,
  focusInside,
  dismiss,
}: {
  readonly anchor: { readonly current: HTMLElement | null };
  readonly submenu: MenuSubmenu;
  readonly choose: Choose;
  readonly focusInside: { current: boolean };
  readonly dismiss: () => void;
}): ReactElement {
  const box = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | undefined>(undefined);

  useLayoutEffect(() => {
    const place = (): void => {
      const from = anchor.current?.getBoundingClientRect();
      const own = box.current?.getBoundingClientRect();
      if (!from || !own) return;
      const right = from.right - FLYOUT_OVERLAP;
      const left = right + own.width <= innerWidth - GAP ? right : Math.max(GAP, from.left - own.width + FLYOUT_OVERLAP);
      const top = Math.max(GAP, Math.min(from.top - GAP, innerHeight - own.height - GAP));
      setPosition({ top, left });
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [anchor]);

  useEffect(() => {
    if (!position || !focusInside.current) return;
    focusInside.current = false;
    focusFirstIn(box.current);
  }, [position, focusInside]);

  return (
    <div
      ref={box}
      id={flyoutId(submenu)}
      className={FLYOUT}
      role="menu"
      aria-label={submenu.label}
      data-menu-level=""
      style={position ? { top: position.top, left: position.left } : { visibility: "hidden", top: 0, left: 0 }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        dismiss();
      }}
    >
      <Entries items={submenu.items} choose={choose} enter={undefined} />
    </div>
  );
}

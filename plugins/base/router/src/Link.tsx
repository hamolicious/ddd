/**
 * The in-app link.
 *
 * It is a real `<a href="#/…">`, so middle-click, ⌘-click and "copy link address"
 * all behave, and a click with no modifier is routed through the History API
 * instead — one code path for navigation, whether it came from a link, a command or
 * the back button.
 *
 * `aria-current="page"` is set when the link points at the current path, which is
 * why the component subscribes: a nav list has to restyle itself when navigation
 * happens somewhere else.
 */

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

import { fullPath } from "./match.js";

export interface LinkProps {
  /** A concrete path (`/doc/01J…`), not a pattern. Build it with `router.href`. */
  readonly to: string;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly title?: string;
  /** Replace the current history entry instead of pushing one. */
  readonly replace?: boolean;
  /** Set `aria-current="page"` when `to` is the current path. Default `true`. */
  readonly current?: boolean;
  readonly onNavigate?: () => void;
}

export interface LinkRouter {
  current(): string;
  onChange(listener: (path: string) => void): () => void;
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  url(path: string): string;
}

export function createLink(router: LinkRouter): (props: LinkProps) => ReactNode {
  function Link({
    to,
    children,
    className,
    title,
    replace,
    current = true,
    onNavigate,
  }: LinkProps): ReactNode {
    const [path, setPath] = useState<string>(() => router.current());
    useEffect(() => router.onChange(setPath), []);
    // Compared with the query included: two folder links differ only there.
    const active = current && fullPath(path) === fullPath(to);

    const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
      // Anything that means "somewhere else" — a new tab, a new window, a download —
      // stays the browser's business.
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      router.navigate(to, replace === true ? { replace: true } : undefined);
      onNavigate?.();
    };

    return (
      <a
        href={router.url(to)}
        onClick={onClick}
        className={`${active ? "router:font-semibold" : ""}${className === undefined ? "" : ` ${className}`}`.trim()}
        {...(title !== undefined ? { title } : {})}
        {...(active ? { "aria-current": "page" as const } : {})}
      >
        {children}
      </a>
    );
  }
  Link.displayName = "router:Link";
  return Link;
}

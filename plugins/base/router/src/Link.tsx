import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

import type { LinkProps } from "./api.js";

import { fullPath } from "./match.js";

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
    const active = current && fullPath(path) === fullPath(to);

    const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
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

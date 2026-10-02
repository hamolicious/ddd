import type { ReactNode } from "react";

import type { Unsubscribe } from "@kernel";

export interface Route {
  readonly path: string;
  readonly view: string;
  readonly order?: number;
}

export interface LinkProps {
  readonly to: string;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly title?: string;
  readonly replace?: boolean;
  readonly current?: boolean;
  readonly onNavigate?: () => void;
}

export interface RouteMatch {
  readonly view: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface Router {
  readonly navigate: (path: string, options?: { readonly replace?: boolean }) => void;
  readonly current: () => string;
  readonly query: () => URLSearchParams;
  readonly match: (path: string) => RouteMatch | undefined;
  readonly onChange: (listener: (path: string) => void) => Unsubscribe;
  readonly href: (pattern: string, params?: Readonly<Record<string, string>>) => string;
  readonly url: (path: string) => string;
  readonly documentPath: (id: string) => string;
  readonly Link: (props: LinkProps) => ReactNode;
}

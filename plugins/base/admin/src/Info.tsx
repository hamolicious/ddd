import type { ReactElement, ReactNode } from "react";

import { useSheet } from "./hooks.js";
import { InfoIcon } from "./icons.js";

export function Info({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactElement {
  const openSheet = useSheet();
  return (
    <button
      type="button"
      className="admin-info admin:ml-1 admin:inline-flex admin:size-6 admin:compact:size-11 admin:min-h-0! admin:items-center admin:justify-center admin:rounded-full admin:border-0! admin:bg-transparent! admin:p-0! admin:align-middle admin:text-text-muted admin:hover:text-text"
      aria-label={`About ${title.toLowerCase()}`}
      title={`About ${title.toLowerCase()}`}
      onClick={(event) =>
        openSheet({
          title,
          anchor: event.currentTarget,
          render: () => (
            <div className="admin:flex admin:max-w-[20rem] admin:flex-col admin:gap-2 admin:px-2 admin:py-1 admin:font-sans admin:text-sm admin:text-text">
              {children}
            </div>
          ),
        })
      }
    >
      <InfoIcon />
    </button>
  );
}

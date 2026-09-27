/**
 * The strip across the top of a read-only look at the past (a snapshot, a change): what
 * it is, the way back to the current version, and the one action that would make it
 * matter (Restore, Revert). Its own row of buttons on a phone, so the heading keeps the
 * width.
 */

import type { ReactElement, ReactNode } from "react";

const LINK =
  "chg:tap-h chg:inline-flex chg:cursor-pointer chg:items-center chg:gap-1.5 chg:rounded chg:border chg:border-border chg:bg-bg chg:px-3 chg:text-text chg:no-underline chg:hover:border-border-strong chg:disabled:cursor-default chg:disabled:opacity-55";

export function DetachedBanner({
  label,
  title,
  detail,
  currentHref,
  action,
}: {
  /** The landmark's name: "Snapshot", "Change". */
  readonly label: string;
  readonly title: string;
  readonly detail: ReactNode;
  readonly currentHref: string;
  readonly action: {
    readonly label: string;
    readonly disabled: boolean;
    readonly onClick: (anchor: HTMLElement) => void;
  };
}): ReactElement {
  return (
    <div
      className="chg:sticky chg:top-0 chg:z-[1] chg:flex chg:flex-wrap chg:items-center chg:gap-2 chg:border-b chg:border-warning chg:bg-bg-raised chg:px-4 chg:py-2"
      role="region"
      aria-label={label}
    >
      <span aria-hidden="true" className="chg:text-warning">
        <svg viewBox="0 0 24 24" width="1.25em" height="1.25em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      </span>
      <div className="chg:flex chg:min-w-[12rem] chg:flex-1 chg:flex-col">
        <strong>{title}</strong>
        <span className="chg:text-sm chg:text-text-muted">{detail}</span>
      </div>
      <div className="chg:flex chg:gap-2 chg:compact:basis-full chg:compact:[&>*]:flex-1 chg:compact:[&>*]:justify-center">
        <a className={LINK} href={`#${currentHref}`}>
          Current version
        </a>
        <button
          type="button"
          className={`${LINK} chg:border-danger! chg:text-danger!`}
          disabled={action.disabled}
          onClick={(event) => action.onClick(event.currentTarget)}
        >
          {action.label}
        </button>
      </div>
    </div>
  );
}

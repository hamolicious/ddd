/**
 * The read-mode **properties header**: a document's frontmatter, pretty-printed above
 * the body (owner ask, 2026-09-25).
 *
 * Read mode used to drop the frontmatter block on the floor. That is right about the
 * *text* — a `---` fence and a column of `key: value` lines is not prose, and rendering
 * it as prose is what `markdown.bodyOf` exists to prevent — but it was wrong about the
 * *information*: the tags, the date and the folder a document is filed under are things
 * a reader wants, and the only place they appeared was a sidebar panel that is a drawer
 * on a phone. So the block is hidden and its contents are shown.
 *
 * Three rules it keeps, each of them a decision rather than a detail:
 *
 * - **It is display-only.** No control, no `onChange`, no splice, nothing focusable
 *   except what the browser does with text. Editing frontmatter happens in the
 *   properties panel and in edit mode, where the raw block is now unfolded — two paths,
 *   not three. A header that quietly became a third editor would need the whole splice
 *   discipline of SPEC §3.3 for a surface whose job is reading.
 * - **It types values the same way the properties panel does**, because both read
 *   `_shared/fm-display.ts`. A key that is a date in the panel and a string here would
 *   be the `machine-docs.ts` bug in a different costume.
 * - **It renders nothing at all for a document with no frontmatter.** An empty
 *   bordered strip above every unadorned note is worse than no header, and most notes
 *   are unadorned.
 *
 * `fm_parse_error` gets a small inline warning rather than silence, for the reason the
 * flag exists: a dropped line means the header below it is *incomplete*, and a reader
 * comparing it against the raw text needs to know which of the two is lying.
 */

import type { CoreValue } from "@kernel";
import { useMemo, type ReactNode } from "react";

import { fmDisplayRows, type FmDisplayRow } from "../../_shared/fm-display.js";

export interface FmHeaderProps {
  /** The document's materialized frontmatter, from the projection row. */
  readonly fm?: Readonly<Record<string, CoreValue>>;
  /** SPEC §3.4: at least one frontmatter line could not be read and was dropped. */
  readonly fmParseError?: boolean;
}

export function FmHeader({ fm, fmParseError }: FmHeaderProps): ReactNode {
  const rows = useMemo(() => fmDisplayRows(fm), [fm]);

  // Nothing to say, and nothing wrong: no header. The `fm_parse_error` case is
  // deliberately not folded into this test — a block whose only line was unreadable
  // materializes as an *empty* `fm`, and that is precisely when the warning matters.
  if (rows.length === 0 && !fmParseError) return null;

  return (
    <div className="viewer-properties mx-auto w-full min-w-0 max-w-[72ch] px-4 pt-4 compact:px-4 compact:pt-4">
      {rows.length > 0 ? (
        <dl className="viewer-properties-list m-0 grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-border pb-3 text-sm compact:grid-cols-1 compact:gap-0">
          {rows.map((row) => (
            <PropertyRow key={row.key} row={row} />
          ))}
        </dl>
      ) : null}

      {fmParseError ? (
        <p className="viewer-properties-warning mb-0 mt-2 border-l-[3px] border-warning pl-2 text-sm text-text-muted" role="status">
          One frontmatter line could not be read, so it is missing here. The text is
          untouched — fix the line in edit mode.
        </p>
      ) : null}
    </div>
  );
}

function PropertyRow({ row }: { readonly row: FmDisplayRow }): ReactNode {
  return (
    <div className="viewer-property contents compact:block compact:pb-1" data-kind={row.kind}>
      <dt className="viewer-property-key m-0 min-w-0 break-words font-medium text-text-muted compact:text-xs">{row.key}</dt>
      <dd className="viewer-property-value m-0 min-w-0 break-words text-text">
        <PropertyValue row={row} />
      </dd>
    </div>
  );
}

/**
 * One value, typed.
 *
 * `title`/`dateTime` carry the value **as the document stores it** on every row whose
 * printed form differs from it. A reader who wants to know what a locale-formatted date
 * or a `Yes` actually says in the file can hover or inspect, and a test can assert on
 * the stored form without pinning the test runner's locale.
 */
function PropertyValue({ row }: { readonly row: FmDisplayRow }): ReactNode {
  if (row.items !== undefined) {
    if (row.items.length === 0) return <EmptyValue />;
    return (
      <span className="viewer-property-chips flex flex-wrap gap-1">
        {row.items.map((item, index) => (
          <span className="viewer-property-chip inline-block max-w-full break-words rounded-full border border-border bg-bg-subtle px-1.5 py-px text-[0.85em]" key={`${item}-${index}`}>
            {item}
          </span>
        ))}
      </span>
    );
  }

  if (row.empty) return <EmptyValue />;

  if (row.kind === "date") {
    return (
      <time className="viewer-property-text" dateTime={row.raw} title={row.raw}>
        {row.text}
      </time>
    );
  }

  if (row.kind === "boolean") {
    return (
      <span className="viewer-property-flag tabular-nums" title={row.raw}>
        {row.text}
      </span>
    );
  }

  return <span className="viewer-property-text">{row.text}</span>;
}

/** A key that is set but holds nothing. Shown, not hidden — see the file header. */
function EmptyValue(): ReactNode {
  return (
    <span className="viewer-property-empty text-text-muted" aria-label="not set">
      —
    </span>
  );
}

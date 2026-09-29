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
 *   except what the browser does with text. Editing frontmatter happens in edit mode,
 *   where the raw block is unfolded. A header that quietly became an editor would need
 *   the whole splice discipline of SPEC §3.3 for a surface whose job is reading.
 * - **It types values through `_shared/fm-display.ts`**, so any other plugin that
 *   shows `fm` agrees with it. A key that is a date in one place and a string here
 *   would be the `machine-docs.ts` bug in a different costume.
 * - **It renders nothing at all for a document with no frontmatter.** An empty
 *   bordered strip above every unadorned note is worse than no header, and most notes
 *   are unadorned.
 *
 * It is a **table without visible borders** (owner ask, 2026-09-26): keys in one column,
 * values in the next, aligned like a table and read out as one (each key is its row's
 * header), with nothing drawn around the cells. One horizontal rule under it separates
 * the properties from the document (owner ask, 2026-09-26). On a phone it stays
 * two columns; the key column is a fixed width, so a long key wraps instead of starving
 * the values.
 *
 * **A `doc://` value is a link to that note**, alone or in a list: its title, its colour
 * and icon from the folder tree, and a click opens it — drawn by `markdown`, the same
 * link the body draws, so the two cannot disagree.
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
  /** A `doc://` value as a link to its note (`markdown`'s `renderDocLink`). */
  readonly renderDocLink?: (documentId: string) => ReactNode;
}

/** `doc://<id>`, the whole value: the id, or `undefined` for anything else. */
function docLinkId(value: string): string | undefined {
  return /^doc:\/\/([A-Za-z0-9_-]+)$/.exec(value.trim())?.[1];
}

export function FmHeader({ fm, fmParseError, renderDocLink }: FmHeaderProps): ReactNode {
  const rows = useMemo(() => fmDisplayRows(fm), [fm]);

  // Nothing to say, and nothing wrong: no header. The `fm_parse_error` case is
  // deliberately not folded into this test — a block whose only line was unreadable
  // materializes as an *empty* `fm`, and that is precisely when the warning matters.
  if (rows.length === 0 && !fmParseError) return null;

  return (
    <div className="viewer-properties viewer:text-base viewer:mx-auto viewer:w-full viewer:min-w-0 viewer:max-w-[72ch] viewer:px-4 viewer:pt-4 viewer:compact:px-4 viewer:compact:pt-4">
      {rows.length > 0 ? (
        <table className="viewer-properties-list viewer:mb-2 viewer:w-full viewer:table-fixed viewer:border-collapse viewer:border-0 viewer:text-sm">
          <tbody>
            {rows.map((row) => (
              <PropertyRow key={row.key} row={row} renderDocLink={renderDocLink} />
            ))}
          </tbody>
        </table>
      ) : null}

      {fmParseError ? (
        <p className="viewer-properties-warning viewer:mb-0 viewer:mt-2 viewer:border-l-[3px] viewer:border-warning viewer:pl-2 viewer:text-sm viewer:text-text-muted" role="status">
          One frontmatter line could not be read, so it is missing here. The text is
          untouched — fix the line in edit mode.
        </p>
      ) : null}

      <hr className="viewer-properties-rule viewer:mb-0 viewer:mt-3 viewer:border-0 viewer:border-t viewer:border-border" />
    </div>
  );
}

interface RowProps {
  readonly row: FmDisplayRow;
  readonly renderDocLink?: ((documentId: string) => ReactNode) | undefined;
}

function PropertyRow({ row, renderDocLink }: RowProps): ReactNode {
  return (
    <tr className="viewer-property" data-kind={row.kind}>
      <th scope="row" className="viewer-property-key viewer:w-[9rem] viewer:compact:w-[7rem] viewer:border-0 viewer:py-0.5 viewer:pl-0 viewer:pr-3 viewer:text-left viewer:align-top viewer:font-medium viewer:break-words viewer:text-text-muted">
        {row.key}
      </th>
      <td className="viewer-property-value viewer:border-0 viewer:p-0 viewer:py-0.5 viewer:align-top viewer:break-words viewer:text-text">
        <PropertyValue row={row} renderDocLink={renderDocLink} />
      </td>
    </tr>
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
function PropertyValue({ row, renderDocLink }: RowProps): ReactNode {
  const linked = (value: string): ReactNode => {
    const id = renderDocLink ? docLinkId(value) : undefined;
    return id !== undefined && renderDocLink ? renderDocLink(id) : undefined;
  };

  if (row.items !== undefined) {
    if (row.items.length === 0) return <EmptyValue />;
    return (
      <span className="viewer-property-chips viewer:flex viewer:flex-wrap viewer:gap-1">
        {row.items.map((item, index) =>
          linked(item) !== undefined ? (
            <span className="viewer-property-link viewer:inline-flex viewer:max-w-full viewer:items-center viewer:py-px" key={`${item}-${index}`}>
              {linked(item)}
            </span>
          ) : (
          <span className="viewer-property-chip viewer:inline-block viewer:max-w-full viewer:break-words viewer:rounded-full viewer:border viewer:border-border viewer:bg-bg-subtle viewer:px-1.5 viewer:py-px viewer:text-[0.85em]" key={`${item}-${index}`}>
            {item}
          </span>
          ),
        )}
      </span>
    );
  }

  if (row.empty) return <EmptyValue />;

  const link = row.kind === "string" ? linked(row.raw) : undefined;
  if (link !== undefined) return <span className="viewer-property-link">{link}</span>;

  if (row.kind === "date") {
    return (
      <time className="viewer-property-text" dateTime={row.raw} title={row.raw}>
        {row.text}
      </time>
    );
  }

  if (row.kind === "boolean") {
    return (
      <span className="viewer-property-flag viewer:tabular-nums" title={row.raw}>
        {row.text}
      </span>
    );
  }

  return <span className="viewer-property-text">{row.text}</span>;
}

/** A key that is set but holds nothing. Shown, not hidden — see the file header. */
function EmptyValue(): ReactNode {
  return (
    <span className="viewer-property-empty viewer:text-text-muted" aria-label="not set">
      —
    </span>
  );
}

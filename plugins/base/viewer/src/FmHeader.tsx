import type { CoreValue } from "@kernel";
import { useMemo, type ReactNode } from "react";

import { fmDisplayRows, type FmDisplayRow } from "../../_shared/fm-display.js";

import { FULL_WIDTH_KEY, columnClasses } from "./width.js";

export interface FmHeaderProps {
  readonly fm?: Readonly<Record<string, CoreValue>>;
  readonly fmParseError?: boolean;
  readonly renderDocLink?: (documentId: string) => ReactNode;
  readonly fullWidth?: boolean;
}

function docLinkId(value: string): string | undefined {
  return /^doc:\/\/([A-Za-z0-9_-]+)$/.exec(value.trim())?.[1];
}

export function FmHeader({ fm, fmParseError, renderDocLink, fullWidth = false }: FmHeaderProps): ReactNode {
  const rows = useMemo(() => fmDisplayRows(fm).filter((row) => row.key !== FULL_WIDTH_KEY), [fm]);

  if (rows.length === 0 && !fmParseError) return null;

  return (
    <div className={`viewer-properties viewer:text-base viewer:mx-auto viewer:w-full viewer:min-w-0 viewer:pt-4 viewer:compact:pt-4 ${columnClasses(fullWidth)}`}>
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

function EmptyValue(): ReactNode {
  return (
    <span className="viewer-property-empty viewer:text-text-muted" aria-label="not set">
      —
    </span>
  );
}

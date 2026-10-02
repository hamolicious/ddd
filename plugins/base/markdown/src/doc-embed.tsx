import type { DocumentRow, Kernel } from "@kernel";
import { useEffect, useState, type ReactNode } from "react";

import { target } from "../../_shared/target.js";

import { DocLink } from "./links.js";
import type { MarkdownRuntime } from "./runtime.js";

export interface EmbedChain {
  readonly depth: number;
  readonly ancestors: readonly string[];
}

export const ROOT_CHAIN: EmbedChain = { depth: 0, ancestors: [] };

export function mayEmbed(chain: EmbedChain, id: string, maxDepth: number): boolean {
  return chain.depth < maxDepth && !chain.ancestors.includes(id);
}

const byId = (id: string): Record<string, unknown> => ({
  cmp: { field: "id", op: "eq", value: { str: id } },
});

function useRow(kernel: Kernel, id: string): DocumentRow | null | undefined {
  const [row, setRow] = useState<DocumentRow | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    let close: (() => void) | undefined;
    setRow(undefined);
    kernel.documents
      .subscribe({ filter: byId(id), limit: 1 })
      .then((subscription) => {
        if (!live) {
          subscription.close();
          return;
        }
        const off = subscription.onChange((result) => setRow(result.rows[0] ?? null));
        close = () => {
          off();
          subscription.close();
        };
        setRow(subscription.result.rows[0] ?? null);
      })
      .catch(async () => {
        const once = await kernel.documents.get(id).catch(() => undefined);
        if (live) setRow(once ?? null);
      });
    return () => {
      live = false;
      close?.();
    };
  }, [kernel, id]);
  return row;
}

export interface DocEmbedProps {
  readonly id: string;
  readonly runtime: MarkdownRuntime;
  readonly renderBody: (row: DocumentRow) => ReactNode;
}

function Body({
  row,
  runtime,
  renderBody,
}: {
  readonly row: DocumentRow;
  readonly runtime: MarkdownRuntime;
  readonly renderBody: (row: DocumentRow) => ReactNode;
}): ReactNode {
  const View = runtime.embedView?.(row);
  if (!View) return renderBody(row);
  return <View id={row.id} row={row} unavailable embedded />;
}

export function DocEmbed({ id, runtime, renderBody }: DocEmbedProps): ReactNode {
  const row = useRow(runtime.kernel, id);

  if (row === null || row?.deleted) return <DocLink id={id} runtime={runtime} />;

  return (
    <div
      className="md-embed markdown:my-3 markdown:min-w-0 markdown:rounded-lg markdown:border markdown:border-border markdown:bg-bg-subtle markdown:p-2"
      data-embed={id}
    >
      <div className="markdown:mb-1 markdown:text-sm markdown:text-text-muted" {...target("ddd/document", id)}>
        <DocLink id={id} runtime={runtime} />
      </div>
      {row === undefined ? (
        <p className="markdown:m-0 markdown:italic markdown:text-text-muted" aria-busy="true">
          loading…
        </p>
      ) : (
        <Body row={row} runtime={runtime} renderBody={renderBody} />
      )}
    </div>
  );
}

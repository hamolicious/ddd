/**
 * `![](doc://<ulid>)`: another document's body, rendered in place.
 *
 * A link says "go there"; an embed says "show it here". The body is the target's own
 * (frontmatter and `%%%` sections hidden, exactly what Read mode shows), rendered by the
 * same pipeline, live: an edit to the target shows in every document embedding it.
 *
 * **Depth is bounded, and cycles stop early.** An embed inside an embed nests, up to the
 * user's `embedDepth` setting; past it, and for a document already shown higher up the
 * chain, the embed is an ordinary link. So a document embedding itself costs a link, not
 * the page.
 *
 * **A view that claims the document draws it instead** (`lm/document.mode`'s `prefer`):
 * a saved search embeds as its live results, not as its empty body. Only a claim counts —
 * the user's default mode is about opening a note, and an embed is never an editor. The
 * view gets no hydrated handle and `unavailable`, so one that edits shows read-only, and
 * `embedded`, so it leaves out its own controls.
 *
 * Task checkboxes inside write to the *embedded* document: it is rendered with its own
 * id, so ticking one is the same splice as ticking it on its own page.
 */

import type { DocumentRow, Kernel } from "@kernel";
import { useEffect, useState, type ReactNode } from "react";

import { target } from "../../_shared/target.js";

import { DocLink } from "./links.js";
import type { MarkdownRuntime } from "./runtime.js";

/** Where an embed sits: how deep, and which documents are already showing above it. */
export interface EmbedChain {
  readonly depth: number;
  readonly ancestors: readonly string[];
}

export const ROOT_CHAIN: EmbedChain = { depth: 0, ancestors: [] };

/** Whether `id` may be embedded at this point of the chain, or must be a link. */
export function mayEmbed(chain: EmbedChain, id: string, maxDepth: number): boolean {
  return chain.depth < maxDepth && !chain.ancestors.includes(id);
}

/** One document by id, in the shared filter DSL (SPEC §4.2). */
const byId = (id: string): Record<string, unknown> => ({
  cmp: { field: "id", op: "eq", value: { str: id } },
});

/** The live row: `undefined` while loading, `null` when there is no such document. */
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
        // No live query: a one-shot read still shows it.
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
  /** Render the target's body one level further down the chain. */
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
      {/* The embedded note's own menu, on its name: the body below holds other notes' rows. */}
      <div className="markdown:mb-1 markdown:text-sm markdown:text-text-muted" {...target("lm/document", id)}>
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

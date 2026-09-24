/**
 * `alt-editor` — the SPEC §9 M3 acceptance criterion, as a plugin.
 *
 * > *Acceptance: the built-in editor replaced by a separately-authored editor plugin.*
 *
 * This is that separately-authored editor. It lives **outside `plugins/base/`**, it
 * imports nothing from any other plugin's source, and everything it knows about the
 * host comes from `@kernel` — which at build time is
 * `web/kernel-api/dist/kernel.d.ts`, the same single file a third party downloads
 * from `/kernel.d.ts` (SPEC §6.4: "types are the contract"). If this plugin needs a
 * fact the `.d.ts` does not carry, the contract has a hole in it; that is what makes
 * it worth keeping in the tree rather than deleting after the test goes green.
 *
 * What it deliberately is *not*: CodeMirror. `base/editor` owns the `editor.extension`
 * point and the CodeMirror runtime-layer rows, and a replacement that also used
 * CodeMirror would prove only that two plugins can share a library. A plain
 * `<textarea>` proves the interesting thing — that `document.mode` has no built-in
 * favourite (SPEC §6.5) and that the surface hands a replacement exactly what it
 * handed the original.
 *
 * ### The two things a Y.Text-backed textarea has to get right
 *
 * 1. **Writes are minimal splices, never whole-text replacement** (SPEC §3.2, §3.3).
 *    `text.delete(0, len); text.insert(0, next)` would converge — and would also
 *    delete every other editor's concurrent characters, destroy the frontmatter
 *    block's identity, and turn one keystroke into a document-sized CRDT update.
 *    {@link applyMinimalEdit} narrows to the changed span first.
 * 2. **Remote edits must not eat the caret.** A remote insert before the caret moves
 *    the text under it; assigning `textarea.value` resets `selectionStart` to the end.
 *    The observer therefore maps the caret through the same prefix/suffix comparison
 *    it used to find the change.
 */

import { useEffect, useRef, useState, type ReactElement } from "react";

import type { Kernel, OpenDocument } from "@kernel";

/**
 * The shapes this plugin contributes to, declared locally.
 *
 * `plugins/base/_shared/points.ts` has these same types, and importing them would be
 * *convenient and wrong*: `_shared` is the base distribution's internal file, not part
 * of the kernel contract (SPEC §2 — the kernel knows point names as opaque strings).
 * A third-party plugin has only the point's documented name and payload, so this one
 * has only that too. Re-declaring is the honest cost of the microkernel boundary.
 */
const DOCUMENT_MODE_POINT = "document.mode";

interface DocumentModeProps {
  readonly id: string;
  readonly row: { readonly content: string; readonly title: string; readonly deleted: boolean };
  readonly open?: OpenDocument;
}

export interface AltEditorApi {
  /** The mode id this plugin claims. Exported so a test does not hard-code a string. */
  readonly modeId: string;
}

/** The id the base distribution's `editor` uses, so this is a drop-in replacement. */
const MODE_ID = "edit";

export default function activate(kernel: Kernel): AltEditorApi {
  // `document-surface` is a declared dependency, so the point exists by now; the
  // contribution would buffer even if it did not (SPEC §6.4).
  kernel.extensions.contribute(DOCUMENT_MODE_POINT, {
    id: MODE_ID,
    label: "Edit (plain)",
    order: 20,
    component: (props: DocumentModeProps) => <PlainEditor kernel={kernel} {...props} />,
  });

  kernel.log.info("alt-editor: contributed the plain-text `edit` mode");

  return { modeId: MODE_ID };
}

function PlainEditor({
  kernel,
  row,
  open,
}: DocumentModeProps & { readonly kernel: Kernel }): ReactElement {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const [phase, setPhase] = useState<string>(open?.phase ?? "hydrating");

  /**
   * True while *this* component is writing into the `Y.Text`. The observer fires
   * synchronously inside the transaction, and without this it would re-read the text
   * and rewrite the textarea mid-keystroke — which is how a "collaborative" textarea
   * ends up dropping every second character.
   */
  const writing = useRef(false);

  useEffect(() => {
    setPhase(open?.phase ?? "hydrating");
    const element = area.current;
    if (!open || !element) return undefined;
    if (open.phase === "error" || open.phase === "released") return undefined;

    element.value = open.text.toString();

    const observer = (): void => {
      if (writing.current) return;
      const next = open.text.toString();
      const current = element.value;
      if (next === current) return;
      const caret = element.selectionStart;
      element.value = next;
      // Map the caret through the change: anything before the first differing
      // character keeps its offset, anything after it shifts by the length delta.
      const prefix = commonPrefix(current, next);
      element.setSelectionRange(
        caret <= prefix ? caret : Math.max(prefix, caret + (next.length - current.length)),
        caret <= prefix ? caret : Math.max(prefix, caret + (next.length - current.length)),
      );
    };

    open.text.observe(observer);
    return () => open.text.unobserve(observer);
  }, [open]);

  const onInput = (): void => {
    const element = area.current;
    if (!open || !element || open.phase !== "live") return;
    writing.current = true;
    try {
      applyMinimalEdit(open, element.value);
    } catch (cause) {
      kernel.log.error("alt-editor: write failed", cause);
    } finally {
      writing.current = false;
    }
  };

  // Un-hydrated (offline, or a document never opened) is read-only rather than an
  // empty box: showing the projection's text and refusing writes is honest, and
  // `row.content` is available offline for every document (SPEC §4.1).
  if (!open || phase === "hydrating" || phase === "error") {
    return (
      <div className="altedit" data-testid="alt-editor">
        <p className="altedit-note" role="status">
          {phase === "error"
            ? "This document could not be hydrated, so it is read-only here."
            : "Loading the editable copy…"}
        </p>
        <textarea
          className="altedit-area"
          data-testid="alt-editor-area"
          aria-label="Document text (read-only)"
          readOnly
          value={row.content}
        />
      </div>
    );
  }

  return (
    <div className="altedit" data-testid="alt-editor">
      <p className="altedit-note">
        Plain-text editor from the <code>alt-editor</code> plugin — no CodeMirror.
      </p>
      <textarea
        ref={area}
        className="altedit-area"
        data-testid="alt-editor-area"
        aria-label="Document text"
        spellCheck={false}
        onInput={onInput}
      />
    </div>
  );
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

/**
 * Replace the one changed span of `open.text` with the one changed span of `next`.
 *
 * Exported for the unit test: the property that matters ("a one-character edit
 * produces a one-character CRDT operation") is invisible in a rendered textarea and
 * obvious in a test that counts the delta.
 */
export function applyMinimalEdit(open: OpenDocument, next: string): void {
  const current = open.text.toString();
  if (current === next) return;

  const prefix = commonPrefix(current, next);
  // Suffix scan stops at `prefix` on both sides so the two spans cannot overlap
  // (`"aa" -> "aaa"` would otherwise report a 2-char suffix and a 2-char prefix).
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < next.length - prefix &&
    current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  const removed = current.length - prefix - suffix;
  const inserted = next.slice(prefix, next.length - suffix);

  // One transaction, so remote peers see one atomic edit rather than a delete that
  // briefly truncates the document followed by an insert.
  open.doc.transact(() => {
    if (removed > 0) open.text.delete(prefix, removed);
    if (inserted.length > 0) open.text.insert(prefix, inserted);
  }, `alt-editor`);
}

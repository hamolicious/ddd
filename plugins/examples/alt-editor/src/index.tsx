/**
 * `alt-editor` — the SPEC §9 M3 acceptance criterion, as a plugin.
 *
 * > *Acceptance: the built-in editor replaced by a separately-authored editor plugin.*
 *
 * This is that separately-authored editor. It lives **outside `plugins/base/`**, and
 * everything it knows about the host comes from published types only: `@kernel`
 * (`web/kernel-api/dist/kernel.d.ts`, the file a third party downloads from
 * `/kernel.d.ts`) and `plugin:document-surface` (the `frontend/index.d.ts` that plugin
 * ships). If this plugin needs a fact those files do not carry, the contract has a hole.
 *
 * ### A stand-in, not an extra mode
 *
 * The manifest says `"provides": "editor@2.0.0"`: this plugin **replaces** `editor`, and
 * enabling one disables the other. That is what the acceptance test does (the registry is
 * the base distribution minus `editor`, plus this), and it is only honest if everything
 * that depends on `editor` keeps working. So this module exports `editor`'s whole API with
 * the same names and types — `addExtension`, `addPasteHandler`, `addSurface`, `surfaces`,
 * `onSurfacesChange`, `focus`, `setMachineSectionsFolded` — and the `/` menu, frontmatter
 * autocomplete, emoji, wikilinks and attachment pasting find a textarea where CodeMirror
 * was. Two things a textarea cannot do, it accepts and ignores: CodeMirror extensions
 * (`addExtension` keeps them, nothing runs them) and folding (`setMachineSectionsFolded`).
 *
 * What it deliberately is *not*: CodeMirror. A replacement that also used CodeMirror
 * would prove only that two plugins can share a library. A plain `<textarea>` proves the
 * interesting thing — that `document-surface` has no built-in favourite mode (SPEC §6.5)
 * and hands a replacement exactly what it handed the original.
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

import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactElement } from "react";
import * as Y from "yjs";

import { createRegistry, type DocumentId, type Kernel, type OpenDocument, type Unsubscribe } from "@kernel";
import { addMode, type DocumentModeProps } from "plugin:document-surface";

/*
 * `editor`'s types, restated. Dependents of `editor` compile against `editor`'s own
 * `.d.ts`; these must stay structurally the same, which is what "stand-in" promises.
 */

/**
 * A CodeMirror extension. Accepted so dependents that add one keep working; a textarea
 * has nothing to run it in, so it is kept and ignored.
 */
export interface EditorExtension {
  readonly id: string;
  readonly extension: unknown;
  /** Lower first. Default 100. */
  readonly order?: number;
}

export interface EditorPasteEvent {
  readonly documentId: DocumentId;
  /** A clipboard paste, or a drag dropped onto the text. */
  readonly via: "paste" | "drop";
  readonly files: readonly File[];
  /** The clipboard's plain text; empty when there is none. */
  readonly text: string;
  /** Put text at the caret (a paste replaces the selection). Each call lands after the previous one. */
  insert(text: string): EditorInsertion;
}

/** Text a paste handler put in, followed through later edits. */
export interface EditorInsertion {
  /** Swap the inserted text for `text`; `false`, changing nothing, once it was edited or settled. */
  replace(text: string): boolean;
  /** Take the inserted text out again, under the same rule. */
  remove(): boolean;
}

export interface EditorPaste {
  readonly id: string;
  /** Lower is asked first. Default 100. */
  readonly order?: number;
  /** `true` takes the paste; must answer synchronously. */
  readonly paste: (event: EditorPasteEvent) => boolean;
}

/** A spot in a document to insert at later. Each insert lands after the previous one. */
export interface TextMark {
  insert(text: string): EditorInsertion;
}

/** A mounted editor, as the `/` menu and autocomplete see it. */
export interface TextSurface {
  readonly id: string;
  readonly documentId: DocumentId;
  readonly element: HTMLElement;
  readonly hasFocus: () => boolean;
  readonly focus: () => void;
  readonly textBeforeCaret: () => string;
  readonly caretRect: () => { readonly left: number; readonly top: number; readonly bottom: number } | null;
  readonly takeBeforeCaret: (length: number) => TextMark;
  readonly subscribe: (listener: () => void) => () => void;
  readonly documentBeforeCaret?: () => string;
  readonly replaceBeforeCaret?: (length: number, text: string) => void;
}

export interface EditorApi {
  focus(): void;
  setMachineSectionsFolded(folded: boolean): void;
}

const extensionRegistry = createRegistry<EditorExtension>({ key: (e) => e.id, order: (e) => e.order ?? 100 });
const pasteRegistry = createRegistry<EditorPaste>({ key: (e) => e.id, order: (e) => e.order ?? 100 });
const surfaceRegistry = createRegistry<TextSurface>({ key: (surface) => surface.id });

/** Kept for `editor` compatibility; a textarea runs no CodeMirror extensions. Returns the remover. */
export const addExtension: (items: EditorExtension | readonly EditorExtension[]) => () => void =
  extensionRegistry.add;

/** Add a paste and drop handler (or several), asked in `order`. Returns the remover. */
export const addPasteHandler: (items: EditorPaste | readonly EditorPaste[]) => () => void = pasteRegistry.add;

/** Announce a mounted text editor. Returns the remover. */
export const addSurface: (items: TextSurface | readonly TextSurface[]) => () => void = surfaceRegistry.add;

/** Every text surface mounted right now. */
export function surfaces(): readonly TextSurface[] {
  return surfaceRegistry.get();
}

/** Called now and after every surface added or removed. */
export function onSurfacesChange(listener: (surfaces: readonly TextSurface[]) => void): Unsubscribe {
  return surfaceRegistry.subscribe(listener);
}

/** Focus the editor for the document on screen. */
export function focus(): void {
  live?.focus();
}

/** A textarea has no folds, so this does nothing; it exists because `editor` has it. */
export function setMachineSectionsFolded(folded: boolean): void {
  void folded;
}

/** The mode id `editor` uses, so this is a drop-in replacement. */
export const modeId = "edit";

/** The textarea on screen. One document surface, so at most one editor. */
let live: HTMLTextAreaElement | undefined;

export default function activate(kernel: Kernel): void {
  addMode({
    id: modeId,
    label: "Edit (plain)",
    order: 10,
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z" />
      </svg>
    ),
    component: (props: DocumentModeProps) => <PlainEditor kernel={kernel} {...props} />,
  });
  kernel.log.info("alt-editor: added the plain-text `edit` mode");
}

export function deactivate(): void {
  live = undefined;
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

  // The `/` menu, and anything else that works at the caret. Published while live.
  useEffect(() => {
    const element = area.current;
    if (!open || !element || phase !== "live") return undefined;
    const listeners = new Set<() => void>();
    const notify = (): void => {
      for (const listener of [...listeners]) listener();
    };
    const events = ["input", "keyup", "click", "focus", "blur", "select"] as const;
    for (const name of events) element.addEventListener(name, notify);
    const lineStart = (): number => element.value.lastIndexOf("\n", element.selectionStart - 1) + 1;

    // For the `/` menu and autocomplete; removed when the editor unmounts.
    live = element;
    const removeSurface = addSurface({
      id: `alt-editor:${open.id}:${String((surfaceCount += 1))}`,
      documentId: open.id,
      element,
      hasFocus: () => document.activeElement === element,
      focus: () => element.focus(),
      textBeforeCaret: () => element.value.slice(lineStart(), element.selectionStart),
      caretRect: () => caretRect(element),
      takeBeforeCaret: (length: number) => {
        const to = element.selectionStart;
        const from = Math.max(lineStart(), to - length);
        open.doc.transact(() => open.text.delete(from, to - from), "alt-editor");
        element.setSelectionRange(from, from);
        return markAt(open.text, from);
      },
      documentBeforeCaret: () => element.value.slice(0, element.selectionStart),
      replaceBeforeCaret: (length: number, insert: string) => {
        const to = element.selectionStart;
        const from = Math.max(lineStart(), to - length);
        open.doc.transact(() => {
          open.text.delete(from, to - from);
          open.text.insert(from, insert);
        }, "alt-editor");
        element.setSelectionRange(from + insert.length, from + insert.length);
        notify();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    return () => {
      removeSurface();
      if (live === element) live = undefined;
      for (const name of events) element.removeEventListener(name, notify);
    };
  }, [open, phase]);

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

  /** Ask the paste handlers in order; the first to take it cancels the browser's own paste. */
  const offerPaste = (
    via: "paste" | "drop",
    data: DataTransfer | null,
    event: ClipboardEvent<HTMLTextAreaElement> | DragEvent<HTMLTextAreaElement>,
  ): void => {
    const element = area.current;
    const handlers = pasteRegistry.get();
    if (!open || !element || open.phase !== "live" || !data || handlers.length === 0) return;
    let mark: TextMark | undefined;
    const pasted: EditorPasteEvent = {
      documentId: open.id,
      via,
      files: [...data.files],
      text: data.getData("text/plain"),
      // A textarea cannot tell where a drop landed, so a drop goes in at the caret too.
      insert: (text) => {
        if (!mark) {
          const from = element.selectionStart;
          const to = element.selectionEnd;
          if (to > from) open.doc.transact(() => open.text.delete(from, to - from), "alt-editor");
          mark = markAt(open.text, from);
        }
        return mark.insert(text);
      },
    };
    for (const handler of handlers) {
      try {
        if (handler.paste(pasted)) {
          event.preventDefault();
          return;
        }
      } catch (cause) {
        kernel.log.error(`alt-editor: paste handler ${handler.id} failed`, cause);
      }
    }
  };

  // Un-hydrated (offline, or a document never opened) is read-only rather than an
  // empty box: showing the projection's text and refusing writes is honest, and
  // `row.content` is available offline for every document (SPEC §4.1).
  if (!open || phase === "hydrating" || phase === "error") {
    return (
      <div className={ROOT_CLASSES} data-testid="alt-editor">
        <p className={NOTE_CLASSES} role="status">
          {phase === "error"
            ? "This document could not be hydrated, so it is read-only here."
            : "Loading the editable copy…"}
        </p>
        <textarea
          className={AREA_CLASSES}
          data-testid="alt-editor-area"
          aria-label="Document text (read-only)"
          readOnly
          value={row.content}
        />
      </div>
    );
  }

  return (
    <div className={ROOT_CLASSES} data-testid="alt-editor">
      <p className={NOTE_CLASSES}>
        Plain-text editor from the <code>alt-editor</code> plugin — no CodeMirror.
      </p>
      <textarea
        ref={area}
        className={AREA_CLASSES}
        data-testid="alt-editor-area"
        aria-label="Document text"
        spellCheck={false}
        onInput={onInput}
        onPaste={(event) => offerPaste("paste", event.clipboardData, event)}
        onDrop={(event) => offerPaste("drop", event.dataTransfer, event)}
      />
    </div>
  );
}

// `min-h-0` on every flex child, so the textarea is the only scroller — the same rule
// the CodeMirror editor needs for the Android soft keyboard.
const ROOT_CLASSES = "alteditor:flex alteditor:min-h-0 alteditor:flex-1 alteditor:flex-col alteditor:gap-2 alteditor:p-3";
const NOTE_CLASSES = "alteditor:m-0 alteditor:text-sm alteditor:text-text-muted";
const AREA_CLASSES =
  "alteditor:min-h-48 alteditor:flex-1 alteditor:resize-y alteditor:whitespace-pre-wrap alteditor:rounded alteditor:border alteditor:border-border alteditor:bg-bg alteditor:p-2 alteditor:font-mono alteditor:text-[0.9rem] alteditor:leading-normal alteditor:text-text alteditor:[tab-size:2] alteditor:focus-visible:outline-2 alteditor:focus-visible:outline-offset-1 alteditor:focus-visible:outline-focus alteditor:read-only:bg-bg-subtle alteditor:read-only:text-text-muted";

let surfaceCount = 0;

/** Where the caret is on screen: a hidden copy of the textarea, measured at the caret. */
function caretRect(element: HTMLTextAreaElement): { left: number; top: number; bottom: number } | null {
  const style = getComputedStyle(element);
  const mirror = document.createElement("div");
  for (const property of [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "tabSize", "wordSpacing",
  ] as const) {
    mirror.style[property] = style[property];
  }
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = element.value.slice(0, element.selectionStart);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const box = element.getBoundingClientRect();
  const left = box.left + marker.offsetLeft - element.scrollLeft;
  const top = box.top + marker.offsetTop - element.scrollTop;
  const height = marker.offsetHeight;
  mirror.remove();
  return { left, top, bottom: top + height };
}

/**
 * A spot in the text to insert at later, and each insert followed so it can be replaced
 * (an upload's placeholder). Yjs relative positions, so edits elsewhere cannot move it.
 */
function markAt(text: Y.Text, index: number): TextMark {
  let spot = Y.createRelativePositionFromTypeIndex(text, index, -1);
  const settled: EditorInsertion = { replace: () => false, remove: () => false };
  return {
    insert: (content) => {
      const doc = text.doc;
      if (!doc || content.length === 0) return settled;
      const found = Y.createAbsolutePositionFromRelativePosition(spot, doc);
      const at = found && found.type === text ? found.index : text.length;
      doc.transact(() => text.insert(at, content), "alt-editor");
      spot = Y.createRelativePositionFromTypeIndex(text, at + content.length, -1);
      const start = Y.createRelativePositionFromTypeIndex(text, at, 0);
      const end = Y.createRelativePositionFromTypeIndex(text, at + content.length, -1);
      let done = false;
      const swap = (next: string): boolean => {
        if (done) return false;
        done = true;
        const a = Y.createAbsolutePositionFromRelativePosition(start, doc);
        const b = Y.createAbsolutePositionFromRelativePosition(end, doc);
        if (!a || !b || text.toString().slice(a.index, b.index) !== content) return false;
        doc.transact(() => {
          text.delete(a.index, b.index - a.index);
          if (next) text.insert(a.index, next);
        }, "alt-editor");
        return true;
      };
      return { replace: swap, remove: () => swap("") };
    },
  };
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

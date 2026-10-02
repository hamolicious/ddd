import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactElement } from "react";
import * as Y from "yjs";

import { createRegistry, type DocumentId, type Kernel, type OpenDocument, type Unsubscribe } from "@kernel";
import { addMode, type DocumentModeProps } from "plugin:document-surface";

export interface EditorExtension {
  readonly id: string;
  readonly extension: unknown;
  readonly order?: number;
}

export interface EditorPasteEvent {
  readonly documentId: DocumentId;
  readonly via: "paste" | "drop";
  readonly files: readonly File[];
  readonly text: string;
  insert(text: string): EditorInsertion;
}

export interface EditorInsertion {
  replace(text: string): boolean;
  remove(): boolean;
}

export interface EditorPaste {
  readonly id: string;
  readonly order?: number;
  readonly paste: (event: EditorPasteEvent) => boolean;
}

export interface TextMark {
  insert(text: string): EditorInsertion;
}

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

export const addExtension: (items: EditorExtension | readonly EditorExtension[]) => () => void =
  extensionRegistry.add;

export const addPasteHandler: (items: EditorPaste | readonly EditorPaste[]) => () => void = pasteRegistry.add;

export const addSurface: (items: TextSurface | readonly TextSurface[]) => () => void = surfaceRegistry.add;

export function surfaces(): readonly TextSurface[] {
  return surfaceRegistry.get();
}

export function onSurfacesChange(listener: (surfaces: readonly TextSurface[]) => void): Unsubscribe {
  return surfaceRegistry.subscribe(listener);
}

export function focus(): void {
  live?.focus();
}

export function setMachineSectionsFolded(folded: boolean): void {
  void folded;
}

export const modeId = "edit";

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
      const prefix = commonPrefix(current, next);
      element.setSelectionRange(
        caret <= prefix ? caret : Math.max(prefix, caret + (next.length - current.length)),
        caret <= prefix ? caret : Math.max(prefix, caret + (next.length - current.length)),
      );
    };

    open.text.observe(observer);
    return () => open.text.unobserve(observer);
  }, [open]);

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

const ROOT_CLASSES = "alteditor:flex alteditor:min-h-0 alteditor:flex-1 alteditor:flex-col alteditor:gap-2 alteditor:p-3";
const NOTE_CLASSES = "alteditor:m-0 alteditor:text-sm alteditor:text-text-muted";
const AREA_CLASSES =
  "alteditor:min-h-48 alteditor:flex-1 alteditor:resize-y alteditor:whitespace-pre-wrap alteditor:rounded alteditor:border alteditor:border-border alteditor:bg-bg alteditor:p-2 alteditor:font-mono alteditor:text-[0.9rem] alteditor:leading-normal alteditor:text-text alteditor:[tab-size:2] alteditor:focus-visible:outline-2 alteditor:focus-visible:outline-offset-1 alteditor:focus-visible:outline-focus alteditor:read-only:bg-bg-subtle alteditor:read-only:text-text-muted";

let surfaceCount = 0;

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

export function applyMinimalEdit(open: OpenDocument, next: string): void {
  const current = open.text.toString();
  if (current === next) return;

  const prefix = commonPrefix(current, next);
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

  open.doc.transact(() => {
    if (removed > 0) open.text.delete(prefix, removed);
    if (inserted.length > 0) open.text.insert(prefix, inserted);
  }, `alt-editor`);
}

import {
  codeFolding,
  foldEffect,
  foldService,
  foldedRanges,
  unfoldEffect,
} from "@codemirror/language";
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateField,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import type { Kernel, Unsubscribe } from "@kernel";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";

import { addCommand } from "plugin:commands";
import { addMode, type DocumentModeProps } from "plugin:document-surface";

import {
  extensionRegistry,
  pasteRegistry,
  surfaceRegistry,
  type EditorExtension,
  type EditorInsertion,
  type EditorPaste,
  type EditorPasteEvent,
  type TextSurface,
} from "./api.js";
import { markAt, trackInsertion } from "../../_shared/text-mark.js";
import { markdownSyntax } from "./markdown-language.js";
import {
  foldableRegionsOf,
  regionsOf as regionsIn,
  type DocumentRegions,
  type LineReader,
  type Region,
} from "./regions.js";

export type {
  EditorExtension,
  EditorInsertion,
  EditorPaste,
  EditorPasteEvent,
  TextMark,
  TextSurface,
} from "./api.js";

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
  if (live) setFolded(live, folded);
}

let live: EditorView | undefined;

export interface EditorApi {
  focus(): void;
  setMachineSectionsFolded(folded: boolean): void;
}

const regionCache = new WeakMap<Text, DocumentRegions>();

function documentLines(doc: Text): LineReader {
  return {
    lines: doc.lines,
    length: doc.length,
    lineAt: (index) => {
      const line = doc.line(Math.min(Math.max(index + 1, 1), doc.lines));
      return { text: line.text, from: line.from };
    },
  };
}

function regionsOf(doc: Text): DocumentRegions {
  const cached = regionCache.get(doc);
  if (cached) return cached;
  const regions = regionsIn(documentLines(doc));
  regionCache.set(doc, regions);
  return regions;
}

function foldLabel(doc: Text, from: number): string {
  const line = doc.lineAt(from).from;
  const section = regionsOf(doc).sections.find((candidate) => candidate.start === line);
  return section ? `${section.id} data` : "machine data";
}

function foldRangeFor(doc: Text, region: Region): { from: number; to: number } | null {
  const firstLineEnd = doc.lineAt(region.start).to;
  return firstLineEnd < region.end ? { from: firstLineEnd, to: region.end } : null;
}

function chevron(direction: "down" | "up"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "1em");
  svg.setAttribute("height", "1em");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", direction === "down" ? "M6 9l6 6 6-6" : "M6 15l6-6 6 6");
  svg.append(path);
  return svg;
}

class RefoldWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly name: string,
  ) {
    super();
  }

  override eq(other: RefoldWidget): boolean {
    return other.from === this.from && other.to === this.to && other.name === this.name;
  }

  override toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "editor-refold";
    button.title = "Collapse";
    button.setAttribute("aria-label", `Collapse ${this.name}`);
    button.append(chevron("up"));
    button.onmousedown = (event) => event.preventDefault();
    button.onclick = () => view.dispatch({ effects: foldEffect.of({ from: this.from, to: this.to }) });
    return button;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function refoldIcons(state: EditorState): DecorationSet {
  const folded = foldedRanges(state);
  const builder = new RangeSetBuilder<Decoration>();
  for (const region of foldableRegionsOf(regionsOf(state.doc))) {
    const range = foldRangeFor(state.doc, region);
    if (!range) continue;
    let closed = false;
    folded.between(range.from, range.from, (from) => {
      if (from === range.from) closed = true;
    });
    if (closed) continue;
    builder.add(
      range.from,
      range.from,
      Decoration.widget({ widget: new RefoldWidget(range.from, range.to, foldLabel(state.doc, range.from)), side: 1 }),
    );
  }
  return builder.finish();
}

const refold = StateField.define<DecorationSet>({
  create: refoldIcons,
  update: (_, transaction) => refoldIcons(transaction.state),
  provide: (field) => EditorView.decorations.from(field),
});

const setFolded = (view: EditorView, folded: boolean): void => {
  const effects = foldableRegionsOf(regionsOf(view.state.doc))
    .map((region) => foldRangeFor(view.state.doc, region))
    .filter((range): range is { from: number; to: number } => range !== null)
    .map((range) => (folded ? foldEffect.of(range) : unfoldEffect.of(range)));
  if (effects.length > 0) view.dispatch({ effects });
};

export default function activate(kernel: Kernel): void {
  const extensions = extensionRegistry;
  const pastes = pasteRegistry;

  const offer = (
    documentId: string,
    text: Y.Text,
    view: EditorView,
    via: "paste" | "drop",
    data: DataTransfer,
    start: { from: number; to: number },
  ): boolean => {
    const handlers = pastes.get();
    if (handlers.length === 0) return false;

    let open = true;
    let at = start;
    const event: EditorPasteEvent = {
      documentId,
      via,
      files: Array.from(data.files),
      text: data.getData("text/plain"),
      insert: (content: string): EditorInsertion => {
        if (!open) throw new Error("editor.paste: insert() is only valid while handling the paste");
        const { from, to } = at;
        view.dispatch({
          changes: { from, to, insert: content },
          selection: { anchor: from + content.length },
          userEvent: via === "drop" ? "input.drop" : "input.paste",
          scrollIntoView: true,
        });
        at = { from: from + content.length, to: from + content.length };
        return trackInsertion(text, from, content);
      },
    };

    try {
      for (const handler of handlers) {
        try {
          if (handler.paste(event)) return true;
        } catch (error) {
          kernel.log.error(`editor.paste "${handler.id}" failed`, error);
        }
      }
      return false;
    } finally {
      open = false;
    }
  };

  const pasteHandler = (documentId: string, text: Y.Text): Extension =>
    EditorView.domEventHandlers({
      paste: (event, view) => {
        const data = event.clipboardData;
        if (!data || !offer(documentId, text, view, "paste", data, view.state.selection.main)) return false;
        event.preventDefault();
        return true;
      },
      drop: (event, view) => {
        const data = event.dataTransfer;
        if (!data) return false;
        const point = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const start = point === null ? view.state.selection.main : { from: point, to: point };
        if (!offer(documentId, text, view, "drop", data, start)) return false;
        event.preventDefault();
        view.focus();
        return true;
      },
    });

  let surfaceCount = 0;

  const contributedExtensions = (): readonly Extension[] => {
    const collected: Extension[] = [];
    for (const entry of extensions.get()) {
      try {
        collected.push(entry.extension);
      } catch (error) {
        kernel.log.error(`editor.extension "${entry.id}" could not be installed`, error);
      }
    }
    return collected;
  };

  const revealLine = (view: EditorView, line: number): void => {
    const doc = view.state.doc;
    const target = doc.line(Math.min(Math.max(line, 1), doc.lines));

    const containing = foldableRegionsOf(regionsOf(doc)).find(
      (region) => target.from >= region.start && target.from < region.end,
    );
    const unfold = containing ? foldRangeFor(doc, containing) : null;

    view.dispatch({
      selection: { anchor: target.from },
      effects: [
        ...(unfold ? [unfoldEffect.of(unfold)] : []),
        EditorView.scrollIntoView(target.from, { y: "center" }),
      ],
    });
  };

  const Edit = ({ id, row, open, line, unavailable }: DocumentModeProps): ReactNode => {
    const host = useRef<HTMLDivElement | null>(null);
    const [failure, setFailure] = useState<string | undefined>(undefined);

    useEffect(() => {
      const parent = host.current;
      if (!open || !parent) return;

      let view: EditorView | undefined;
      let undoManager: Y.UndoManager | undefined;
      let offPoint: Unsubscribe | undefined;
      let removeSurface: (() => void) | undefined;
      const watchers = new Set<() => void>();

      try {
        const extensionsCompartment = new Compartment();
        const collabCompartment = new Compartment();

        undoManager = new Y.UndoManager(open.text);
        view = new EditorView({
          state: EditorState.create({
            doc: open.text.toString(),
            extensions: [
              collabCompartment.of(yCollab(open.text, null, { undoManager })),
              keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]),

              EditorView.lineWrapping,
              highlightSpecialChars(),
              drawSelection(),
              dropCursor(),
              markdownSyntax,
              pasteHandler(id, open.text),
              EditorView.updateListener.of((update) => {
                if (!update.docChanged && !update.selectionSet && !update.focusChanged) return;
                for (const watcher of [...watchers]) watcher();
              }),

              codeFolding({
                preparePlaceholder: (state, range) => foldLabel(state.doc, range.from),
                placeholderDOM: (_view, onclick, prepared: unknown) => {
                  const name = typeof prepared === "string" ? prepared : "machine data";
                  const chip = document.createElement("span");
                  chip.className = "cm-foldPlaceholder";
                  chip.title = `Expand ${name}`;
                  chip.setAttribute("role", "button");
                  chip.setAttribute("aria-label", `Expand ${name}`);
                  chip.append(chevron("down"));
                  chip.onclick = onclick;
                  return chip;
                },
              }),
              refold,
              foldService.of((state, lineStart) => {
                const region = foldableRegionsOf(regionsOf(state.doc)).find(
                  (candidate) => candidate.start === lineStart,
                );
                return region ? foldRangeFor(state.doc, region) : null;
              }),

              EditorView.contentAttributes.of({
                autocapitalize: "sentences",
                autocorrect: "on",
                spellcheck: "true",
                "aria-label": "Document text",
              }),
              EditorView.theme({
                "&": { height: "100%", fontSize: "0.95rem" },
                ".cm-scroller": {
                  overflow: "auto",
                  fontFamily: "var(--ddd-font-mono)",
                  lineHeight: "1.6",
                },
                ".cm-content": { caretColor: "var(--ddd-text)" },
                "&.cm-focused": { outline: "none" },
                ".cm-selectionBackground, ::selection": { background: "var(--ddd-selection)" },
                "&.cm-focused .cm-selectionBackground": { background: "var(--ddd-selection)" },
                ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ddd-text)" },
                ".cm-foldPlaceholder, .editor-refold": {
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  verticalAlign: "middle",
                  margin: "0 0 0 6px",
                  padding: "1px 6px",
                  minHeight: "0",
                  font: "inherit",
                  border: "1px solid var(--ddd-border-strong)",
                  borderRadius: "999px",
                  background: "var(--ddd-bg-subtle)",
                  color: "var(--ddd-text-muted)",
                  cursor: "pointer",
                },
                ".cm-foldPlaceholder:hover, .editor-refold:hover": { color: "var(--ddd-text)" },
              }),

              extensionsCompartment.of(contributedExtensions()),
            ],
          }),
          parent,
        });

        offPoint = extensions.subscribe(() => {
          view?.dispatch({ effects: extensionsCompartment.reconfigure(contributedExtensions()) });
        });

        const bound = view;
        const text = open.text;
        const head = (): number => bound.state.selection.main.head;
        const surface: TextSurface = {
          id: `editor:${id}:${String((surfaceCount += 1))}`,
          documentId: id,
          element: bound.dom,
          hasFocus: () => bound.hasFocus,
          focus: () => bound.focus(),
          textBeforeCaret: () => {
            const line = bound.state.doc.lineAt(head());
            return line.text.slice(0, head() - line.from);
          },
          caretRect: () => {
            const rect = bound.coordsAtPos(head());
            return rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null;
          },
          takeBeforeCaret: (length) => {
            const to = head();
            const from = Math.max(bound.state.doc.lineAt(to).from, to - length);
            bound.dispatch({ changes: { from, to }, selection: { anchor: from }, userEvent: "delete" });
            return markAt(text, from);
          },
          documentBeforeCaret: () => bound.state.doc.sliceString(0, head()),
          replaceBeforeCaret: (length, insert) => {
            const to = head();
            const from = Math.max(bound.state.doc.lineAt(to).from, to - length);
            bound.dispatch({
              changes: { from, to, insert },
              selection: { anchor: from + insert.length },
              userEvent: "input.complete",
            });
          },
          subscribe: (listener) => {
            watchers.add(listener);
            return () => {
              watchers.delete(listener);
            };
          },
        };
        removeSurface = addSurface(surface);

        setFolded(view, true);
        if (line !== undefined) revealLine(view, line);
        live = view;
        setFailure(undefined);
      } catch (error) {
        kernel.log.error("the editor could not be created", error);
        setFailure(error instanceof Error ? error.message : String(error));
      }

      return () => {
        removeSurface?.();
        watchers.clear();
        offPoint?.();
        if (live === view) live = undefined;
        view?.destroy();
        undoManager?.destroy();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, id]);

    useEffect(() => {
      if (line === undefined || !live || failure !== undefined) return;
      revealLine(live, line);
    }, [line, open, failure]);

    if (!open) {
      return (
        <div className="editor:flex editor:h-full editor:min-h-0 editor:min-w-0 editor:flex-1 editor:flex-col editor:font-sans editor:text-text">
          {unavailable ? null : (
            <p className="editor-notice editor:m-0 editor:shrink-0 editor:border-b editor:border-border editor:bg-bg-subtle editor:px-4 editor:py-2 editor:text-sm editor:text-text-muted editor:compact:p-2 editor:compact:break-words" role="status">
              Opening for editing…
            </p>
          )}
          <pre className="editor:m-0 editor:min-h-0 editor:min-w-0 editor:flex-1 editor:overflow-auto editor:whitespace-pre-wrap editor:bg-bg editor:p-4 editor:font-mono editor:text-sm editor:leading-[1.6] editor:text-text-muted">{row.content ?? ""}</pre>
        </div>
      );
    }

    return (
      <div className="editor:flex editor:h-full editor:min-h-0 editor:min-w-0 editor:flex-1 editor:flex-col editor:font-sans editor:text-text" data-document={id}>
        {failure ? (
          <p className="editor-notice editor-notice-error editor:m-0 editor:shrink-0 editor:border-b editor:border-l-[3px] editor:border-border editor:border-l-danger editor:bg-bg-subtle editor:px-4 editor:py-2 editor:text-sm editor:text-text editor:compact:p-2 editor:compact:break-words" role="alert">
            The editor failed to start: {failure}
          </p>
        ) : null}
        {open.phase === "error" ? (
          <p className="editor-notice editor:m-0 editor:shrink-0 editor:border-b editor:border-border editor:bg-bg-subtle editor:px-4 editor:py-2 editor:text-sm editor:text-text-muted editor:compact:p-2 editor:compact:break-words" role="status">
            Offline. Your edits are saved here and sync when the connection returns.
          </p>
        ) : null}
        <div className="editor-surface editor:flex editor:min-h-0 editor:min-w-0 editor:flex-1 editor:flex-col editor:overflow-hidden editor:[&_.cm-content]:max-w-[88ch] editor:[&_.cm-content]:px-4 editor:[&_.cm-content]:pb-[calc(var(--ddd-viewport-height,100dvh)*0.4)] editor:[&_.cm-content]:pt-4 editor:compact:[&_.cm-content]:px-3 editor:compact:[&_.cm-content]:pt-2 editor:[&_.cm-editor]:min-h-0 editor:[&_.cm-editor]:min-w-0 editor:[&_.cm-editor]:max-w-full editor:[&_.cm-editor]:flex-1 editor:[&_.cm-scroller]:max-w-full editor:[&_.cm-scroller]:overflow-x-auto editor:[&_.cm-scroller]:overscroll-x-contain editor:compact:[&_.cm-foldPlaceholder]:min-h-[calc(var(--ddd-tap-target)-20px)]! editor:compact:[&_.cm-foldPlaceholder]:min-w-[calc(var(--ddd-tap-target)-8px)] editor:compact:[&_.editor-refold]:min-h-[calc(var(--ddd-tap-target)-20px)]! editor:compact:[&_.editor-refold]:min-w-[calc(var(--ddd-tap-target)-8px)]" ref={host} />
      </div>
    );
  };

  addMode({
    id: "edit",
    label: "Edit",
    order: 10,
    forNew: true,
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19z" />
        <path d="M14.5 6.5l3 3" />
      </svg>
    ),
    component: Edit,
  });

  addCommand([
    {
      id: "editor.focus",
      title: "Focus the editor",
      category: "Document",
      when: () => live !== undefined,
      run: () => focus(),
    },
    {
      id: "editor.unfoldMachineSections",
      title: "Show machine sections",
      category: "Document",
      when: () => live !== undefined,
      run: () => setMachineSectionsFolded(false),
    },
    {
      id: "editor.foldMachineSections",
      title: "Collapse machine sections",
      category: "Document",
      when: () => live !== undefined,
      run: () => setMachineSectionsFolded(true),
    },
  ]);
}

export function deactivate(): void {
  live = undefined;
}

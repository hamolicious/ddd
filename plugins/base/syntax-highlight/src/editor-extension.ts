/**
 * The `editor.extension`: colours the body of each fenced code block in the editor, in
 * the same grammar read mode uses.
 *
 * The editor's own markdown highlighter still marks a fence body as monospace; these
 * decorations sit on top of it and add the colour. Only fences on screen are parsed,
 * and a parse is cached by text, so scrolling back over a block costs nothing.
 */

import { RangeSetBuilder, StateEffect, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

import type { SyntaxApi } from "./index.js";

/** A fenced code block in the document: its info string and where its body is. */
export interface Fence {
  readonly info: string;
  /** Offset of the first body character (the line after the opening fence). */
  readonly from: number;
  /** Offset just past the last body character (before the closing fence's newline). */
  readonly to: number;
}

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Every fenced block, the way CommonMark finds them: the closing fence is the same
 * character, at least as long, with nothing after it. An unclosed fence runs to the end.
 * The leading `---` frontmatter block is skipped — a fence cannot open inside it.
 */
export function fencesOf(doc: Text): Fence[] {
  const fences: Fence[] = [];
  let line = 1;
  if (doc.lines > 1 && doc.line(1).text === "---") {
    for (line = 2; line <= doc.lines && doc.line(line).text !== "---"; line += 1);
    line += 1;
  }
  for (; line <= doc.lines; line += 1) {
    const open = OPEN.exec(doc.line(line).text);
    if (!open) continue;
    const marker = open[1] as string;
    const info = (open[2] ?? "").trim();
    if (marker[0] === "`" && info.includes("`")) continue;
    const close = new RegExp(`^ {0,3}\\${marker[0]}{${marker.length},}\\s*$`);
    const bodyStart = line + 1;
    let end = bodyStart;
    while (end <= doc.lines && !close.test(doc.line(end).text)) end += 1;
    if (bodyStart <= doc.lines && end > bodyStart) {
      fences.push({ info, from: doc.line(bodyStart).from, to: doc.line(end - 1).to });
    }
    line = end;
  }
  return fences;
}

/** Recompute: a grammar arrived, or the installed set changed. */
const refresh = StateEffect.define<null>();

const marks = new Map<string, Decoration>();
const markFor = (className: string): Decoration => {
  let mark = marks.get(className);
  if (!mark) {
    mark = Decoration.mark({ class: className });
    marks.set(className, mark);
  }
  return mark;
};

export function editorExtension(api: SyntaxApi): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private fences: Fence[];
      private readonly unsubscribe: () => void;
      private destroyed = false;

      constructor(readonly view: EditorView) {
        this.fences = fencesOf(view.state.doc);
        this.decorations = this.build();
        this.unsubscribe = api.subscribe(() => {
          // Never dispatch inside another dispatch: a grammar can finish mid-update.
          queueMicrotask(() => {
            if (!this.destroyed) this.view.dispatch({ effects: refresh.of(null) });
          });
        });
      }

      update(update: ViewUpdate): void {
        const refreshed = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refresh)));
        if (update.docChanged) this.fences = fencesOf(update.state.doc);
        if (update.docChanged || update.viewportChanged || refreshed) this.decorations = this.build();
      }

      destroy(): void {
        this.destroyed = true;
        this.unsubscribe();
      }

      private build(): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const { from: top, to: bottom } = this.view.viewport;
        for (const fence of this.fences) {
          if (fence.to < top || fence.from > bottom) continue;
          const language = api.resolve(fence.info);
          if (!language || !api.isInstalled(language.id)) continue;
          api.ensureLoaded(language.id);
          const spans = api.highlight(this.view.state.doc.sliceString(fence.from, fence.to), language.id);
          for (const span of spans ?? []) {
            builder.add(fence.from + span.from, fence.from + span.to, markFor(span.className));
          }
        }
        return builder.finish();
      }
    },
    { decorations: (value) => value.decorations },
  );
  return [plugin];
}

/**
 * The `editor.extension`: each `doc://` link in the editor wears the linked note's title
 * above it, so `[](doc://01J…)` reads as the note it points at while writing.
 *
 * The title is a widget at the start of the link, drawn in a strip of padding the line
 * gains for it, so it sits over the link without covering the line above. Titles come
 * from the workspace index and follow renames live. Only links on screen are found, and
 * a click on a title opens the note when `router` is enabled.
 */

import { StateEffect, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";

import type { NoteIndex } from "./controller.js";

/** One `doc://` link in the text. */
export interface FoundLink {
  /** Offset of the link's first character (`!`, `[` or `<`). */
  readonly from: number;
  readonly id: string;
  readonly embed: boolean;
}

const LINK = /(!?)\[[^\]\n]*\]\(doc:\/\/([^)\s]+)\)|<doc:\/\/([^>\s]+)>/g;

/** Every `doc://` link in `text`, offsets relative to it. Pure. */
export function linksIn(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const match of text.matchAll(LINK)) {
    const id = match[2] ?? match[3];
    if (id) found.push({ from: match.index, id: decodeURIComponent(id), embed: match[1] === "!" });
  }
  return found;
}

class TitleWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly title: string | undefined,
    readonly embed: boolean,
    readonly open: ((id: string) => void) | undefined,
  ) {
    super();
  }

  override eq(other: TitleWidget): boolean {
    return other.id === this.id && other.title === this.title && other.embed === this.embed;
  }

  toDOM(): HTMLElement {
    const anchor = document.createElement("span");
    anchor.className =
      "wikilinks-anchor wikilinks:relative wikilinks:inline-block wikilinks:h-[1lh] wikilinks:w-0 wikilinks:align-top";
    anchor.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = `wikilinks-title wikilinks:absolute wikilinks:bottom-full wikilinks:left-0 wikilinks:max-w-[40ch] wikilinks:truncate wikilinks:whitespace-nowrap wikilinks:font-sans wikilinks:text-[0.7em] wikilinks:leading-[1.2] ${
      this.title === undefined ? "wikilinks:text-danger" : "wikilinks:text-accent"
    } ${this.open && this.title !== undefined ? "wikilinks:cursor-pointer wikilinks:hover:underline" : ""}`;
    label.textContent = this.title === undefined ? "Note not found" : `${this.embed ? "Embeds " : ""}${this.title}`;
    if (this.open && this.title !== undefined) {
      const open = this.open;
      label.addEventListener("mousedown", (event) => {
        event.preventDefault();
        open(this.id);
      });
    }
    anchor.append(label);
    return anchor;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** The line has a title over it: room for one. */
const roomy = Decoration.line({ class: "wikilinks-line wikilinks:pt-[0.9em]!" });

/** Recompute: the index changed, so a title may have. */
const refresh = StateEffect.define<null>();

export function titleExtension(index: NoteIndex, open?: (id: string) => void): Extension {
  let titles = new Map<string, string>();
  const reindex = (): void => {
    titles = new Map(index.documents({ includeMachine: true }).map((note) => [note.id, note.title]));
  };
  reindex();

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly unsubscribe: () => void;
      private destroyed = false;

      constructor(readonly view: EditorView) {
        this.decorations = this.build();
        this.unsubscribe = index.subscribe(() => {
          reindex();
          // Never dispatch inside another dispatch: the index can change mid-update.
          queueMicrotask(() => {
            if (!this.destroyed) this.view.dispatch({ effects: refresh.of(null) });
          });
        });
      }

      update(update: ViewUpdate): void {
        const refreshed = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refresh)));
        if (update.docChanged || update.viewportChanged || refreshed) this.decorations = this.build();
      }

      destroy(): void {
        this.destroyed = true;
        this.unsubscribe();
      }

      private build(): DecorationSet {
        const ranges: Range<Decoration>[] = [];
        const lines = new Set<number>();
        const { doc } = this.view.state;
        for (const { from, to } of this.view.visibleRanges) {
          const text = doc.sliceString(from, to);
          for (const link of linksIn(text)) {
            const at = from + link.from;
            const line = doc.lineAt(at);
            if (!lines.has(line.number)) {
              lines.add(line.number);
              ranges.push(roomy.range(line.from));
            }
            const widget = new TitleWidget(link.id, titles.get(link.id), link.embed, open);
            ranges.push(Decoration.widget({ widget, side: -1 }).range(at));
          }
        }
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (value) => value.decorations },
  );
  return [plugin];
}

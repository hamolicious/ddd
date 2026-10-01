/**
 * `editor` — edit mode: CodeMirror 6 bound to the document's `Y.Text` through
 * `y-codemirror.next` (SPEC §6.5). It adds its mode with `document-surface`'s `addMode`,
 * and hosts three registries of its own: `addExtension`, `addPasteHandler`, `addSurface`.
 *
 * The binding is the point of this plugin, and it is also the reason the runtime layer
 * pins CodeMirror: `yCollab` needs the *same* `@codemirror/state` instance as every
 * extension added, or extensions silently do nothing (SPEC §6.4, risk 6).
 *
 * Three requirements that are easy to miss and expensive to retrofit:
 *
 * - **Machine sections are collapsed, not hidden; frontmatter is neither.** A `%%%`
 *   fence is machine-owned data (SPEC §3.3) and starts folded, so a document opens on
 *   its prose. **Frontmatter does not fold at all** (owner ask, 2026-09-25): it is
 *   human-owned, it is what edit mode is *for* when the thing being edited is a date
 *   or a tag list, and a block that collapses itself the moment a document opens is a
 *   control you have to defeat before you can type. Both regions stay part of the text
 *   and stay editable either way (SPEC §3.1, §6.5). The fold is one icon at the end of
 *   the `%%% id` line, in the same place both ways: a chevron to open it, and once
 *   open, a chevron to put it away again.
 * - **Every write is a splice.** `yCollab` already produces minimal insert/delete pairs
 *   from CodeMirror transactions; nothing in this plugin may ever replace the whole
 *   text, because that destroys concurrent edits (SPEC §3.2).
 * - **The Android soft keyboard is an M5 acceptance test** (SPEC §6.5): the editor has
 *   to stay usable with a virtual keyboard resizing the viewport, which constrains the
 *   layout and the scroll container — design for it now rather than fixing it in M5.
 *
 * `Y.UndoManager` (not CodeMirror's history) is what makes undo correct in a
 * collaborative document: it undoes *this* client's changes, not whatever arrived last.
 * `@codemirror/commands`' `history`/`historyKeymap` are therefore deliberately absent,
 * and `yUndoManagerKeymap` takes Mod-Z / Mod-Shift-Z.
 */

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

/**
 * Add a CodeMirror extension (or several) to every editor, including ones already open.
 * Returns the function that takes it out again.
 */
export const addExtension: (items: EditorExtension | readonly EditorExtension[]) => () => void =
  extensionRegistry.add;

/**
 * Add a paste and drop handler (or several). Handlers are asked in `order`; the first to
 * return `true` takes the paste. Returns the function that takes it out again.
 */
export const addPasteHandler: (items: EditorPaste | readonly EditorPaste[]) => () => void = pasteRegistry.add;

/**
 * Announce a mounted text editor to everything that works at the caret. Add it on mount,
 * call the returned function on unmount.
 */
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

/** Fold or unfold the `%%%` regions of the editor on screen. */
export function setMachineSectionsFolded(folded: boolean): void {
  if (live) setFolded(live, folded);
}

/** The view currently on screen. One document surface ⇒ at most one editor. */
let live: EditorView | undefined;

export interface EditorApi {
  /** Focus the editor for the document on screen. */
  focus(): void;
  /**
   * Fold or unfold the `%%%` regions. **Frontmatter is not among them** — it has no
   * fold range at all, so there is nothing here to unfold it from.
   */
  setMachineSectionsFolded(folded: boolean): void;
}

/**
 * Region lookups are keyed on the `Text` object — the fold service is asked about
 * individual lines, and recomputing per line would be quadratic.
 *
 * The cache is not enough on its own, and that was the bug: CodeMirror's `Text` is
 * immutable, so **every edit produces a new identity** and the next fold query is a
 * miss. Keystroke by keystroke, a `doc.toString()` plus a full line split is an
 * O(document) copy each time — a megabyte per keystroke near the SPEC §3.5 cap, on the
 * mid-range Android of the §8 budget. So the miss is cheap too: `documentLines` is a
 * reader over the `Text`'s own line index, and the scan only visits the head and the
 * tail (`regions.ts`), never the body.
 */
const regionCache = new WeakMap<Text, DocumentRegions>();

/** A {@link LineReader} over CodeMirror's `Text`. Nothing is copied. */
function documentLines(doc: Text): LineReader {
  return {
    lines: doc.lines,
    length: doc.length,
    // `Text.line` is 1-based and resolves in log time over the rope.
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

/**
 * What a folded region is, for the placeholder chip.
 *
 * One label for every fold read "machine data", which was wrong about the frontmatter —
 * and now cannot arise, because frontmatter does not fold. A fold is the one place a
 * `%%%` section's owner is worth naming: the opening fence carries the plugin id and
 * folding hides it.
 *
 * `from` is the end of the region's first line (see {@link foldRangeFor}), so a region
 * is matched by the line it starts on rather than by an exact offset.
 */
function foldLabel(doc: Text, from: number): string {
  const line = doc.lineAt(from).from;
  const section = regionsOf(doc).sections.find((candidate) => candidate.start === line);
  return section ? `${section.id} data` : "machine data";
}

/**
 * Fold from the end of a region's first line, so the fence line stays on screen with
 * the fold placeholder next to it. Folding from `region.start` would hide the `%%% id`
 * header and leave the user a nameless blob to click.
 */
function foldRangeFor(doc: Text, region: Region): { from: number; to: number } | null {
  const firstLineEnd = doc.lineAt(region.start).to;
  return firstLineEnd < region.end ? { from: firstLineEnd, to: region.end } : null;
}

/** Chevron pointing down (open this) or up (put it away), drawn in the text colour. */
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

/** The "put it away again" icon an open machine section carries where its fold chip was. */
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
    // Not a caret move: the press must not take focus or the selection with it.
    button.onmousedown = (event) => event.preventDefault();
    button.onclick = () => view.dispatch({ effects: foldEffect.of({ from: this.from, to: this.to }) });
    return button;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** One refold icon per machine section that is open right now. */
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
  // Both registries are already in `order`, so nothing here sorts.
  const extensions = extensionRegistry;
  const pastes = pasteRegistry;

  /**
   * Offer a paste or a drop to each paste handler in order; the first to say
   * `true` has it. A handler that throws is reported and skipped, never allowed to lose
   * it: the next one, or CodeMirror, still gets it.
   *
   * A paste inserts at the selection; a drop where it was dropped (the selection when the
   * pointer is not over text). A drop that is only text, such as moving a selection
   * within the editor, still reaches handlers with no files and normally falls through.
   */
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
    /** Where the next `insert` goes: `start` first, then after the last one. */
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

  // There is deliberately no `defineSchema` here any more. This plugin used to declare
  // a `foldFrontmatter` per-user setting, defaulting to "fold it" — a setting no screen
  // rendered (POLISH-BACKLOG item 2), for a behaviour the owner asked to remove rather
  // than to make configurable. A preference whose only honest value is `false` is not a
  // preference, and leaving the key declared would keep a label and a description
  // written for a settings screen describing something the editor no longer does.

  /** Numbers each mounted editor's text surface id. */
  let surfaceCount = 0;

  /** The extensions added, in order. A throwing one costs only itself. */
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

  /**
   * Put the cursor on a 1-based line and scroll it into view — `#/doc/<id>?line=42`.
   *
   * Clamped rather than validated: a deep link into a document that has since been
   * edited (or synced from another device) can name a line that no longer exists, and
   * landing at the end is a better answer than an exception or no movement at all.
   *
   * `scrollIntoView` with `y: "center"` rather than the default "nearest": a line the
   * user was *sent* to should be somewhere they can read around, not flush against the
   * bottom edge — and on the soft-keyboard layouts of SPEC §6.5's M5 criterion, the
   * bottom edge is where the keyboard is.
   */
  const revealLine = (view: EditorView, line: number): void => {
    const doc = view.state.doc;
    const target = doc.line(Math.min(Math.max(line, 1), doc.lines));

    // A `%%%` section starts folded, so a line inside one would be "revealed" behind a
    // `⋯ machine data` placeholder. Unfold the region that contains it — and only that
    // one; the rest stay out of the way. A line in the frontmatter needs nothing: that
    // block is never folded.
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
      /** Text surface listeners: told about every text, caret and focus change. */
      const watchers = new Set<() => void>();

      try {
        const extensionsCompartment = new Compartment();
        // A compartment, so presence can be added without rebuilding the editor: the
        // kernel relays awareness frames opaquely (SPEC §3.2) but exposes no
        // `Awareness` instance and does not put `y-protocols` in the import map, so
        // there is nothing to hand `yCollab` yet. Presence UI is v2 (SPEC §10); see the
        // INTEGRATION note in this plugin's header comment block.
        const collabCompartment = new Compartment();

        undoManager = new Y.UndoManager(open.text);
        view = new EditorView({
          state: EditorState.create({
            doc: open.text.toString(),
            extensions: [
              // --- the collaborative binding ---------------------------------
              collabCompartment.of(yCollab(open.text, null, { undoManager })),
              keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]),

              // --- prose editing ---------------------------------------------
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

              // --- the machine regions ---------------------------------------
              codeFolding({
                preparePlaceholder: (state, range) => foldLabel(state.doc, range.from),
                // An icon, no words: the `%%% id` line beside it already names the
                // section, and the name stays the chip's accessible name and tooltip.
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
              // The fold service is what makes a region foldable *at all* — gutter,
              // keybinding and `foldEffect` alike. Frontmatter is absent from it on
              // purpose: not "folded: false", but no fold range, so nothing in
              // CodeMirror or in any contributed extension can collapse it.
              foldService.of((state, lineStart) => {
                const region = foldableRegionsOf(regionsOf(state.doc)).find(
                  (candidate) => candidate.start === lineStart,
                );
                return region ? foldRangeFor(state.doc, region) : null;
              }),

              // --- the mobile keyboard (SPEC §6.5, M5 acceptance) -------------
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

              // --- everybody else's contributions ----------------------------
              extensionsCompartment.of(contributedExtensions()),
            ],
          }),
          parent,
        });

        // A plugin that offers an extension after boot (or whose plugin failed and was
        // withdrawn) must not need a reload to take effect.
        offPoint = extensions.subscribe(() => {
          view?.dispatch({ effects: extensionsCompartment.reconfigure(contributedExtensions()) });
        });

        // The caret, for the slash menu and anything else that works there. Added per
        // mounted editor and removed on unmount.
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

        // `%%%` sections always start folded. Frontmatter never was folded here and
        // never is — it opens as plain, highlighted text like the rest of the document.
        setFolded(view, true);
        // `?line=N`, applied after the folds so the reveal wins over them.
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
        // The UndoManager observes the Y.Doc; leaving it attached keeps the editor's
        // history alive for a document that is no longer on screen.
        undoManager?.destroy();
      };
      // `line` is deliberately **not** a dependency: rebuilding the whole editor — and
      // with it the `Y.UndoManager` and every contributed extension — because a deep
      // link moved is the wrong shape of fix. A second `?line=` on the document already
      // open is handled by the effect below, which only dispatches a selection.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, id]);

    /**
     * A `?line=` that changes while this editor stays mounted — following a second
     * search result into the document already on screen.
     *
     * `live` is the view this component created (the surface mounts at most one editor),
     * and a dispatch is all that is needed: the text is untouched, so this is a cursor
     * move and a scroll, not an edit, and `Y.UndoManager` never sees it.
     */
    useEffect(() => {
      if (line === undefined || !live || failure !== undefined) return;
      revealLine(live, line);
    }, [line, open, failure]);

    /*
     * **No parse-error notice here.** A frontmatter line is malformed for a moment every
     * time someone types a new key (`stat` before its `:`), and a banner that appeared and
     * vanished on those keystrokes pushed the text being typed up and down. Read mode's
     * properties header still says when a line could not be read (`viewer/src/FmHeader.tsx`).
     */

    if (!open) {
      return (
        <div className="editor:flex editor:h-full editor:min-h-0 editor:min-w-0 editor:flex-1 editor:flex-col editor:font-sans editor:text-text">
          {/* When it cannot open at all, the surface has already said why. */}
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
    // A new note is empty: open it ready to type into, whatever the default mode is.
    forNew: true,
    // A pencil. `currentColor`, so it follows the switch's selected/idle colours.
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

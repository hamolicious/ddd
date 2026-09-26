/**
 * `editor` — edit mode: CodeMirror 6 bound to the document's `Y.Text` through
 * `y-codemirror.next` (SPEC §6.5).
 *
 * The binding is the point of this plugin, and it is also the reason the runtime layer
 * pins CodeMirror: `yCollab` needs the *same* `@codemirror/state` instance as every
 * contributed `editor.extension`, or extensions silently do nothing (SPEC §6.4, risk 6).
 *
 * Three requirements that are easy to miss and expensive to retrofit:
 *
 * - **Machine sections are collapsed, not hidden; frontmatter is neither.** A `%%%`
 *   fence is machine-owned data (SPEC §3.3) and starts folded, so a document opens on
 *   its prose. **Frontmatter does not fold at all** (owner ask, 2026-09-25): it is
 *   human-owned, it is what edit mode is *for* when the thing being edited is a date
 *   or a tag list, and a block that collapses itself the moment a document opens is a
 *   control you have to defeat before you can type. Both regions stay part of the text
 *   and stay editable either way (SPEC §3.1, §6.5).
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
  unfoldEffect,
} from "@codemirror/language";
import { Compartment, EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, keymap } from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import type { Kernel, Unsubscribe } from "@kernel";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";

import {
  POINTS,
  editorExtensionShape,
  type Command,
  type DocumentMode,
  type DocumentModeProps,
  type EditorExtension,
} from "../../_shared/points.js";
import { markdownSyntax } from "./markdown-language.js";
import {
  foldableRegionsOf,
  regionsOf as regionsIn,
  type DocumentRegions,
  type LineReader,
  type Region,
} from "./regions.js";

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

export default function activate(kernel: Kernel): EditorApi {
  const extensions = kernel.extensions.definePoint<EditorExtension>({
    name: POINTS.editorExtension,
    shape: editorExtensionShape,
    key: (entry) => entry.id,
    description: "A CodeMirror 6 extension, from the shared @codemirror/state instance.",
  });

  // There is deliberately no `defineSchema` here any more. This plugin used to declare
  // a `foldFrontmatter` per-user setting, defaulting to "fold it" — a setting no screen
  // rendered (POLISH-BACKLOG item 2), for a behaviour the owner asked to remove rather
  // than to make configurable. A preference whose only honest value is `false` is not a
  // preference, and leaving the key declared would keep a label and a description
  // written for a settings screen describing something the editor no longer does.

  /** The view currently on screen. One document surface ⇒ at most one editor. */
  let live: EditorView | undefined;

  /** Contributed extensions, in `order`. A throwing contribution costs only itself. */
  const contributedExtensions = (): readonly Extension[] => {
    const collected: Extension[] = [];
    for (const entry of [...extensions.get()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))) {
      try {
        collected.push(entry.extension);
      } catch (error) {
        kernel.log.error(`editor.extension "${entry.id}" could not be installed`, error);
      }
    }
    return collected;
  };

  const setFolded = (view: EditorView, folded: boolean): void => {
    const effects = foldableRegionsOf(regionsOf(view.state.doc))
      .map((region) => foldRangeFor(view.state.doc, region))
      .filter((range): range is { from: number; to: number } => range !== null)
      .map((range) => (folded ? foldEffect.of(range) : unfoldEffect.of(range)));
    if (effects.length > 0) view.dispatch({ effects });
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

  const Edit = ({ id, row, open, line }: DocumentModeProps): ReactNode => {
    const host = useRef<HTMLDivElement | null>(null);
    const [failure, setFailure] = useState<string | undefined>(undefined);

    useEffect(() => {
      const parent = host.current;
      if (!open || !parent) return;

      let view: EditorView | undefined;
      let undoManager: Y.UndoManager | undefined;
      let offPoint: Unsubscribe | undefined;

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

              // --- the machine regions ---------------------------------------
              codeFolding({
                preparePlaceholder: (state, range) => foldLabel(state.doc, range.from),
                placeholderDOM: (_view, onclick, prepared: unknown) => {
                  const chip = document.createElement("span");
                  chip.className = "cm-foldPlaceholder";
                  chip.textContent = `⋯ ${typeof prepared === "string" ? prepared : "machine data"}`;
                  chip.title = "Expand";
                  chip.setAttribute("aria-label", `Expand ${chip.textContent.slice(2)}`);
                  chip.onclick = onclick;
                  return chip;
                },
              }),
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
                  fontFamily: "var(--lm-font-mono)",
                  lineHeight: "1.6",
                },
                ".cm-content": { caretColor: "var(--lm-text)" },
                "&.cm-focused": { outline: "none" },
                ".cm-selectionBackground, ::selection": { background: "var(--lm-selection)" },
                "&.cm-focused .cm-selectionBackground": { background: "var(--lm-selection)" },
                ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--lm-text)" },
                ".cm-foldPlaceholder": {
                  padding: "0 6px",
                  border: "1px solid var(--lm-border-strong)",
                  borderRadius: "999px",
                  background: "var(--lm-bg-subtle)",
                  color: "var(--lm-text-muted)",
                },
              }),

              // --- everybody else's contributions ----------------------------
              extensionsCompartment.of(contributedExtensions()),
            ],
          }),
          parent,
        });

        // A plugin that contributes an extension after boot (or whose plugin failed and
        // was retracted) must not need a reload to take effect.
        offPoint = extensions.subscribe(() => {
          view?.dispatch({ effects: extensionsCompartment.reconfigure(contributedExtensions()) });
        });

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
     * **The frontmatter line the parser dropped (SPEC §3.4), said in the mode that can
     * fix it.**
     *
     * `document-surface` used to carry this notice above every mode and stopped, because
     * in read mode it repeated `viewer`'s properties header. In *edit* mode it was the
     * only one: the header is read-mode-only. So the key silently missing from `fm` everywhere in the
     * app had no explanation on the one screen whose whole job is repairing the text —
     * and the read-mode warning's own advice is "fix the line in edit mode".
     *
     * It is a `status`, not an `alert`: the document opened fine, the text is intact,
     * and nothing is waiting on the reader.
     */
    const parseNotice = row.fm_parse_error ? (
      <p className="editor-notice editor:m-0 editor:shrink-0 editor:border-b editor:border-border editor:bg-bg-subtle editor:px-4 editor:py-2 editor:text-sm editor:text-text-muted editor:compact:p-2 editor:compact:break-words" role="status">
        One frontmatter line could not be read, so its key is missing everywhere else in
        the app. The text below is exactly what the document holds.
      </p>
    ) : null;

    if (!open) {
      return (
        <div className="editor:flex editor:h-full editor:min-h-0 editor:min-w-0 editor:flex-1 editor:flex-col editor:font-sans editor:text-text">
          <p className="editor-notice editor:m-0 editor:shrink-0 editor:border-b editor:border-border editor:bg-bg-subtle editor:px-4 editor:py-2 editor:text-sm editor:text-text-muted editor:compact:p-2 editor:compact:break-words">
            Opening for editing… You can read it now. A document you have never opened
            stays read-only until this device reconnects.
          </p>
          {parseNotice}
          <pre className="editor:m-0 editor:min-h-0 editor:min-w-0 editor:flex-1 editor:overflow-auto editor:whitespace-pre-wrap editor:bg-bg editor:p-4 editor:font-mono editor:text-sm editor:leading-[1.6] editor:text-text-muted">{row.content ?? ""}</pre>
        </div>
      );
    }

    return (
      <div className="editor:flex editor:h-full editor:min-h-0 editor:min-w-0 editor:flex-1 editor:flex-col editor:font-sans editor:text-text" data-document={id}>
        {parseNotice}
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
        <div className="editor-surface editor:flex editor:min-h-0 editor:min-w-0 editor:flex-1 editor:flex-col editor:overflow-hidden editor:[&_.cm-content]:max-w-[88ch] editor:[&_.cm-content]:px-4 editor:[&_.cm-content]:pb-[calc(var(--lm-viewport-height,100dvh)*0.4)] editor:[&_.cm-content]:pt-4 editor:compact:[&_.cm-content]:px-3 editor:compact:[&_.cm-content]:pt-2 editor:[&_.cm-editor]:min-h-0 editor:[&_.cm-editor]:min-w-0 editor:[&_.cm-editor]:max-w-full editor:[&_.cm-editor]:flex-1 editor:[&_.cm-scroller]:max-w-full editor:[&_.cm-scroller]:overflow-x-auto editor:[&_.cm-scroller]:overscroll-x-contain editor:compact:[&_.cm-foldPlaceholder]:inline-block editor:compact:[&_.cm-foldPlaceholder]:min-h-[calc(var(--lm-tap-target)-20px)] editor:compact:[&_.cm-foldPlaceholder]:leading-[calc(var(--lm-tap-target)-20px)]" ref={host} />
        <SaveState kernel={kernel} />
      </div>
    );
  };

  kernel.extensions.contribute<DocumentMode>(POINTS.documentMode, {
    id: "edit",
    label: "Edit",
    order: 10,
    component: Edit,
  });

  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "editor.focus",
    title: "Focus the editor",
    category: "Document",
    when: () => live !== undefined,
    run: () => api.focus(),
  });
  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "editor.unfoldMachineSections",
    title: "Show machine sections",
    category: "Document",
    when: () => live !== undefined,
    run: () => api.setMachineSectionsFolded(false),
  });
  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "editor.foldMachineSections",
    title: "Collapse machine sections",
    category: "Document",
    when: () => live !== undefined,
    run: () => api.setMachineSectionsFolded(true),
  });

  const api: EditorApi = {
    focus: () => live?.focus(),
    setMachineSectionsFolded: (folded) => {
      if (live) setFolded(live, folded);
    },
  };

  return api;
}

/**
 * The editor's own save state, from `kernel.sync` (SPEC §6.4).
 *
 * `shell-ui` owns the always-visible workspace indicator; this one answers the question
 * a person asks *while typing* — "did that last sentence get out?" — which is the
 * `pending` count, not the connection state. There is no save button: an edit is a CRDT
 * update the moment it is typed.
 */
function SaveState({ kernel }: { readonly kernel: Kernel }): ReactNode {
  const [state, setState] = useState(() => kernel.sync.state);
  useEffect(() => kernel.sync.subscribe(setState), [kernel]);

  const label = (): string => {
    if (state.pending > 0) {
      return state.status === "offline"
        ? `${state.pending} change${state.pending === 1 ? "" : "s"} saved on this device`
        : `Saving ${state.pending} change${state.pending === 1 ? "" : "s"}…`;
    }
    switch (state.status) {
      case "offline":
        return "Offline. Everything typed is saved on this device.";
      case "connecting":
      case "syncing":
        return "Reconnecting…";
      case "auth-required":
        return "Sign in again to sync. Nothing is lost.";
      case "error":
        return state.lastError ? `Sync error: ${state.lastError}` : "Sync error";
      default:
        return "Saved";
    }
  };

  return (
    <p
      className="editor:m-0 editor:min-h-[calc(var(--lm-space)*3)] editor:shrink-0 editor:border-t editor:border-border editor:bg-bg-subtle editor:px-4 editor:py-1 editor:text-xs editor:text-text-muted editor:data-[pending=true]:text-text editor:data-[status=offline]:border-warning editor:data-[status=offline]:text-text editor:data-[status=auth-required]:border-warning editor:data-[status=auth-required]:text-text editor:data-[status=error]:border-danger editor:data-[status=error]:text-text editor:compact:px-2 editor:compact:break-words"
      role="status"
      data-status={state.status}
      data-pending={state.pending > 0 ? "true" : "false"}
    >
      {label()}
    </p>
  );
}

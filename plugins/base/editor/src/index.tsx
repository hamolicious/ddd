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
 * - **Machine sections are collapsed, not hidden.** The frontmatter block and the
 *   `%%%` fences are part of the text and stay editable; they start folded so a
 *   document opens on its prose (SPEC §3.1, §6.5).
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
  regionsOf as regionsIn,
  type DocumentRegions,
  type LineReader,
  type Region,
} from "./regions.js";

export interface EditorApi {
  /** Focus the editor for the document on screen. */
  focus(): void;
  /** Fold or unfold the frontmatter and `%%%` regions. */
  setMachineSectionsFolded(folded: boolean): void;
}

const SETTING_FOLD_FRONTMATTER = "foldFrontmatter";

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

/** Every machine region of a document, frontmatter first. */
function machineRegions(regions: DocumentRegions): readonly Region[] {
  return regions.frontmatter ? [regions.frontmatter, ...regions.sections] : [...regions.sections];
}

/**
 * What a folded region is, for the placeholder chip.
 *
 * One label for every fold read "machine data", which is wrong about the frontmatter
 * and says so twice: frontmatter is **human**-owned (SPEC §3.3), and this plugin's own
 * setting already tells the user "`%%%` sections always start folded; frontmatter is
 * yours". A fold is also the one place a `%%%` section's owner is worth naming — the
 * opening fence carries the plugin id and folding hides it.
 *
 * `from` is the end of the region's first line (see {@link foldRangeFor}), so a region
 * is matched by the line it starts on rather than by an exact offset.
 */
function foldLabel(doc: Text, from: number): string {
  const line = doc.lineAt(from).from;
  const regions = regionsOf(doc);
  if (regions.frontmatter && regions.frontmatter.start === line) return "frontmatter";
  const section = regions.sections.find((candidate) => candidate.start === line);
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

  kernel.settings.defineSchema({
    [SETTING_FOLD_FRONTMATTER]: {
      type: "boolean",
      label: "Fold frontmatter when a document opens",
      description: "Machine `%%%` sections always start folded; frontmatter is yours.",
      default: true,
    },
  });

  /** The view currently on screen. One document surface ⇒ at most one editor. */
  let live: EditorView | undefined;

  const foldFrontmatterPreference = (): boolean => {
    try {
      return kernel.settings.get<boolean>(SETTING_FOLD_FRONTMATTER) !== false;
    } catch {
      // `settings` is not implemented in the kernel runtime yet; the default stands.
      return true;
    }
  };

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

  const setFolded = (view: EditorView, folded: boolean, includeFrontmatter: boolean): void => {
    const regions = regionsOf(view.state.doc);
    const targets = includeFrontmatter ? machineRegions(regions) : regions.sections;
    const effects = targets
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

    // A `%%%` section starts folded (and frontmatter may), so a line inside one would
    // be "revealed" behind a `⋯ machine data` placeholder. Unfold the region that
    // contains it — and only that one; the rest stay out of the way.
    const containing = machineRegions(regionsOf(doc)).find(
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
                  chip.title = "Click to expand";
                  chip.setAttribute("aria-label", `Expand ${chip.textContent.slice(2)}`);
                  chip.onclick = onclick;
                  return chip;
                },
              }),
              foldService.of((state, lineStart) => {
                const region = machineRegions(regionsOf(state.doc)).find(
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

        // `%%%` sections always start folded; the frontmatter fold is the user's call.
        setFolded(view, true, foldFrontmatterPreference());
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

    if (!open) {
      return (
        <div className="editor-root editor-unhydrated">
          <p className="editor-notice">
            Fetching the editable copy… Reading works meanwhile; offline, a document you
            have never opened stays read-only until this device reconnects (SPEC §4.1).
          </p>
          <pre className="editor-readonly">{row.content ?? ""}</pre>
        </div>
      );
    }

    return (
      <div className="editor-root" data-document={id}>
        {failure ? (
          <p className="editor-notice editor-notice-error" role="alert">
            The editor failed to start: {failure}
          </p>
        ) : null}
        {open.phase === "error" ? (
          <p className="editor-notice" role="status">
            This copy is local only — the server connection for this document is down.
            Edits are kept and will sync on reconnect.
          </p>
        ) : null}
        <div className="editor-surface" ref={host} />
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
    title: "Show machine sections and frontmatter",
    category: "Document",
    when: () => live !== undefined,
    run: () => api.setMachineSectionsFolded(false),
  });
  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "editor.foldMachineSections",
    title: "Collapse machine sections and frontmatter",
    category: "Document",
    when: () => live !== undefined,
    run: () => api.setMachineSectionsFolded(true),
  });

  const api: EditorApi = {
    focus: () => live?.focus(),
    setMachineSectionsFolded: (folded) => {
      if (live) setFolded(live, folded, true);
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
        return "Offline — everything typed so far is saved locally";
      case "connecting":
      case "syncing":
        return "Reconnecting…";
      case "auth-required":
        return "Sign in again to sync (nothing is lost)";
      case "error":
        return state.lastError ? `Sync error: ${state.lastError}` : "Sync error";
      default:
        return "Saved";
    }
  };

  return (
    <p
      className="editor-status"
      role="status"
      data-status={state.status}
      data-pending={state.pending > 0 ? "true" : "false"}
    >
      {label()}
    </p>
  );
}

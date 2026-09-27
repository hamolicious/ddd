/**
 * Markdown (plus frontmatter and `%%%` fences) syntax highlighting for the editor.
 *
 * ## Why this is a `StreamLanguage` and not `@lezer/markdown`
 *
 * A lezer grammar would be strictly better: it is the same parser `@codemirror/lang-markdown`
 * uses, it is incremental, and it agrees with the renderer's syntax by construction. The
 * problem is delivery, not desire.
 *
 * A base plugin may import **relative files and the blessed runtime layer** and nothing
 * else — `plugins/base/` has no `node_modules` and the reference build config
 * (`_shared/vite.plugin-config.mjs`) resolves nothing from one, by design: that is what
 * makes a plugin buildable anywhere. `@lezer/markdown` is in `web/package.json` and
 * `web/CONTRACTS.md` lists it as part of the blessed runtime layer — but it is in
 * **neither** `app/runtime/specifiers.ts` nor `RUNTIME_EXTERNALS`, so it is neither
 * importable as an external nor resolvable to bundle. (Same for
 * `@codemirror/lang-markdown`.) Recorded as an INTEGRATION item; the moment those two
 * lists gain the entry, this file collapses to a `MarkdownParser` plus one `styleTags`
 * call and the tokenizer below goes away.
 *
 * Until then: a line-oriented tokenizer over `@codemirror/language`'s `StreamLanguage`,
 * which *is* in the runtime layer. It is honest about what it is — a **highlighter**,
 * not a parser. It decides colours. It never decides what a document means: the
 * renderer's syntax comes from the `markdown` plugin's unified pipeline and the
 * frontmatter/`%%%` semantics come from the shared Rust core. A token boundary in the
 * wrong place costs one colour on one line.
 *
 * Token names are resolved by `@codemirror/language` straight against `@lezer/highlight`'s
 * `tags`, so `"heading2"` means `tags.heading2` with no mapping table in between.
 */

import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";

interface MarkdownState {
  /** `true` once the first line has been seen — frontmatter opens only there. */
  started: boolean;
  /** Inside the leading `---` block. */
  frontmatter: boolean;
  /** The fence that opened the current code block (``` or ~~~), else `null`. */
  fence: string | null;
}

/** Frontmatter fence, and the `%%%` machine-section fences (SPEC §3.1). */
const FM_FENCE = /^---$/;
const MACHINE_FENCE = /^%%%(?: [A-Za-z0-9_-]{1,64})?$/;
const FM_KEY = /^[A-Za-z0-9_-]{1,64}(?=:)/;

const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?=\s|$)/;
const SETEXT_UNDERLINE = /^ {0,3}(={2,}|-{2,})\s*$/;
const THEMATIC_BREAK = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BLOCKQUOTE = /^ {0,3}>+ ?/;
const LIST_MARK = /^\s{0,8}(?:[-*+]|\d{1,9}[.)])\s+/;
const TASK_MARK = /^\[[^\]]?\]\s/;
const TABLE_DELIMITER = /^\s{0,3}\|?(?:\s*:?-{1,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/;

const INLINE_CODE = /^`+[^`]*`+/;
const LINK = /^!?\[[^\]]*\]\((?:[^()\s]*)(?:\s+(?:"[^"]*"|'[^']*'))?\)/;
const REFERENCE_LINK = /^!?\[[^\]]*\]\[[^\]]*\]/;
const AUTOLINK = /^<[A-Za-z][A-Za-z0-9+.-]*:[^>\s]*>/;
const STRONG = /^(?:\*\*[^*]+\*\*|__[^_]+__)/;
const EMPHASIS = /^(?:\*[^*\s][^*]*\*|_[^_\s][^_]*_)/;
const STRIKETHROUGH = /^~~[^~]+~~/;
const ESCAPE = /^\\[\\`*_{}[\]()#+\-.!>~|]/;

export const markdownLanguage = StreamLanguage.define<MarkdownState>({
  name: "markdown",
  startState: () => ({ started: false, frontmatter: false, fence: null }),
  copyState: (state) => ({ ...state }),

  token(stream, state) {
    if (stream.sol()) {
      const firstLine = !state.started;
      state.started = true;

      // --- frontmatter (SPEC §3.4: opens only on the literal first line) -----
      if (firstLine && stream.match(FM_FENCE)) {
        state.frontmatter = true;
        return "processingInstruction";
      }
      if (state.frontmatter) {
        if (stream.match(FM_FENCE)) {
          state.frontmatter = false;
          return "processingInstruction";
        }
        if (stream.match(/^\s*#.*$/)) return "comment";
        if (stream.match(FM_KEY)) return "propertyName";
        stream.skipToEnd();
        return "string";
      }

      // --- fenced code -------------------------------------------------------
      if (state.fence) {
        const closing = new RegExp(`^ {0,3}${state.fence[0] === "`" ? "`" : "~"}{${state.fence.length},}\\s*$`);
        if (stream.match(closing)) {
          state.fence = null;
          return "processingInstruction";
        }
        stream.skipToEnd();
        return "monospace";
      }
      const fence = stream.match(CODE_FENCE) as RegExpMatchArray | null;
      if (fence) {
        state.fence = fence[1] ?? "```";
        // The info string (```ts) names the language the `markdown.fence` point
        // dispatches on — worth its own colour. The body stays one monospace token
        // here: colouring code is `syntax-highlight`'s `editor.extension`, over this.
        if (!stream.eol()) {
          stream.skipToEnd();
          return "labelName";
        }
        return "processingInstruction";
      }

      // --- machine sections (SPEC §3.1) --------------------------------------
      if (stream.match(MACHINE_FENCE)) return "processingInstruction";

      // --- block starts ------------------------------------------------------
      const heading = stream.match(ATX_HEADING) as RegExpMatchArray | null;
      if (heading) {
        stream.skipToEnd();
        return `heading${(heading[1] ?? "#").length}`;
      }
      if (stream.match(THEMATIC_BREAK)) return "contentSeparator";
      if (stream.match(SETEXT_UNDERLINE)) return "heading";
      if (stream.match(TABLE_DELIMITER)) return "processingInstruction";
      if (stream.match(BLOCKQUOTE)) return "quote";
      if (stream.match(LIST_MARK)) {
        // `- [ ] milk`: the marker is what `markdown.taskState` renders (SPEC §6.6).
        return "list";
      }
    }

    if (state.frontmatter) {
      if (stream.eat(":")) return "punctuation";
      stream.skipToEnd();
      return "string";
    }
    if (state.fence) {
      stream.skipToEnd();
      return "monospace";
    }

    // --- inline ---------------------------------------------------------------
    if (stream.match(TASK_MARK)) return "processingInstruction";
    if (stream.match(ESCAPE)) return "escape";
    if (stream.match(INLINE_CODE)) return "monospace";
    if (stream.match(LINK) || stream.match(REFERENCE_LINK)) return "link";
    if (stream.match(AUTOLINK)) return "url";
    if (stream.match(STRONG)) return "strong";
    if (stream.match(EMPHASIS)) return "emphasis";
    if (stream.match(STRIKETHROUGH)) return "strikethrough";

    // Nothing claimed this character. Advancing is mandatory — a token function that
    // returns without consuming anything is an infinite loop.
    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { block: { open: "<!--", close: "-->" } },
  },
});

/** Token-driven colours. Every value is a kernel theme token (SPEC §6.4). */
const markdownStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.5em", fontWeight: "700", color: "var(--lm-text)" },
  { tag: tags.heading2, fontSize: "1.3em", fontWeight: "700", color: "var(--lm-text)" },
  { tag: tags.heading3, fontSize: "1.15em", fontWeight: "600", color: "var(--lm-text)" },
  { tag: [tags.heading, tags.heading4, tags.heading5, tags.heading6], fontWeight: "600", color: "var(--lm-text)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.quote, color: "var(--lm-text-muted)" },
  { tag: tags.list, color: "var(--lm-accent)" },
  { tag: [tags.link, tags.url], color: "var(--lm-link)", textDecoration: "underline" },
  { tag: tags.monospace, fontFamily: "var(--lm-font-mono)", color: "var(--lm-text)" },
  { tag: tags.labelName, color: "var(--lm-text-muted)" },
  { tag: tags.propertyName, color: "var(--lm-accent)" },
  { tag: tags.punctuation, color: "var(--lm-text-muted)" },
  { tag: tags.string, color: "var(--lm-text)" },
  { tag: tags.comment, color: "var(--lm-text-muted)", fontStyle: "italic" },
  { tag: tags.escape, color: "var(--lm-text-muted)" },
  { tag: tags.contentSeparator, color: "var(--lm-border-strong)" },
  // Syntax marks stay visible but recede: this is a plain-text editor on purpose
  // (SPEC §3.1 — the document *is* the markdown), not a WYSIWYG surface.
  { tag: tags.processingInstruction, color: "var(--lm-text-muted)" },
]);

/** The language plus its highlighting — one extension for the editor to install. */
export const markdownSyntax: Extension = [markdownLanguage, syntaxHighlighting(markdownStyle)];

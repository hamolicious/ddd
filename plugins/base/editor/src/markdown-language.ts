import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";

interface MarkdownState {
  started: boolean;
  frontmatter: boolean;
  fence: string | null;
}

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
        if (!stream.eol()) {
          stream.skipToEnd();
          return "labelName";
        }
        return "processingInstruction";
      }

      if (stream.match(MACHINE_FENCE)) return "processingInstruction";

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

    if (stream.match(TASK_MARK)) return "processingInstruction";
    if (stream.match(ESCAPE)) return "escape";
    if (stream.match(INLINE_CODE)) return "monospace";
    if (stream.match(LINK) || stream.match(REFERENCE_LINK)) return "link";
    if (stream.match(AUTOLINK)) return "url";
    if (stream.match(STRONG)) return "strong";
    if (stream.match(EMPHASIS)) return "emphasis";
    if (stream.match(STRIKETHROUGH)) return "strikethrough";

    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { block: { open: "<!--", close: "-->" } },
  },
});

const markdownStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.5em", fontWeight: "700", color: "var(--ddd-text)" },
  { tag: tags.heading2, fontSize: "1.3em", fontWeight: "700", color: "var(--ddd-text)" },
  { tag: tags.heading3, fontSize: "1.15em", fontWeight: "600", color: "var(--ddd-text)" },
  { tag: [tags.heading, tags.heading4, tags.heading5, tags.heading6], fontWeight: "600", color: "var(--ddd-text)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.quote, color: "var(--ddd-text-muted)" },
  { tag: tags.list, color: "var(--ddd-accent)" },
  { tag: [tags.link, tags.url], color: "var(--ddd-link)", textDecoration: "underline" },
  { tag: tags.monospace, fontFamily: "var(--ddd-font-mono)", color: "var(--ddd-text)" },
  { tag: tags.labelName, color: "var(--ddd-text-muted)" },
  { tag: tags.propertyName, color: "var(--ddd-accent)" },
  { tag: tags.punctuation, color: "var(--ddd-text-muted)" },
  { tag: tags.string, color: "var(--ddd-text)" },
  { tag: tags.comment, color: "var(--ddd-text-muted)", fontStyle: "italic" },
  { tag: tags.escape, color: "var(--ddd-text-muted)" },
  { tag: tags.contentSeparator, color: "var(--ddd-border-strong)" },
  { tag: tags.processingInstruction, color: "var(--ddd-text-muted)" },
]);

export const markdownSyntax: Extension = [markdownLanguage, syntaxHighlighting(markdownStyle)];

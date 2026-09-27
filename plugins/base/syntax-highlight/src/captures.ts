/**
 * tree-sitter capture names → the classes `style.css` colours.
 *
 * Grammars name captures with dotted scopes (`@function.method`, `@string.special.key`).
 * We colour a fixed set of them and let the rest fall back to their nearest known prefix,
 * so a grammar with a capture we have never heard of still gets the colour of its family
 * — or none, which is plain text and never wrong.
 */

const KNOWN = new Set([
  "attribute",
  "comment",
  "constant",
  "constant.builtin",
  "constructor",
  "embedded",
  "escape",
  "function",
  "function.builtin",
  "keyword",
  "label",
  "module",
  "number",
  "operator",
  "property",
  "punctuation",
  "string",
  "string.special",
  "tag",
  "type",
  "type.builtin",
  "variable.builtin",
  "variable.parameter",
]);

/** The same captures under the other names grammars use for them. */
const SYNONYMS: Readonly<Record<string, string>> = {
  boolean: "constant.builtin",
  character: "string",
  conditional: "keyword",
  repeat: "keyword",
  include: "keyword",
  exception: "keyword",
  float: "number",
  method: "function",
  namespace: "module",
  field: "property",
  parameter: "variable.parameter",
  regexp: "string.special",
  symbol: "string.special",
};

/** `function.method.call` → `function`; `boolean` → `constant.builtin`; unknown → `undefined`. */
export function captureClass(name: string): string | undefined {
  let scope = name;
  for (;;) {
    const known = KNOWN.has(scope) ? scope : SYNONYMS[scope];
    if (known) return `lmsh-${known.replace(/\./g, "-")}`;
    const dot = scope.lastIndexOf(".");
    if (dot < 0) return undefined;
    scope = scope.slice(0, dot);
  }
}

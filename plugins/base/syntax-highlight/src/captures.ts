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

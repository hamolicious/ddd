export const RUNTIME_SPECIFIERS = {
  "@kernel": "kernel.js",

  react: "react.js",
  "react/jsx-runtime": "react-jsx-runtime.js",
  "react-dom": "react-dom.js",
  "react-dom/client": "react-dom-client.js",

  yjs: "yjs.js",

  "@codemirror/state": "codemirror-state.js",
  "@codemirror/view": "codemirror-view.js",
  "@codemirror/commands": "codemirror-commands.js",
  "@codemirror/language": "codemirror-language.js",
  "@lezer/common": "lezer-common.js",
  "@lezer/highlight": "lezer-highlight.js",
  "y-codemirror.next": "y-codemirror.js",

  unified: "unified.js",
  "remark-parse": "remark-parse.js",
  "remark-gfm": "remark-gfm.js",
  "remark-directive": "remark-directive.js",
} as const satisfies Record<string, string>;

export type RuntimeSpecifier = keyof typeof RUNTIME_SPECIFIERS;

export const RUNTIME_SPECIFIER_NAMES: readonly string[] = Object.keys(RUNTIME_SPECIFIERS).sort();

export const RUNTIME_MANIFEST_FILE = "runtime-manifest.json";

export function packageOf(specifier: string): string | undefined {
  if (specifier === "@kernel") return undefined;
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

import type { EmojiSet } from "./emojis.js";

interface Node {
  type: string;
  value?: string;
  children?: Node[];
}

const SHORTCODE = /(?<![\p{L}\p{N}_]):([a-z0-9_+-]+):/gu;

export function replaceShortcodes(text: string, set: EmojiSet): string {
  return text.replace(SHORTCODE, (whole, name: string) => set.byName.get(name)?.emoji ?? whole);
}

export function remarkShortcodes(set: EmojiSet) {
  const visit = (node: Node): void => {
    if (node.type === "text" && typeof node.value === "string" && node.value.includes(":")) {
      node.value = replaceShortcodes(node.value, set);
    }
    if (node.children) for (const child of node.children) visit(child);
  };
  return () => visit;
}

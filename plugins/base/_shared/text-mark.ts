import * as Y from "yjs";

import type { EditorInsertion } from "plugin:editor";
import type { TextMark } from "plugin:editor";

export const INSERTION_ORIGIN = "editor.paste";

const settled: EditorInsertion = { replace: () => false, remove: () => false };

export function trackInsertion(text: Y.Text, from: number, content: string): EditorInsertion {
  const doc = text.doc;
  if (!doc || content.length === 0 || text.toString().slice(from, from + content.length) !== content) {
    return settled;
  }
  const start = Y.createRelativePositionFromTypeIndex(text, from, 0);
  const end = Y.createRelativePositionFromTypeIndex(text, from + content.length, -1);
  let done = false;

  const swap = (next: string): boolean => {
    if (done) return false;
    done = true;
    const a = Y.createAbsolutePositionFromRelativePosition(start, doc);
    const b = Y.createAbsolutePositionFromRelativePosition(end, doc);
    if (!a || !b || a.type !== text || b.type !== text) return false;
    if (text.toString().slice(a.index, b.index) !== content) return false;
    doc.transact(() => {
      text.delete(a.index, b.index - a.index);
      if (next.length > 0) text.insert(a.index, next);
    }, INSERTION_ORIGIN);
    return true;
  };

  return { replace: (next) => swap(next), remove: () => swap("") };
}

export function markAt(text: Y.Text, index: number): TextMark {
  let spot = Y.createRelativePositionFromTypeIndex(text, index, -1);
  return {
    insert: (content) => {
      const doc = text.doc;
      if (!doc || content.length === 0) return settled;
      const resolved = Y.createAbsolutePositionFromRelativePosition(spot, doc);
      const at = resolved && resolved.type === text ? resolved.index : text.length;
      doc.transact(() => text.insert(at, content), INSERTION_ORIGIN);
      spot = Y.createRelativePositionFromTypeIndex(text, at + content.length, -1);
      return trackInsertion(text, at, content);
    },
  };
}

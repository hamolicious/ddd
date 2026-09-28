/**
 * Places in a document's `Y.Text` that outlive the editor showing it.
 *
 * - {@link trackInsertion} follows text that was just inserted, so it can be swapped
 *   later (an upload's placeholder for the finished link).
 * - {@link markAt} is a spot to insert at later (where a `/attach` was typed, while the
 *   file picker is open).
 *
 * Both are anchored with Yjs relative positions rather than editor offsets: typing
 * elsewhere, a remote edit, or the user leaving Edit mode all move or unmount the editor,
 * and none of them may put the result in the wrong place. Any editor bound to a `Y.Text`
 * can hand these out, which is why they live here and not in `editor`.
 */

import * as Y from "yjs";

import type { EditorInsertion } from "@protocols/lm/editor.paste";
import type { TextMark } from "@protocols/lm/text.surface";

/**
 * Origin of the edits made through these. Not one `Y.UndoManager` tracks, so Mod-Z after
 * an upload does not put the "Uploading…" placeholder back.
 */
export const INSERTION_ORIGIN = "editor.paste";

const settled: EditorInsertion = { replace: () => false, remove: () => false };

/**
 * Follow `content`, just written at `from`, through whatever happens to the text next.
 *
 * The start sticks to the first inserted character and the end to the last, so typing
 * just before or after it stays outside. Replacing or removing settles it; after that,
 * both answer `false`.
 */
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
    // Edited or deleted since: it is the user's text now, not ours to replace.
    if (text.toString().slice(a.index, b.index) !== content) return false;
    doc.transact(() => {
      text.delete(a.index, b.index - a.index);
      if (next.length > 0) text.insert(a.index, next);
    }, INSERTION_ORIGIN);
    return true;
  };

  return { replace: (next) => swap(next), remove: () => swap("") };
}

/**
 * A spot at `index` to insert at later. Each insert lands after the previous one, so
 * several files arrive in order. The spot sticks to the character before it; at the very
 * start of the text it stays at the start.
 */
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

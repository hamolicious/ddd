/**
 * The bookkeeping for a folder that holds nothing yet.
 *
 * **There are no folder objects** (SPEC §6.5) — a folder is a prefix of the `fm.path`
 * values that exist, which is exactly why "new folder" has nowhere to write. The answer
 * is the smallest one that keeps that property true: an empty folder is remembered in
 * *this plugin's per-user settings* (`kernel.settings`, SPEC §6.4) and **forgotten the
 * moment a document lands in it**, because from then on `fm.path` is the truth and a
 * second record of the same fact could only ever disagree with it.
 *
 * So the settings list is not a folder table. It is a list of intentions that have not
 * been realised yet, and nearly every function here exists to make it shrink. They are
 * pure: *when* the shrunken list is stored is `index.tsx`'s decision (at the next write
 * it makes, never from the subscription that noticed), and the tree never waits for it —
 * a tracked folder that now holds a document is drawn once, from `fm.path`.
 *
 * - {@link pruneTracked} drops an entry as soon as a document is inside it.
 * - {@link withoutFolder} drops an entry and its descendants when a folder is deleted.
 * - {@link renameTracked} rewrites entries under a renamed prefix, so a rename does not
 *   strand one.
 * - {@link mergeTracked} is the one that does not, and it is here because "only shrinks"
 *   was not the whole truth: a list stored under a single settings key can also *lose* an
 *   entry to a concurrent write from another device, which is a folder the user made and
 *   cannot see. Its own comment has the rule that keeps the repair from resurrecting a
 *   folder somebody deleted on purpose.
 *
 * Two consequences worth stating. The list is **per user**, so an empty folder one person
 * creates is not on another person's tree until a document files itself there — which is
 * the honest reading of "a folder is where documents are", and it is why the delete of an
 * empty folder needs no confirmation: nothing outside that person's settings changes.
 * And settings are readable by other users (SPEC §6.4) — folder names are not secrets,
 * and nothing else is stored.
 */

import { isWithin, normalizePath, renamedPath, type PathRow } from "./path.js";

/** The settings key holding the list. */
export const EMPTY_FOLDERS_KEY = "emptyFolders";

/**
 * How many empty folders are remembered at once.
 *
 * A settings value is one YAML line (SPEC §3.3), so this list has a real cost per entry
 * and no natural bound — "new folder" clicked repeatedly would grow it forever. Past the
 * cap the **oldest** entry falls off: a folder created a hundred folders ago that has
 * still never held a document is the one nobody is waiting on.
 */
export const TRACKED_LIMIT = 100;

/**
 * Read a settings value into a clean list: normalized, de-duplicated, insertion order
 * preserved. Anything that is not a list of strings reads as empty rather than throwing —
 * the value is in a shared document a human can edit (SPEC §6.4).
 */
export function readTracked(value: unknown): readonly string[] {
  const raw: readonly unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string" && value !== ""
      ? value.split(",")
      : [];
  const out: string[] = [];
  for (const entry of raw) {
    const path = normalizePath(typeof entry === "string" ? entry : "");
    if (path !== "" && !out.includes(path)) out.push(path);
  }
  return out;
}

/** Remember one folder. Idempotent, and capped (see {@link TRACKED_LIMIT}). */
export function withFolder(tracked: readonly string[], folder: string): readonly string[] {
  const path = normalizePath(folder);
  if (path === "" || tracked.includes(path)) return tracked;
  const next = [...tracked, path];
  return next.length > TRACKED_LIMIT ? next.slice(next.length - TRACKED_LIMIT) : next;
}

/** Forget a folder and everything under it — what deleting a folder does to this list. */
export function withoutFolder(tracked: readonly string[], folder: string): readonly string[] {
  const path = normalizePath(folder);
  if (path === "") return tracked;
  return tracked.filter((entry) => !isWithin(entry, path));
}

/**
 * Drop every entry a document has moved into.
 *
 * The test is "is any document inside this folder", not "is any document *exactly* here":
 * a document filed at `a/b/c` makes `a/b` real too, and leaving `a/b` in the list would
 * keep a second, silently redundant record of a folder that now exists on its own.
 */
export function pruneTracked(
  tracked: readonly string[],
  rows: readonly PathRow[],
): readonly string[] {
  if (tracked.length === 0) return tracked;
  const paths = rows.map((row) => normalizePath(row.fm["path"])).filter((path) => path !== "");
  const kept = tracked.filter((entry) => !paths.some((path) => isWithin(path, entry)));
  // The same array back when nothing was dropped, so a caller can skip a settings write
  // (and the CRDT round trip under it) on identity alone.
  return kept.length === tracked.length ? tracked : kept;
}

/** Rewrite entries under `from`, the way a rename rewrites `fm.path` under it. */
export function renameTracked(
  tracked: readonly string[],
  from: string,
  to: string,
): readonly string[] {
  const out: string[] = [];
  for (const entry of tracked) {
    const next = renamedPath(entry, from, to) ?? entry;
    // The target may already be tracked — a rename that merges two empty folders is one
    // folder afterwards, exactly as it would be for two folders full of documents.
    if (next !== "" && !out.includes(next)) out.push(next);
  }
  return out;
}

/**
 * Fold entries this device wrote back into a stored list that does not have them.
 *
 * **The one place the "it only shrinks" story was wrong.** The whole list lives under
 * one settings key, so two devices that each create a folder write `emptyFolders:` at
 * the same moment; the settings host resolves duplicate lines last-occurrence-wins
 * (SPEC §3.3), and the folder created on the losing device is gone from both trees with
 * no error anywhere. A dropped entry is the *opposite* failure from the stale one this
 * module is written around: a stale entry is a folder that exists anyway, a dropped one
 * is a folder the user made and cannot see.
 *
 * So a write is merged rather than adopted: the stored list wins on order and on
 * everything it contains, and entries this device wrote **and has not yet seen come
 * back** are appended. `index.tsx` holds that "not yet seen" set and clears an entry the
 * first time a stored value contains it — which is what stops this from resurrecting a
 * folder somebody deliberately deleted later. Once an entry has round-tripped it is the
 * shared list's to remove.
 *
 * Pure, and capped the same way {@link withFolder} is.
 */
export function mergeTracked(
  stored: readonly string[],
  unconfirmed: readonly string[],
): readonly string[] {
  let out = stored;
  for (const entry of unconfirmed) out = withFolder(out, entry);
  return out;
}

/** `true` when the two lists hold the same entries in the same order. */
export function sameTracked(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

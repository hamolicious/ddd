/**
 * Machine-owned documents, and why the browsing plugins hide them by default.
 *
 * # The problem
 *
 * The kernel stores each user's settings as a **document** (SPEC §6.4) with
 * `fm.path: .settings`. That is the right design — sync, offline reads, CRDT merging,
 * snapshots, Trash and the admin export all come for free because a settings document
 * is just a document — and it has one visible consequence nobody chose: a workspace of
 * eleven notes read "12 documents", and the folder tree grew a `.settings` folder
 * containing one file per user, sitting above `home` in alphabetical order. The count
 * was wrong for the only question a person asks it ("how many notes do I have?"), and
 * the folder was a thing you could open, drag documents into, and rename.
 *
 * # The rule
 *
 * **A document whose `fm.path` begins with `.` is machine-owned**, and is left out of
 * the default document list, the folder tree and search results.
 *
 * The dotfile convention rather than a hard-coded `.settings`, for two reasons. It is
 * already the spelling the kernel picked, and it is the one convention every user of a
 * file manager already knows — nobody has to be told what `.settings` means. And it
 * generalises without a registry: a plugin that wants its own machine-owned documents
 * files them under a dotted path and is hidden by the same rule, with no list of
 * special paths for anyone to keep up to date.
 *
 * # What it is *not*
 *
 * **Not access control and not deletion.** Every one of these documents is a document:
 * readable, editable, linkable, exportable, and visible to every user in the shared
 * workspace (SPEC §5.4). Hiding is a default view, revealed by a toggle
 * (`doc-list`'s filter bar, `search`'s results page), and every deep link keeps working
 * whether or not the toggle is on. Nothing here changes what the server returns, what
 * the local index holds, or what `kernel.documents` answers — the kernel knows one
 * domain model and "machine-owned" is not part of it (SPEC §2). This is a convention
 * three *plugins* share, which is exactly the layer it belongs in.
 *
 * **Not the folder tree's `.`-stripping.** `folders` drops `.` and `..` as path
 * *segments* (they are label characters, not a filesystem); `.settings` is a perfectly
 * ordinary segment that survives that rule and has to be excluded on purpose.
 */

import type { FilterJson } from "@kernel";

/** A `fm.path` starting with this is machine-owned. */
export const MACHINE_PATH_PREFIX = ".";

/**
 * Is this the `fm.path` of a machine-owned document?
 *
 * Tested against the **raw stored value**, not a normalized one, so that it agrees
 * exactly with {@link EXCLUDE_MACHINE_DOCUMENTS} — the filter DSL compares the stored
 * string and cannot trim. A non-string `fm.path` (a number, a list, a missing key) is
 * not machine-owned: the workspace is shared and a plugin cannot assume a human typed
 * what it expected.
 */
export function isMachinePath(raw: unknown): boolean {
  return typeof raw === "string" && raw.startsWith(MACHINE_PATH_PREFIX);
}

/** The same question about a projection row. */
export function isMachineDocument(row: { readonly fm: Readonly<Record<string, unknown>> }): boolean {
  return isMachinePath(row.fm["path"]);
}

/**
 * The DSL clause that keeps machine-owned documents out of a query.
 *
 * `not(text starts_with)` rather than a comparison against `.settings`, and the
 * `missing`-field behaviour is the load-bearing half: the core's `text_match` answers
 * `Ok(false)` for a field that is not there (`filter/evaluator.rs`), so `not` of it is
 * **true** — a document with no `fm.path` at all, which is most of them, stays in the
 * results. A clause that errored on a missing field would negate to an error and
 * silently empty the list.
 */
export const EXCLUDE_MACHINE_DOCUMENTS: FilterJson = {
  not: { text: { field: "fm.path", mode: "starts_with", value: MACHINE_PATH_PREFIX } },
};

/**
 * Add the exclusion to a filter a view has already built — `undefined` in, the bare
 * exclusion out, so "no filter" and "no filter, minus machine documents" are both
 * expressible without the caller special-casing either.
 */
export function withoutMachineDocuments(filter?: FilterJson): FilterJson {
  return filter === undefined ? EXCLUDE_MACHINE_DOCUMENTS : { and: [filter, EXCLUDE_MACHINE_DOCUMENTS] };
}

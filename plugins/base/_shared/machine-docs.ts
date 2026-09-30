/**
 * Machine-owned documents, and why the browsing plugins hide them by default.
 *
 * # The problem
 *
 * The kernel stores each user's settings as a **document** (SPEC §6.4). That is the
 * right design — sync, offline reads, CRDT merging, snapshots, Trash and the admin
 * export all come for free because a settings document is just a document — and it has
 * one visible consequence nobody chose: a workspace of eleven notes read "12 documents",
 * and the settings documents showed up in the tree and in search next to people's notes.
 *
 * # The rule
 *
 * **A document with `machine: true` in its frontmatter is machine-owned**, and is left
 * out of the default document list, the folder tree and search results.
 *
 * One flag rather than a list of special documents: a plugin that wants its own
 * machine-owned documents writes the same line and is hidden by the same rule, with no
 * registry for anyone to keep up to date.
 *
 * # What it is *not*
 *
 * **Not access control and not deletion.** Every one of these documents is a document:
 * readable, editable, linkable, exportable, and visible to every user in the shared
 * workspace (SPEC §5.4). Hiding is a default view, revealed by a toggle
 * (`search`'s filter bar), and every deep link keeps working
 * whether or not the toggle is on. Nothing here changes what the server returns, what
 * the local index holds, or what `kernel.documents` answers — the kernel knows one
 * domain model and "machine-owned" is not part of it (SPEC §2). This is a convention
 * three *plugins* share, which is exactly the layer it belongs in.
 */

import type { FilterJson } from "@kernel";

/** The frontmatter key that marks a machine-owned document. */
export const MACHINE_KEY = "machine";

/**
 * Is this the `fm` of a machine-owned document?
 *
 * Exactly `true`, so it agrees with {@link EXCLUDE_MACHINE_DOCUMENTS} — the filter DSL
 * compares types strictly, and `machine: yes` is a human's string, not the flag.
 */
export function isMachineDocument(row: { readonly fm: Readonly<Record<string, unknown>> }): boolean {
  return row.fm[MACHINE_KEY] === true;
}

/**
 * The DSL clause that keeps machine-owned documents out of a query.
 *
 * The `missing`-field behaviour is the load-bearing half: the core's comparison answers
 * `Ok(false)` for a field that is not there (`filter/evaluator.rs`), so `not` of it is
 * **true** — a document with no `machine` key, which is nearly all of them, stays in the
 * results. A clause that errored on a missing field would negate to an error and
 * silently empty the list.
 */
export const EXCLUDE_MACHINE_DOCUMENTS: FilterJson = {
  not: { cmp: { field: `fm.${MACHINE_KEY}`, op: "eq", value: { bool: true } } },
};

/**
 * Add the exclusion to a filter a view has already built — `undefined` in, the bare
 * exclusion out, so "no filter" and "no filter, minus machine documents" are both
 * expressible without the caller special-casing either.
 */
export function withoutMachineDocuments(filter?: FilterJson): FilterJson {
  return filter === undefined ? EXCLUDE_MACHINE_DOCUMENTS : { and: [filter, EXCLUDE_MACHINE_DOCUMENTS] };
}

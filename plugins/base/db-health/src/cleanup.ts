/**
 * Which duplicate copies a bulk removal takes, by what it keeps.
 *
 * Copies arrive oldest first (the server sorts them). Every strategy keeps at least one
 * copy of each group; only `unused` is guaranteed not to break anything, because the
 * others can remove a copy a note still uses.
 *
 * - `unused`: every copy nothing uses, as long as one copy stays — when no copy is used,
 *   the oldest is kept.
 * - `oldest` / `newest`: everything but the oldest / newest copy.
 * - `most-used`: everything but the copy the most notes use (ties: the oldest).
 */

export type Strategy = "unused" | "oldest" | "newest" | "most-used";

/** Labels read after "Keep". */
export const STRATEGIES: readonly { readonly id: Strategy; readonly label: string }[] = [
  { id: "unused", label: "Every copy in use" },
  { id: "oldest", label: "The oldest copy" },
  { id: "newest", label: "The newest copy" },
  { id: "most-used", label: "The most used copy" },
];

export function copiesToRemove<T extends { readonly references: number }>(
  copies: readonly T[],
  strategy: Strategy,
): readonly T[] {
  if (copies.length < 2) return [];
  switch (strategy) {
    case "oldest":
      return copies.slice(1);
    case "newest":
      return copies.slice(0, -1);
    case "most-used": {
      const keep = copies.reduce((best, copy) => (copy.references > best.references ? copy : best));
      return copies.filter((copy) => copy !== keep);
    }
    default: {
      const unused = copies.filter((copy) => copy.references === 0);
      return unused.length < copies.length ? unused : unused.slice(1);
    }
  }
}

/** Every copy `strategy` removes across `groups`. */
export function allToRemove<G, T extends { readonly references: number }>(
  groups: readonly G[],
  copiesOf: (group: G) => readonly T[],
  strategy: Strategy,
): readonly T[] {
  return groups.flatMap((group) => copiesToRemove(copiesOf(group), strategy));
}

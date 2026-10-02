/**
 * Which duplicate copies can go without anything noticing.
 *
 * A copy nothing uses is safe to remove **as long as one copy stays**. So when some copy
 * of a group is used, every unused copy can go; when none is, all can go but the oldest
 * (the server lists copies oldest first), which is kept as *the* file or note.
 */

export function removableCopies<T extends { readonly references: number }>(copies: readonly T[]): readonly T[] {
  const unused = copies.filter((copy) => copy.references === 0);
  const anyUsed = unused.length < copies.length;
  return anyUsed ? unused : unused.slice(1);
}

/** Every removable copy across `groups`. */
export function allRemovable<G, T extends { readonly references: number }>(
  groups: readonly G[],
  copiesOf: (group: G) => readonly T[],
): readonly T[] {
  return groups.flatMap((group) => removableCopies(copiesOf(group)));
}

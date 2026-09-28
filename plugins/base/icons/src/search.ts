/**
 * Icon search over `index.json`: pure, so it is tested without a browser.
 *
 * Every word typed must match the icon somewhere: in its name, its category or a tag.
 * Among those, a name that *is* the query ranks first, then names starting with it, then
 * names containing it, then the rest; ties go alphabetically, which is the index's order.
 */

/** `frontend/tabler/index.json`, as `build.mjs` writes it. */
export interface IconIndex {
  readonly version: string;
  readonly categories: readonly string[];
  readonly suggested: readonly string[];
  /** `[name, category index, space-separated tags]`, sorted by name. */
  readonly icons: readonly (readonly [string, number, string])[];
}

export interface IconHit {
  readonly name: string;
  readonly category: string;
  readonly tags: readonly string[];
}

const hit = (index: IconIndex, entry: readonly [string, number, string]): IconHit => ({
  name: entry[0],
  category: index.categories[entry[1]] ?? "",
  tags: entry[2] === "" ? [] : entry[2].split(" "),
});

/**
 * Best matches first. An empty query is every icon: the suggested ones first, in their
 * order, then the rest by name.
 */
export function searchIcons(index: IconIndex, query: string, limit = Infinity): readonly IconHit[] {
  const words = query.toLowerCase().trim().split(/[\s]+/).filter(Boolean);
  if (words.length === 0) {
    const byName = new Map(index.icons.map((entry) => [entry[0], entry]));
    const suggested = index.suggested.flatMap((name) => {
      const entry = byName.get(name);
      return entry ? [entry] : [];
    });
    const first = new Set(suggested.map((entry) => entry[0]));
    return [...suggested, ...index.icons.filter((entry) => !first.has(entry[0]))]
      .slice(0, limit)
      .map((entry) => hit(index, entry));
  }

  const phrase = words.join("-");
  const scored: { entry: readonly [string, number, string]; score: number; order: number }[] = [];
  index.icons.forEach((entry, order) => {
    const [name, category, tags] = entry;
    const haystack = `${name} ${(index.categories[category] ?? "").toLowerCase()} ${tags.toLowerCase()}`;
    if (!words.every((word) => haystack.includes(word))) return;
    const score =
      name === phrase ? 0 : name.startsWith(phrase) ? 1 : name.includes(phrase) ? 2 : 3;
    scored.push({ entry, score, order });
  });
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  return scored.slice(0, limit).map(({ entry }) => hit(index, entry));
}

/**
 * The emoji set, as `build.mjs` packed it, and the lookups over it. Pure apart from `load`.
 */

/** `[emoji, "shortcode another", "tags and description"]`, one per emoji. */
export type PackedEmoji = readonly [string, string, string];

export interface Emoji {
  readonly emoji: string;
  /** Every shortcode, the preferred one first. */
  readonly names: readonly string[];
  /** Tags and description, lower case: what a search matches besides the shortcodes. */
  readonly words: string;
}

export interface EmojiSet {
  readonly all: readonly Emoji[];
  /** Shortcode → emoji. */
  readonly byName: ReadonlyMap<string, Emoji>;
}

export function unpack(packed: readonly PackedEmoji[]): EmojiSet {
  const all: Emoji[] = [];
  const byName = new Map<string, Emoji>();
  for (const [emoji, names, words] of packed) {
    const entry: Emoji = { emoji, names: names.split(" "), words };
    all.push(entry);
    for (const name of entry.names) byName.set(name, entry);
  }
  return { all, byName };
}

const base = import.meta.url;

/** Fetch the set from next to this module. */
export async function load(): Promise<EmojiSet> {
  const response = await fetch(new URL("gemoji/index.json", base).href);
  if (!response.ok) throw new Error(`emoji: index.json: ${response.status}`);
  return unpack((await response.json()) as PackedEmoji[]);
}

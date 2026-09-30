/**
 * `icons` — the Tabler icon set (tabler.io/icons, MIT), for other plugins to draw and to let
 * people pick from.
 *
 * ## API (`plugin:icons`)
 *
 * - `Icon` — `ComponentType<IconProps>`: one icon by name.
 * - `Picker` — `ComponentType<IconPickerProps>`: a search box over a grid of icons.
 * - `search(query, limit?)` → `Promise<readonly IconInfo[]>`: best matches first.
 * - `has(name)` → `Promise<boolean>`.
 * - Types: `IconProps`, `IconPickerProps`, `IconInfo`, `Icons` (all of the above as one type).
 *
 * Nothing here knows who draws icons. `build.mjs` packs the set pinned in `tabler.json`
 * into `frontend/tabler/`; `data.ts` fetches it a shard at a time as names are drawn, and
 * the search index only when something searches (`search.ts`). None of it needs the
 * kernel, so every export works before `activate` too.
 */

import type { IconInfo } from "./api.js";
import { drawingNow, loadDrawing, loadIndex } from "./data.js";
import { searchIcons } from "./search.js";

export type { IconInfo, IconPickerProps, IconProps, Icons } from "./api.js";
export { Icon } from "./Icon.js";
export { Picker } from "./Picker.js";

/** Best matches first, by name, then tags. An empty query is every icon, a suggested few first. */
export async function search(query: string, limit?: number): Promise<readonly IconInfo[]> {
  return searchIcons(await loadIndex(), query, limit);
}

/** Whether the set has an icon by this name. */
export async function has(name: string): Promise<boolean> {
  await loadDrawing(name);
  return drawingNow(name) !== undefined;
}

export default function activate(): void {}

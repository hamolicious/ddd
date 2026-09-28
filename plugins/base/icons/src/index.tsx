/**
 * `icons` — the Tabler icon set (tabler.io/icons, MIT), served on `lm/icons`.
 *
 * Nothing here knows who draws icons. `build.mjs` packs the set pinned in `tabler.json`
 * into `frontend/tabler/`; `data.ts` fetches it a shard at a time as names are drawn, and
 * the search index only when something searches (`search.ts`). `Icon` draws one by name;
 * `Picker` is the search-and-grid a plugin puts in its own sheet to let someone choose.
 */

import type { Kernel } from "@kernel";

import type { Icons } from "@protocols/lm/icons";

import { drawingNow, loadDrawing, loadIndex } from "./data.js";
import { Icon } from "./Icon.js";
import { Picker } from "./Picker.js";
import { searchIcons } from "./search.js";

export default function activate(kernel: Kernel): void {
  kernel.ports.serve<Icons>("icons", {
    Icon,
    Picker,
    search: async (query, limit) => searchIcons(await loadIndex(), query, limit),
    has: async (name) => {
      await loadDrawing(name);
      return drawingNow(name) !== undefined;
    },
  });
}

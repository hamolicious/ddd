import { useSyncExternalStore } from "react";

import type { ArrangementStore } from "./arrangement.js";
import type { Arrangement } from "./layout.js";

export function useArrangement(store: ArrangementStore): Arrangement {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

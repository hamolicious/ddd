import { useSyncExternalStore } from "react";

import type { ShellLayout, ShellUiApi } from "../../_shared/shell-api.js";

import type { ArrangementStore } from "./arrangement.js";
import type { Arrangement } from "./layout.js";

export function useLayout(shell: ShellUiApi): ShellLayout {
  return useSyncExternalStore(shell.subscribeLayout, shell.layout, shell.layout);
}

export function useArrangement(store: ArrangementStore): Arrangement {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

import { useSyncExternalStore } from "react";

import type { ShellSnapshot, ShellState } from "./state.js";

export function useShell(state: ShellState): ShellSnapshot {
  return useSyncExternalStore(state.subscribe, state.snapshot, state.snapshot);
}

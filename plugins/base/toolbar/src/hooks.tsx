import { useCallback, useSyncExternalStore } from "react";

import { layout, subscribeLayout } from "plugin:shell-ui";

import type { ArrangementStore } from "./arrangement.js";
import type { Arrangement, Profile } from "./layout.js";

export function useArrangement(store: ArrangementStore, profile: Profile): Arrangement {
  const get = useCallback(() => store.get(profile), [store, profile]);
  return useSyncExternalStore(store.subscribe, get, get);
}

/** The shell's layout, live. */
export const useShellLayout = () => useSyncExternalStore(subscribeLayout, layout, layout);

/** Which profile this device is showing: the shell's mobile breakpoint decides. */
export function useProfile(): Profile {
  return useShellLayout().compact ? "mobile" : "desktop";
}

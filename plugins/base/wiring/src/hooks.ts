/** The store, as React sees it. */

import { useSyncExternalStore } from "react";

import type { EditorState, EditorStore } from "./store.js";

export function useEditor(store: EditorStore): EditorState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

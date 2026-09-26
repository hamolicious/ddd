import { useEffect, useState, useSyncExternalStore } from "react";

import type { Kernel, Notice, SyncState } from "@kernel";

import type { ShellLayout, ShellUiApi } from "../../_shared/shell-api.js";

export function useLayout(shell: ShellUiApi): ShellLayout {
  return useSyncExternalStore(shell.subscribeLayout, shell.layout, shell.layout);
}

export function useSyncState(kernel: Kernel): SyncState {
  const [state, setState] = useState<SyncState>(() => kernel.sync.state);
  useEffect(() => kernel.sync.subscribe(setState), [kernel]);
  return state;
}

export function useNotices(kernel: Kernel): readonly Notice[] {
  const [notices, setNotices] = useState<readonly Notice[]>(() => kernel.ui.notices());
  useEffect(() => kernel.ui.onNotices(setNotices), [kernel]);
  return notices;
}

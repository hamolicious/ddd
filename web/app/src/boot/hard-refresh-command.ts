import { asPluginSync, type KernelHost } from "@kernel/runtime/index.js";

import { hardRefresh } from "./hard-refresh.js";

export const HARD_REFRESH_COMMAND_ID = "kernel.hardRefresh";

interface CommandsModule {
  readonly addCommand?: (command: {
    readonly id: string;
    readonly title: string;
    readonly category?: string;
    readonly icon?: string;
    readonly run: () => void | Promise<void>;
  }) => () => void;
}

export async function contributeHardRefreshCommand(host: KernelHost): Promise<void> {
  if (!host.plugins.active("commands")) return;
  const specifier = "plugin:commands";
  const commands = (await import(/* @vite-ignore */ specifier)) as CommandsModule;
  asPluginSync("kernel", () =>
    commands.addCommand?.({
      id: HARD_REFRESH_COMMAND_ID,
      title: "Hard refresh (clear app cache)",
      category: "App",
      icon: "refresh",
      run: () => hardRefresh(),
    }),
  );
}

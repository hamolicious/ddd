/**
 * The palette's "Hard refresh (clear app cache)" command (`hard-refresh.ts`).
 *
 * Contributed by the kernel rather than by a plugin, like the shell's settings section
 * (`ShellSection.tsx`): what it clears is the app's own caches, and it must be there
 * whichever plugins are installed. Added once the plugins have activated, and only to a
 * signed-in workspace — that is the only place this runs. Without an active `commands`
 * plugin there is no palette to put it in, and nothing happens.
 */

import { asPluginSync, type KernelHost } from "@kernel/runtime/index.js";

import { hardRefresh } from "./hard-refresh.js";

export const HARD_REFRESH_COMMAND_ID = "kernel.hardRefresh";

/** The part of `plugin:commands` this file uses; typed here so the app does not compile a plugin. */
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
  // Through a variable, like the loader: the import map hands back the activated instance.
  const specifier = "plugin:commands";
  const commands = (await import(/* @vite-ignore */ specifier)) as CommandsModule;
  asPluginSync("kernel", () =>
    commands.addCommand?.({
      id: HARD_REFRESH_COMMAND_ID,
      // Drops the cached app and plugins and reloads; stays signed in, keeps local data.
      title: "Hard refresh (clear app cache)",
      category: "App",
      icon: "refresh",
      run: () => hardRefresh(),
    }),
  );
}

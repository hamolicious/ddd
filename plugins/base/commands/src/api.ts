/**
 * What `commands` exports to other plugins (`plugin:commands`): the contribution types
 * and the module-scope registries that collect them.
 */

import { createRegistry, s } from "@kernel";

/**
 * A command: one id, one title, one function. The palette lists them; keybindings run
 * them. Two plugins adding one id: the later replaces the earlier.
 *
 * A command with `takes: "documents"` acts on documents it is handed: its argument is the
 * ids, as `readonly string[]`. The document list's Actions button offers it for the
 * documents listed; the palette and keybindings, which have no documents to hand it,
 * leave it out.
 */
export interface Command {
  readonly id: string;
  readonly title: string;
  readonly run: (argument?: unknown) => void | Promise<void>;
  /** Grouping in the palette. */
  readonly category?: string;
  /** An icon's name in `plugin:icons` (Tabler), drawn beside the title. */
  readonly icon?: string;
  /** What the command acts on. `"documents"`: `run` gets `readonly string[]` of document ids. */
  readonly takes?: "documents";
  /** Return `false` to hide the command in the current context. */
  readonly when?: () => boolean;
}

/**
 * A suggested default binding. The user's own configuration wins; between plugins, the
 * one added first wins and conflicts are listed rather than silently resolved. `keys` is
 * a chord in the canonical spelling: `Mod+K` (`Mod` is Cmd on Apple, Ctrl elsewhere),
 * `Shift+Alt+F`, or a sequence like `g d`.
 */
export interface KeybindingDefault {
  readonly command: string;
  readonly keys: string;
  readonly when?: string;
}

/** The command registry as a service, for plugins that run commands rather than add them. */
export interface Commands {
  /** Every command enabled right now, in the order they were added. */
  readonly list: () => readonly Command[];
  /** Run a command by id. Rejects for an unknown id; does nothing when its `when()` says no. */
  readonly run: (id: string, argument?: unknown) => Promise<void>;
  readonly openPalette: (initialQuery?: string) => void;
}

export const commandRegistry = createRegistry<Command>({
  key: (command) => command.id,
  shape: s.object({
    id: s.string(),
    title: s.string(),
    run: s.func(),
    category: s.optional(s.string()),
    icon: s.optional(s.string()),
    takes: s.optional(s.literal("documents")),
    when: s.optional(s.func()),
  }),
});

export const keybindingRegistry = createRegistry<KeybindingDefault>({
  key: (binding) => `${binding.keys}\u0000${binding.command}`,
  shape: s.object({
    command: s.string(),
    keys: s.string(),
    when: s.optional(s.string()),
  }),
});

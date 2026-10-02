import { createRegistry, s } from "@kernel";

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly run: (argument?: unknown) => void | Promise<void>;
  readonly category?: string;
  readonly icon?: string;
  readonly takes?: "documents";
  readonly when?: () => boolean;
}

export interface KeybindingDefault {
  readonly command: string;
  readonly keys: string;
  readonly when?: string;
}

export interface Commands {
  readonly list: () => readonly Command[];
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

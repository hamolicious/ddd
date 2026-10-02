import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { Kernel, Unsubscribe } from "@kernel";
import { addSection, open as openSettings } from "plugin:settings";
import { addOverlay } from "plugin:shell-ui";

import { commandRegistry, keybindingRegistry, type Command, type KeybindingDefault } from "./api.js";
import {
  parseOverrides,
  resolveBindings,
  serializeOverrides,
  type ResolvedBindings,
} from "./bindings.js";
import { createKeybindingsSection } from "./KeybindingsSection.js";
import { RECENT_STORAGE_KEY, parseRecent, pushRecent } from "./recent.js";
import {
  eventKeys,
  isApplePlatform,
  isBareChord,
  isTypingTarget,
  normalizeKeys,
  parseChord,
} from "./keys.js";
import { Palette } from "./Palette.js";

export type { Command, Commands, KeybindingDefault } from "./api.js";

type IconsModule = typeof import("plugin:icons");
type ToolbarModule = typeof import("plugin:toolbar");

const PALETTE_ICON = (
  <svg aria-hidden="true" viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
  </svg>
);

const SEQUENCE_TIMEOUT_MS = 1_500;

const OVERRIDES_KEY = "keybindings";

const teardown: (() => void)[] = [];

export interface CommandsApi {
  run(id: string, argument?: unknown): Promise<void>;
  list(): readonly Command[];
  openPalette(initialQuery?: string): void;
  closePalette(): void;
  binding(commandId: string): string | undefined;
  conflicts(): readonly { readonly keys: string; readonly commands: readonly string[] }[];
  onPaletteToggle(listener: (open: boolean) => void): Unsubscribe;
}

export const addCommand: (items: Command | readonly Command[]) => () => void = commandRegistry.add;
export const addKeybinding: (items: KeybindingDefault | readonly KeybindingDefault[]) => () => void =
  keybindingRegistry.add;

let resolved: ResolvedBindings = resolveBindings([], new Map());
let paletteOpen = false;
let paletteQuery = "";
const paletteListeners = new Set<(open: boolean) => void>();

export async function run(id: string, argument?: unknown): Promise<void> {
  const command = commandRegistry.get().find((entry) => entry.id === id);
  if (!command) throw new Error(`unknown command: ${id}`);
  if (command.when && !command.when()) return;
  await command.run(argument);
}

export function list(): readonly Command[] {
  return commandRegistry.get().filter((command) => !command.when || command.when());
}

export function openPalette(initialQuery = ""): void {
  paletteQuery = initialQuery;
  paletteOpen = true;
  for (const listener of [...paletteListeners]) listener(true);
}

export function closePalette(): void {
  if (!paletteOpen) return;
  paletteOpen = false;
  for (const listener of [...paletteListeners]) listener(false);
}

export function binding(commandId: string): string | undefined {
  return resolved.byCommand.get(commandId);
}

export function conflicts(): readonly { readonly keys: string; readonly commands: readonly string[] }[] {
  return resolved.conflicts;
}

export function onPaletteToggle(listener: (open: boolean) => void): Unsubscribe {
  paletteListeners.add(listener);
  return () => {
    paletteListeners.delete(listener);
  };
}

const api: CommandsApi = { run, list, openPalette, closePalette, binding, conflicts, onPaletteToggle };

export default function activate(kernel: Kernel): void {
  const commands = commandRegistry;
  const keybindings = keybindingRegistry;
  let icons: IconsModule | undefined;
  void kernel.plugins
    .optional<IconsModule>("icons")
    .then((module) => {
      icons = module;
    })
    .catch((cause: unknown) => kernel.log.warn("icons unavailable; the palette shows none", cause));
  void kernel.plugins
    .optional<ToolbarModule>("toolbar")
    .then((toolbar) => {
      if (!toolbar) return;
      teardown.push(
        toolbar.addItem({
          id: "commands.palette",
          label: "Commands",
          icon: PALETTE_ICON,
          side: "end",
          order: 70,
          onSelect: () => api.openPalette(),
        }),
      );
    })
    .catch((cause: unknown) => kernel.log.warn("toolbar unavailable; no Commands button", cause));

  const runnable = (): readonly Command[] => api.list().filter((command) => command.takes === undefined);
  const takesArgument = (id: string): boolean =>
    commands.get().some((command) => command.id === id && command.takes !== undefined);

  let settingsUsable = true;

  function guardSettings<T>(what: string, body: () => T, fallback: T): T {
    try {
      const value = body();
      settingsUsable = true;
      return value;
    } catch (cause) {
      if (settingsUsable) kernel.log.warn(`keybinding overrides unavailable (${what})`, cause);
      settingsUsable = false;
      return fallback;
    }
  }

  guardSettings<void>(
    "defineSchema",
    () =>
      kernel.settings.defineSchema({
        [OVERRIDES_KEY]: {
          type: "list",
          label: "Keybinding overrides",
          description: "One `command=keys` entry per binding you have changed.",
        },
      }),
    undefined,
  );

  const readOverrides = (): Map<string, string> =>
    guardSettings("get", () => parseOverrides(kernel.settings.get(OVERRIDES_KEY)), new Map());

  const writeOverrides = async (next: ReadonlyMap<string, string>): Promise<void> => {
    await kernel.settings.set(OVERRIDES_KEY, [...serializeOverrides(next)]);
    settingsUsable = true;
  };

  let overrides = readOverrides();
  resolved = resolveBindings(keybindings.get(), overrides);
  const changeListeners = new Set<() => void>();

  const announceChange = (): void => {
    for (const listener of [...changeListeners]) listener();
  };

  const recompute = (): void => {
    resolved = resolveBindings(keybindings.get(), overrides);
    announceChange();
  };

  keybindings.subscribe(() => recompute());
  commands.subscribe(() => announceChange());
  guardSettings<void>(
    "subscribe",
    () =>
      void kernel.settings.subscribe(() => {
        overrides = readOverrides();
        recompute();
      }),
    undefined,
  );

  let recent = ((): readonly string[] => {
    try {
      return parseRecent(localStorage.getItem(RECENT_STORAGE_KEY));
    } catch {
      return [];
    }
  })();

  const recordRun = (id: string): void => {
    if (id === "commands.openPalette") return;
    recent = pushRecent(recent, id);
    try {
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recent));
    } catch {
    }
  };

  const apple = isApplePlatform();
  let pending = "";
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  const clearPending = (): void => {
    pending = "";
    if (pendingTimer !== undefined) clearTimeout(pendingTimer);
    pendingTimer = undefined;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const chord = eventKeys(event, apple);
    if (chord === "") return;

    if (isBareChord(parseChord(chord)) && isTypingTarget(event.target)) {
      clearPending();
      return;
    }

    const candidate = pending === "" ? chord : `${pending} ${chord}`;
    const literal = apple ? undefined : candidate.replace(/\bMod\+/g, "Ctrl+");
    const commandId =
      resolved.byKeys.get(candidate) ?? (literal !== undefined ? resolved.byKeys.get(literal) : undefined);
    if (commandId !== undefined && !takesArgument(commandId)) {
      clearPending();
      event.preventDefault();
      recordRun(commandId);
      void api.run(commandId).catch((cause: unknown) => {
        kernel.log.error(`command "${commandId}" failed`, cause);
      });
      return;
    }
    if (resolved.prefixes.has(candidate)) {
      pending = candidate;
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(clearPending, SEQUENCE_TIMEOUT_MS);
      event.preventDefault();
      return;
    }
    clearPending();
  };

  window.addEventListener("keydown", onKeyDown, { capture: true });
  teardown.push(() => {
    window.removeEventListener("keydown", onKeyDown, { capture: true });
    clearPending();
  });

  addCommand([
    {
      id: "commands.openPalette",
      title: "Show all commands",
      category: "Commands",
      icon: "command",
      run: () => api.openPalette(),
    },
    {
      id: "commands.keybindings",
      title: "Edit keybindings",
      category: "Commands",
      icon: "keyboard",
      run: () => {
        openSettings("commands.keybindings");
      },
    },
    {
      id: "settings.open",
      title: "Open settings",
      category: "Settings",
      icon: "settings",
      run: () => openSettings(),
    },
  ]);
  addKeybinding([
    { command: "commands.openPalette", keys: "Mod+P" },
    { command: "settings.open", keys: "Mod+," },
  ]);

  const useBindings = (): ResolvedBindings => {
    const [, setRevision] = useState(0);
    useEffect(() => {
      const listener = (): void => setRevision((value) => value + 1);
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    }, []);
    return resolved;
  };

  const PaletteHost = (): ReactElement | null => {
    const bindings = useBindings();
    const [open, setOpen] = useState(paletteOpen);
    useEffect(() => api.onPaletteToggle(setOpen), []);
    const Icon = icons?.Icon;

    return (
      <>
        {open && (
          <Palette
            commands={runnable()}
            {...(Icon ? { renderIcon: (name: string) => <Icon name={name} /> } : {})}
            bindingFor={(id) => bindings.byCommand.get(id)}
            initialQuery={paletteQuery}
            conflictCount={bindings.conflicts.length}
            onShowConflicts={() => {
              api.closePalette();
              openSettings("commands.keybindings");
            }}
            recent={recent}
            onRun={(command) => {
              recordRun(command.id);
              void api.run(command.id).catch((cause: unknown) => {
                kernel.log.error(`command "${command.id}" failed`, cause);
              });
            }}
            onClose={() => api.closePalette()}
          />
        )}
      </>
    );
  };

  addOverlay({
    id: "commands.palette",
    component: PaletteHost,
  });

  addSection({
    id: "commands.keybindings",
    title: "Keybindings",
    order: 200,
    description: "Change any command's shortcut.",
    component: createKeybindingsSection({
      commands: runnable,
      bindings: () => resolved,
      subscribe: (listener) => {
        changeListeners.add(listener);
        return () => {
          changeListeners.delete(listener);
        };
      },
      setOverride: async (commandId, keys) => {
        const next = new Map(overrides);
        if (keys === null) {
          next.delete(commandId);
        } else if (keys === "") {
          next.set(commandId, "");
        } else {
          const canonical = normalizeKeys(keys);
          if (canonical === "") throw new Error(`"${keys}" is not a usable keybinding`);
          next.set(commandId, canonical);
        }
        await writeOverrides(next);
        overrides = next;
        recompute();
      },
      resetAll: async () => {
        await writeOverrides(new Map());
        overrides = new Map();
        recompute();
      },
      writable: () => settingsUsable,
    }),
  });
}

export function deactivate(): void {
  while (teardown.length > 0) teardown.pop()?.();
}

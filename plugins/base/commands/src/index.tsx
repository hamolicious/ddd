/**
 * `commands` — the command registry, the palette, and keybindings in one plugin
 * (SPEC §6.5). They are one plugin because a keybinding without a command is
 * meaningless and a palette is just a list of commands.
 *
 * The rules that matter:
 *
 * - **Per-user keybindings win.** Plugins offer *suggested defaults*
 *   (`lm/keybindings.default`); the user's configuration — a `kernel.settings` value on
 *   this plugin — overrides them.
 * - **The lower seat wins on a conflict, and conflicts are listed.** Two plugins
 *   claiming `Mod+K` is not resolved silently; the settings section shows both so the
 *   user can rebind one.
 * - **`Mod` is the portable modifier**: Cmd on Apple platforms, Ctrl elsewhere. A
 *   contribution spelling `Ctrl+K` gets Ctrl on a Mac, which is almost never intended.
 * - **The palette is keyboard-operable end to end** (SPEC §8 a11y): arrow keys, Enter,
 *   Escape, a live region announcing the result count, and focus restored on close.
 *
 * Three implementation decisions worth reading before changing anything here.
 *
 * **The dispatcher is one capturing `keydown` listener on `window`.** Capture phase, so
 * a chord reaches it before CodeMirror's own handlers; and a *bare* chord (nothing but
 * Shift) is ignored while focus is in a text surface, because `N` is a letter in an
 * editor and "new document" everywhere else. Sequences (`g d`) are supported through a
 * pending-prefix state with a timeout — the only stateful part, and it resets on any
 * key that continues nothing.
 *
 * **The palette renders as an `lm/shell.overlay`.** `shell-ui` owns the single
 * `kernel.ui.mount` (SPEC §6.4), so a plugin needing a persistent React presence
 * offers an always-mounted overlay. There is no button in the top bar: Mod+K (or
 * whatever it is rebound to) is the way in.
 *
 * **A command that `takes` documents is not the palette's.** It needs ids to act on, and
 * neither the palette nor a keystroke has any; the document list's Actions button runs
 * it, through the `lm/commands` service this plugin serves. The palette, the keybindings
 * table and the dispatcher all leave it out.
 *
 * **Icons are names, drawn through `lm/icons`** when something serves it. Without it the
 * palette simply has no icons.
 *
 * **Settings may be unavailable.** `kernel.settings` is document-backed (SPEC §6.4), so a
 * replaced kernel or a future contract can throw from it. Letting that escape
 * `activate()` would take this plugin *and every dependent* down (SPEC §6.4's failure
 * rule) — for a rebinding feature. So every settings call is guarded and overrides fall
 * back to empty. The guard is deliberately **not** a latch: a failure is per call, and a
 * store that demoted itself for the session over one error made rebinding impossible
 * with nothing to retry it.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { Kernel, Unsubscribe } from "@kernel";

import {
  parseOverrides,
  resolveBindings,
  serializeOverrides,
  type ResolvedBindings,
} from "./bindings.js";
import { createKeybindingsSection } from "./KeybindingsSection.js";
import {
  eventKeys,
  isApplePlatform,
  isBareChord,
  isTypingTarget,
  normalizeKeys,
  parseChord,
} from "./keys.js";
import { Palette } from "./Palette.js";

import type { Command } from "@protocols/lm/commands.command";
import type { Commands } from "@protocols/lm/commands";
import type { Icons } from "@protocols/lm/icons";
import type { KeybindingDefault } from "@protocols/lm/keybindings.default";
import type { SettingsSection } from "@protocols/lm/settings.section";
import type { ShellOverlay } from "@protocols/lm/shell.overlay";

/** How long a sequence prefix (the `g` of `g d`) stays pending. */
const SEQUENCE_TIMEOUT_MS = 1_500;

/** The settings key holding `command=keys` lines. */
const OVERRIDES_KEY = "keybindings";

/**
 * What {@link deactivate} undoes. A capturing `keydown` listener that outlived its
 * activation would keep swallowing chords for commands that no longer exist — the one
 * genuinely global thing this plugin installs, so it is the one thing tracked here.
 */
const teardown: (() => void)[] = [];

export interface CommandsApi {
  /** Run a command by id. Throws when it is unknown — a typo must not be silent. */
  run(id: string, argument?: unknown): Promise<void>;
  /** Every currently enabled command (`when()` honoured). */
  list(): readonly Command[];
  openPalette(initialQuery?: string): void;
  closePalette(): void;
  /** The effective binding for a command: user override, else the first default. */
  binding(commandId: string): string | undefined;
  /** Conflicting defaults, for the settings section. */
  conflicts(): readonly { readonly keys: string; readonly commands: readonly string[] }[];
  onPaletteToggle(listener: (open: boolean) => void): Unsubscribe;
}

export default function activate(kernel: Kernel): CommandsApi {
  // Both hosts hand their items over in seat order, which is what "first wins" means
  // below; the protocol packages carry the shapes and the duplicate keys.
  const commands = kernel.ports.collect<Command>("commands");
  const keybindings = kernel.ports.collect<KeybindingDefault>("keys");
  const icons = (): Pick<Icons, "Icon"> | undefined =>
    kernel.ports.bound("icons") ? kernel.ports.use<Pick<Icons, "Icon">>("icons") : undefined;

  /** What the palette and keys can run: everything that needs no documents handed to it. */
  const runnable = (): readonly Command[] => api.list().filter((command) => command.takes === undefined);
  const takesArgument = (id: string): boolean =>
    commands.get().some((command) => command.id === id && command.takes !== undefined);

  // ---------------------------------------------------------------------------
  // Settings, guarded (see the module header)
  // ---------------------------------------------------------------------------

  /**
   * Whether the *last* settings call worked — a status, not a latch.
   *
   * It used to stay `false` forever after one failure, which made a single transient
   * error (or one unlucky moment during boot) send the keybindings table into read-only
   * for the rest of the session and refuse every later write, with nothing to retry it.
   * Each call is attempted on its own and the warning is once per session; the flag only
   * decides what the settings section says.
   */
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

  /**
   * A write is attempted whatever the last read did — the two fail for different
   * reasons, and refusing on the strength of an earlier read failure is how a rebinding
   * becomes permanently impossible. A rejection propagates to the caller, which is the
   * settings section; it shows the message (and offline that message is the truth: the
   * settings document cannot be written without the server).
   */
  const writeOverrides = async (next: ReadonlyMap<string, string>): Promise<void> => {
    await kernel.settings.set(OVERRIDES_KEY, [...serializeOverrides(next)]);
    settingsUsable = true;
  };

  // ---------------------------------------------------------------------------
  // Resolved state
  // ---------------------------------------------------------------------------

  let overrides = readOverrides();
  let resolved: ResolvedBindings = resolveBindings(keybindings.get(), overrides);
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

  // ---------------------------------------------------------------------------
  // Palette state
  // ---------------------------------------------------------------------------

  let paletteOpen = false;
  let paletteQuery = "";
  const paletteListeners = new Set<(open: boolean) => void>();

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

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

    // A bare keystroke belongs to whatever the user is typing into. Chords with a real
    // modifier are still delivered, which is what makes Mod+K work inside the editor.
    if (isBareChord(parseChord(chord)) && isTypingTarget(event.target)) {
      clearPending();
      return;
    }

    const candidate = pending === "" ? chord : `${pending} ${chord}`;
    // Off Apple, Mod *is* Ctrl — one key. The event spells it `Mod`, so a binding
    // written with a literal `Ctrl` (chosen so a Mac keeps Ctrl rather than Cmd) is
    // looked up under that spelling too, or it could never fire here.
    const literal = apple ? undefined : candidate.replace(/\bMod\+/g, "Ctrl+");
    const commandId =
      resolved.byKeys.get(candidate) ?? (literal !== undefined ? resolved.byKeys.get(literal) : undefined);
    if (commandId !== undefined && !takesArgument(commandId)) {
      clearPending();
      event.preventDefault();
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

  // ---------------------------------------------------------------------------
  // Offers
  // ---------------------------------------------------------------------------

  // The palette's own commands, so they appear in the palette and can be rebound.
  kernel.ports.offer<Command>("own", [
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
        location.hash = "/settings";
      },
    },
  ]);
  kernel.ports.offer<KeybindingDefault>("own-keys", {
    command: "commands.openPalette",
    keys: "Mod+K",
  });

  /** Re-render on any host/override change. */
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
    const Icon = icons()?.Icon;

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
              location.hash = "/settings";
            }}
            onRun={(command) => {
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

  kernel.ports.offer<ShellOverlay>("palette", {
    id: "commands.palette",
    component: PaletteHost,
  });

  kernel.ports.offer<SettingsSection>("settings", {
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
        // Optimistic: the settings subscription will confirm, but the table must not
        // wait for a sync round trip to show what the user just pressed.
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

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  const api: CommandsApi = {
    run: async (id, argument) => {
      const command = commands.get().find((entry) => entry.id === id);
      if (!command) throw new Error(`unknown command: ${id}`);
      if (command.when && !command.when()) return;
      await command.run(argument);
    },
    list: () => commands.get().filter((command) => !command.when || command.when()),
    openPalette: (initialQuery = "") => {
      paletteQuery = initialQuery;
      paletteOpen = true;
      for (const listener of [...paletteListeners]) listener(true);
    },
    closePalette: () => {
      if (!paletteOpen) return;
      paletteOpen = false;
      for (const listener of [...paletteListeners]) listener(false);
    },
    binding: (commandId) => resolved.byCommand.get(commandId),
    conflicts: () => resolved.conflicts,
    onPaletteToggle: (listener) => {
      paletteListeners.add(listener);
      return () => {
        paletteListeners.delete(listener);
      };
    },
  };

  kernel.ports.serve<Commands>("api", api);
  return api;
}

/**
 * Symmetry with `activate` (SPEC §6.4): activation is reload-only, so this runs only on
 * teardown (`?safe=bare`). It removes the global chord listener — the offers
 * themselves are withdrawn by the kernel, not by this plugin.
 */
export function deactivate(): void {
  while (teardown.length > 0) teardown.pop()?.();
}

/**
 * `commands` — the command registry, the palette, and keybindings in one plugin
 * (SPEC §6.5). They are one plugin because a keybinding without a command is
 * meaningless and a palette is just a list of commands.
 *
 * The rules that matter:
 *
 * - **Per-user keybindings win.** Plugins contribute *suggested defaults*
 *   (`keybindings.default`); the user's configuration — a `kernel.settings` value on
 *   this plugin — overrides them.
 * - **First registration wins on a conflict, and conflicts are listed.** Two plugins
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
 * **The palette renders inside a `navbar.item` component.** `shell-ui` owns the single
 * `kernel.ui.mount` (SPEC §6.4), so a plugin needing a persistent React presence
 * contributes one; a navbar item is the contribution that is always rendered. The
 * overlay itself is a portal, so it is not laid out inside the navbar.
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
  formatKeys,
  isApplePlatform,
  isBareChord,
  isTypingTarget,
  normalizeKeys,
  parseChord,
} from "./keys.js";
import { Palette } from "./Palette.js";
import {
  POINTS,
  commandShape,
  keybindingDefaultShape,
  type Command,
  type KeybindingDefault,
  type NavbarItem,
  type SettingsSection,
} from "../../_shared/points.js";

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
  const commands = kernel.extensions.definePoint<Command>({
    name: POINTS.command,
    shape: commandShape,
    key: (command) => command.id,
    description: "A command: an id, a title, and a function to run.",
  });
  const keybindings = kernel.extensions.definePoint<KeybindingDefault>({
    name: POINTS.keybinding,
    shape: keybindingDefaultShape,
    key: (binding) => `${binding.keys}|${binding.command}`,
    description: "A suggested default keybinding. The user's configuration wins.",
  });

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
    const commandId = resolved.byKeys.get(candidate);
    if (commandId !== undefined) {
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
  // Contributions
  // ---------------------------------------------------------------------------

  // The palette's own command, so it appears in the palette and can be rebound.
  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "commands.openPalette",
    title: "Show all commands",
    category: "Commands",
    run: () => api.openPalette(),
  });
  kernel.extensions.contribute<KeybindingDefault>(POINTS.keybinding, {
    command: "commands.openPalette",
    keys: "Mod+K",
  });
  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "commands.keybindings",
    title: "Edit keybindings",
    category: "Commands",
    run: () => {
      location.hash = "/settings";
    },
  });

  /** Re-render on any registry/override change. */
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

  const PaletteHost = (): ReactElement => {
    const bindings = useBindings();
    const [open, setOpen] = useState(paletteOpen);
    useEffect(() => api.onPaletteToggle(setOpen), []);
    const trigger = bindings.byCommand.get("commands.openPalette");

    return (
      <>
        <button
          type="button"
          className="cmd-trigger"
          onClick={() => api.openPalette()}
          aria-haspopup="dialog"
        >
          Commands
          {trigger && <kbd className="cmd-keys">{formatKeys(trigger, apple)}</kbd>}
        </button>
        {open && (
          <Palette
            commands={api.list()}
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

  kernel.extensions.contribute<NavbarItem>(POINTS.navbarItem, {
    id: "commands.palette",
    label: "Commands",
    side: "end",
    order: 20,
    onSelect: () => api.openPalette(),
    component: PaletteHost,
  });

  kernel.extensions.contribute<SettingsSection>(POINTS.settingsSection, {
    id: "commands.keybindings",
    title: "Keybindings",
    order: 200,
    description: "Rebind any command. Your bindings win over plugin defaults.",
    component: createKeybindingsSection({
      commands: () => api.list(),
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

  return api;
}

/**
 * Symmetry with `activate` (SPEC §6.4): activation is reload-only, so this runs only on
 * teardown (`?safe=bare`). It removes the global chord listener — the contributions
 * themselves are withdrawn by the kernel, not by this plugin.
 */
export function deactivate(): void {
  while (teardown.length > 0) teardown.pop()?.();
}
